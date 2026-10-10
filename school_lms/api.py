"""Student-facing exam APIs. The logged-in user is matched to a Student by email_address, and the
current class/section/roll number come from the Student's academic_details table (Current Class CT)."""

import base64
import json
import random
from urllib.parse import quote

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, flt, get_datetime, now_datetime, time_diff_in_seconds

from school_lms.grading import DRAWING, MSQ, OPTION_TYPES, finalize_submission

GRACE_SECONDS = 30  # accepted after the deadline, for slow networks
LIST_PAST_DAYS = 7  # finished exams stay on the student's list this long
MAX_TEXT_ANSWER = 50000  # characters
MAX_DRAWING_BYTES = 3 * 1024 * 1024
FINALIZE_BATCH = 200

VIOLATION_REASONS = {
	"tab": "Switched tab or minimised the browser",
	"blur": "Left the exam window",
	"fullscreen": "Exited full screen",
	"route": "Navigated away from the exam page",
	"resume": "Reopened the exam after leaving the page",
}


# ------------------------------------------------------------------ student context


def _require_login():
	if frappe.session.user == "Guest":
		frappe.throw(_("Please log in to take the exam."), frappe.PermissionError)
	return frappe.session.user


def get_student_context(user):
	"""Student linked to the login email + their current row in academic_details."""
	student = frappe.db.get_value(
		"Student",
		{"email_address": user, "enabled": 1},
		["name", "student_name"],
		as_dict=True,
	)
	if not student:
		return None

	rows = frappe.get_all(
		"Current Class CT",
		filters={"parent": student.name, "parenttype": "Student", "parentfield": "academic_details"},
		fields=["class", "section", "roll_number", "academic_year", "idx"],
		order_by="idx desc",
	)
	current = None
	if rows:
		years = list({r.academic_year for r in rows if r.academic_year})
		enabled_years = set(
			frappe.get_all("Academic Year", filters={"name": ("in", years), "enabled": 1}, pluck="name")
		) if years else set()
		current = next((r for r in rows if r.academic_year in enabled_years), rows[0])

	return frappe._dict(
		student=student.name,
		student_name=student.student_name,
		**{
			"class": current.get("class") if current else None,
			"section": current.section if current else None,
			"roll_number": current.roll_number if current else None,
			"academic_year": current.academic_year if current else None,
		},
	)


def _require_student():
	user = _require_login()
	ctx = get_student_context(user)
	if not ctx:
		frappe.throw(_("No active student record is linked to your login email {0}.").format(frappe.bold(user)))
	if not ctx.get("class") or not ctx.academic_year:
		frappe.throw(_("Your current class is not set in your Academic Details. Please contact the school office."))
	return user, ctx


def _exam_is_for_student(exam, ctx):
	return (
		exam.docstatus == 1
		and exam.get("class") == ctx.get("class")
		and exam.academic_year == ctx.academic_year
		and (not exam.section or exam.section == ctx.section)
	)


def _submission_name(online_exam, student):
	# One attempt per student per exam, enforced by the primary key.
	return f"{online_exam}-{student}"


# ------------------------------------------------------------------ exam list


@frappe.whitelist()
def get_my_exams():
	user = _require_login()
	ctx = get_student_context(user)
	if not ctx:
		return {"student": None, "message": _("No active student record is linked to your login email {0}.").format(user)}
	if not ctx.get("class") or not ctx.academic_year:
		return {"student": ctx, "exams": [], "message": _("Your current class is not set in your Academic Details.")}

	now = now_datetime()
	exams = frappe.db.sql(
		"""
		select name, exam_title, exam_type, subject, section, exam_date, start_datetime, end_datetime,
			duration_minutes, total_marks, passing_marks, publish_result, max_violations
		from `tabOnline Exam`
		where docstatus = 1
			and `class` = %(class)s
			and academic_year = %(ay)s
			and (ifnull(section, '') = '' or section = %(section)s)
			and end_datetime >= %(since)s
		order by start_datetime
		limit 100
		""",
		{
			"class": ctx.get("class"),
			"ay": ctx.academic_year,
			"section": ctx.section or "",
			"since": add_to_date(now, days=-LIST_PAST_DAYS),
		},
		as_dict=True,
	)

	names = [e.name for e in exams]
	subs = {}
	if names:
		for s in frappe.get_all(
			"Exam Submission",
			filters={"student": ctx.student, "online_exam": ("in", names)},
			fields=["online_exam", "status", "deadline", "score", "total_marks", "submitted_at"],
		):
			subs[s.online_exam] = s

	subject_names = _subject_names([e.subject for e in exams])

	out = []
	for e in exams:
		s = subs.get(e.name)
		item = {
			"name": e.name,
			"exam_title": e.exam_title,
			"exam_type": e.exam_type,
			"subject": e.subject,
			"subject_name": subject_names.get(e.subject, e.subject),
			"start_datetime": str(e.start_datetime),
			"end_datetime": str(e.end_datetime),
			"duration_minutes": e.duration_minutes,
			"total_marks": e.total_marks,
			"seconds_to_start": max(0, cint(time_diff_in_seconds(e.start_datetime, now))),
			"seconds_to_end": max(0, cint(time_diff_in_seconds(e.end_datetime, now))),
		}
		if s and s.status == "In Progress" and now <= add_to_date(get_datetime(s.deadline), seconds=GRACE_SECONDS):
			item["state"] = "in_progress"
			item["seconds_to_end"] = max(0, cint(time_diff_in_seconds(s.deadline, now)))
		elif s and s.status != "In Progress":
			item["state"] = "submitted"
			item["submitted_at"] = str(s.submitted_at or "")
			if e.publish_result and s.status == "Evaluated":
				item["score"] = s.score
				item["result_total"] = s.total_marks
				if e.passing_marks:
					item["passed"] = flt(s.score) >= flt(e.passing_marks)
		elif s:
			item["state"] = "closing"  # time over; the scheduler will close it
		elif now < e.start_datetime:
			item["state"] = "upcoming"
		elif now < e.end_datetime:
			item["state"] = "live"
		else:
			item["state"] = "missed"
		if item["state"] in ("live", "in_progress"):
			item["max_violations"] = cint(e.max_violations)
			item["question_count"] = frappe.db.count(
				"Online Exam Question", {"parent": e.name, "parenttype": "Online Exam"}
			)
			item["instructions"] = frappe.db.get_value("Online Exam", e.name, "instructions") or ""
		out.append(item)

	return {"student": ctx, "exams": out}


def _subject_names(subjects):
	subjects = list({s for s in subjects if s})
	if not subjects:
		return {}
	return {
		s.name: s.subject_name or s.name
		for s in frappe.get_all("Subject", filters={"name": ("in", subjects)}, fields=["name", "subject_name"])
	}


# ------------------------------------------------------------------ start / resume


@frappe.whitelist(methods=["POST"])
def start_exam(online_exam):
	user, ctx = _require_student()
	exam = frappe.db.get_value(
		"Online Exam",
		online_exam,
		["name", "docstatus", "class", "section", "subject", "academic_year", "exam_title",
		 "start_datetime", "end_datetime", "shuffle_questions", "max_violations", "total_marks"],
		as_dict=True,
	)
	if not exam or not _exam_is_for_student(exam, ctx):
		frappe.throw(_("This exam is not available for you."), frappe.PermissionError)

	name = _submission_name(exam.name, ctx.student)
	now = now_datetime()

	if frappe.db.exists("Exam Submission", name):
		return _resume(name, user, now)

	if now < exam.start_datetime:
		frappe.throw(_("This exam starts at {0}.").format(frappe.utils.format_datetime(exam.start_datetime)))
	if now >= exam.end_datetime:
		frappe.throw(_("This exam is over."))

	rows = frappe.get_all(
		"Online Exam Question",
		filters={"parent": exam.name, "parenttype": "Online Exam"},
		fields=["question", "question_type", "marks", "negative_marks"],
		order_by="idx asc",
	)
	if not rows:
		frappe.throw(_("This exam has no questions."))
	if exam.shuffle_questions:
		random.shuffle(rows)

	doc = frappe.get_doc(
		{
			"doctype": "Exam Submission",
			"online_exam": exam.name,
			"exam_title": exam.exam_title,
			"subject": exam.subject,
			"student": ctx.student,
			"student_name": ctx.student_name,
			"roll_number": ctx.roll_number,
			"class": ctx.get("class"),
			"section": ctx.section,
			"academic_year": ctx.academic_year,
			"user": user,
			"status": "In Progress",
			"started_at": now,
			"deadline": exam.end_datetime,  # joining late = less time
			"total_marks": exam.total_marks,
			"violation_count": 0,
			"answers": [
				{
					"question": r.question,
					"question_type": r.question_type,
					"max_marks": r.marks,
					"negative_marks": r.negative_marks,
				}
				for r in rows
			],
		}
	)
	try:
		doc.insert(ignore_permissions=True, set_name=name)
	except frappe.DuplicateEntryError:
		# Double click / two tabs: the other request created it first.
		frappe.clear_messages()
		return _resume(name, user, now)

	return _paper(name, exam, ctx, doc.deadline, now, 0)


def _resume(name, user, now):
	head = frappe.db.get_value(
		"Exam Submission", name, ["user", "status", "deadline", "online_exam"], as_dict=True
	)
	if head.user != user:
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	if head.status != "In Progress":
		frappe.throw(_("You have already submitted this exam."))
	if now > add_to_date(get_datetime(head.deadline), seconds=GRACE_SECONDS):
		finalize_submission(frappe.get_doc("Exam Submission", name), "Time Up")
		frappe.throw(_("Time is over. Your saved answers have been submitted."))

	count = _add_violation(name, user, "resume")
	exam = frappe.db.get_value(
		"Online Exam", head.online_exam, ["name", "exam_title", "subject", "max_violations", "total_marks"], as_dict=True
	)
	ctx = get_student_context(user)
	return _paper(name, exam, ctx, get_datetime(head.deadline), now, count)


def _paper(submission, exam, ctx, deadline, now, violation_count):
	"""Questions in this attempt's order, with saved answers. Never includes correct answers."""
	rows = frappe.get_all(
		"Exam Submission Answer",
		filters={"parent": submission, "parenttype": "Exam Submission"},
		fields=["question", "question_type", "max_marks", "negative_marks", "answer"],
		order_by="idx asc",
	)
	qnames = [r.question for r in rows]
	bank = {
		q.name: q
		for q in frappe.get_all(
			"Exam Question",
			filters={"name": ("in", qnames)},
			fields=["name", "question", "question_image", "drawing_background", "answer_word_limit"],
		)
	}
	options = {}
	for o in frappe.get_all(
		"Exam Question Option",
		filters={"parent": ("in", qnames), "parenttype": "Exam Question"},
		fields=["name", "parent", "option_text", "option_image"],
		order_by="idx asc",
	):
		options.setdefault(o.parent, []).append(o)

	shuffle_options = cint(frappe.db.get_value("Online Exam", exam.name, "shuffle_options"))

	questions = []
	for r in rows:
		q = bank.get(r.question)
		if not q:
			continue
		item = {
			"name": q.name,
			"type": r.question_type,
			"marks": r.max_marks,
			"negative_marks": r.negative_marks,
			"html": q.question,
			"image": _file_for_student(submission, q.question_image),
		}
		if r.question_type in OPTION_TYPES:
			opts = [
				{"id": o.name, "text": o.option_text or "", "image": _file_for_student(submission, o.option_image)}
				for o in options.get(q.name, [])
			]
			if shuffle_options and r.question_type != "True / False":
				# Same order every time this student reloads.
				random.Random(f"{submission}:{q.name}").shuffle(opts)
			item["options"] = opts
		if r.question_type in ("Short Answer", "Long Answer"):
			item["word_limit"] = cint(q.answer_word_limit)
		if r.question_type == DRAWING:
			item["background"] = _file_for_student(submission, q.drawing_background)

		# saved answer
		if r.question_type == DRAWING:
			item["answer"] = _file_for_student(submission, r.answer)
		elif r.question_type == MSQ:
			try:
				item["answer"] = json.loads(r.answer) if r.answer else []
			except ValueError:
				item["answer"] = []
		else:
			item["answer"] = r.answer or ""
		questions.append(item)

	return {
		"submission": submission,
		"exam": {
			"name": exam.name,
			"title": exam.exam_title,
			"subject": exam.subject,
			"subject_name": _subject_names([exam.subject]).get(exam.subject, exam.subject),
			"total_marks": exam.total_marks,
		},
		"student": {
			"student_name": ctx.student_name if ctx else "",
			"roll_number": ctx.roll_number if ctx else "",
			"class": ctx.get("class") if ctx else "",
			"section": ctx.section if ctx else "",
		},
		"questions": questions,
		"remaining_seconds": max(0, cint(time_diff_in_seconds(deadline, now))),
		"violation_count": cint(violation_count),
		"max_violations": cint(exam.max_violations),
	}


def _file_for_student(submission, url):
	if not url:
		return None
	if url.startswith("/private/"):
		# Students have no access to the question bank, so private images go through question_file.
		return "/api/method/school_lms.api.question_file?submission={0}&file_url={1}".format(
			quote(submission), quote(url)
		)
	return url


@frappe.whitelist()
def question_file(submission, file_url):
	"""Serve a private image that belongs to one of the questions (or drawings) of the student's own attempt."""
	user = _require_login()
	if frappe.db.get_value("Exam Submission", submission, "user") != user:
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	rows = frappe.get_all(
		"Exam Submission Answer",
		filters={"parent": submission, "parenttype": "Exam Submission"},
		fields=["question", "question_type", "answer"],
	)
	qnames = [r.question for r in rows]
	allowed = {r.answer for r in rows if r.question_type == DRAWING and r.answer}
	for q in frappe.get_all(
		"Exam Question", filters={"name": ("in", qnames)}, fields=["question_image", "drawing_background"]
	):
		allowed.update(u for u in (q.question_image, q.drawing_background) if u)
	allowed.update(
		frappe.get_all(
			"Exam Question Option",
			filters={"parent": ("in", qnames), "parenttype": "Exam Question", "option_image": ("is", "set")},
			pluck="option_image",
		)
	)
	if file_url not in allowed:
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	file_name = frappe.db.get_value("File", {"file_url": file_url}, "name")
	if not file_name:
		frappe.throw(_("File not found"), frappe.DoesNotExistError)
	file_doc = frappe.get_doc("File", file_name)
	frappe.local.response.filename = file_doc.file_name
	frappe.local.response.filecontent = file_doc.get_content()
	frappe.local.response.type = "download"
	frappe.local.response.display_content_as = "inline"


# ------------------------------------------------------------------ saving answers


def _own_open_attempt(submission, user, for_update=False):
	head = frappe.db.get_value(
		"Exam Submission",
		submission,
		["user", "status", "deadline", "online_exam", "violation_count"],
		as_dict=True,
		for_update=for_update,
	)
	if not head or head.user != user:
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	head.is_open = head.status == "In Progress" and now_datetime() <= add_to_date(
		get_datetime(head.deadline), seconds=GRACE_SECONDS
	)
	return head


def _write_answers(submission, answers):
	"""Update only the rows whose answer changed: one small UPDATE per changed question."""
	if isinstance(answers, str):
		answers = json.loads(answers or "{}")
	if not isinstance(answers, dict) or not answers:
		return 0

	rows = frappe.get_all(
		"Exam Submission Answer",
		filters={"parent": submission, "parenttype": "Exam Submission"},
		fields=["name", "question", "question_type", "answer"],
	)
	changed = 0
	for r in rows:
		if r.question not in answers or r.question_type == DRAWING:
			continue
		value = answers[r.question]
		if isinstance(value, list):
			value = json.dumps([str(v) for v in value][:50]) if value else ""
		else:
			value = str(value if value is not None else "")[:MAX_TEXT_ANSWER]
		if value != (r.answer or ""):
			frappe.db.set_value("Exam Submission Answer", r.name, "answer", value, update_modified=False)
			changed += 1
	return changed


@frappe.whitelist(methods=["POST"])
def save_answers(submission, answers):
	"""Autosave from the exam screen."""
	user = _require_login()
	head = _own_open_attempt(submission, user)
	if not head.is_open:
		return {"closed": True}
	return {"saved": _write_answers(submission, answers)}


@frappe.whitelist(methods=["POST"])
def save_drawing(submission, question, image):
	"""Store a drawing answer as a private PNG attached to the submission; replaces the previous one."""
	user = _require_login()
	head = _own_open_attempt(submission, user)
	if not head.is_open:
		return {"closed": True}

	row = frappe.db.get_value(
		"Exam Submission Answer",
		{"parent": submission, "parenttype": "Exam Submission", "question": question},
		["name", "question_type", "answer"],
		as_dict=True,
	)
	if not row or row.question_type != DRAWING:
		frappe.throw(_("Invalid question"))

	if not image:
		# Student cleared the drawing.
		frappe.db.set_value("Exam Submission Answer", row.name, "answer", "", update_modified=False)
		_delete_drawing_file(submission, row.answer)
		return {"saved": 1}

	prefix = "data:image/png;base64,"
	if not image.startswith(prefix):
		frappe.throw(_("Invalid drawing"))
	if len(image) > MAX_DRAWING_BYTES * 4 / 3 + len(prefix):
		frappe.throw(_("Drawing is too large"))
	content = base64.b64decode(image[len(prefix):])

	file_doc = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": f"{submission}-{question}.png",
			"attached_to_doctype": "Exam Submission",
			"attached_to_name": submission,
			"is_private": 1,
			"content": content,
		}
	)
	file_doc.flags.ignore_permissions = True
	file_doc.save(ignore_permissions=True)
	frappe.db.set_value("Exam Submission Answer", row.name, "answer", file_doc.file_url, update_modified=False)

	# Identical content reuses the same URL, so match the old record by URL but never the new one.
	_delete_drawing_file(submission, row.answer, keep=file_doc.name)

	return {"saved": 1}


def _delete_drawing_file(submission, file_url, keep=None):
	"""Remove the previous File record of a drawing. Frappe keeps the file on disk if anything else shares it."""
	if not file_url:
		return
	filters = {"file_url": file_url, "attached_to_doctype": "Exam Submission", "attached_to_name": submission}
	if keep:
		filters["name"] = ("!=", keep)
	for old in frappe.get_all("File", filters=filters, pluck="name"):
		frappe.delete_doc("File", old, ignore_permissions=True, force=True)


@frappe.whitelist(methods=["POST"])
def submit_exam(submission, answers=None, mode=None):
	user = _require_login()
	head = _own_open_attempt(submission, user, for_update=True)  # row lock: no double submit
	if head.status != "In Progress":
		frappe.throw(_("This exam has already been submitted."))

	if head.is_open:
		_write_answers(submission, answers)
		max_violations = cint(frappe.db.get_value("Online Exam", head.online_exam, "max_violations"))
		if mode == "Proctoring" and not (max_violations and cint(head.violation_count) >= max_violations):
			mode = "Student"
		mode = mode if mode in ("Student", "Time Up", "Proctoring") else "Student"
	else:
		mode = "Time Up"  # late request: keep what was autosaved, ignore the rest

	doc = finalize_submission(frappe.get_doc("Exam Submission", submission), mode)
	return _result_for_student(doc)


def _result_for_student(doc):
	exam = frappe.db.get_value("Online Exam", doc.online_exam, ["publish_result", "passing_marks"], as_dict=True)
	out = {"status": doc.status, "submit_mode": doc.submit_mode}
	if exam and exam.publish_result and doc.status == "Evaluated":
		out.update(score=doc.score, total_marks=doc.total_marks)
		if exam.passing_marks:
			out["passed"] = flt(doc.score) >= flt(exam.passing_marks)
	return out


# ------------------------------------------------------------------ proctoring


@frappe.whitelist(methods=["POST"])
def log_violation(submission, reason=None):
	user = _require_login()
	count = _add_violation(submission, user, reason)
	max_violations = cint(
		frappe.db.get_value(
			"Online Exam", frappe.db.get_value("Exam Submission", submission, "online_exam"), "max_violations"
		)
	)
	return {"count": count, "max": max_violations}


def _add_violation(submission, user, reason):
	text = VIOLATION_REASONS.get(reason, "Left the exam")
	entry = "{0}  {1}\n".format(now_datetime().strftime("%Y-%m-%d %H:%M:%S"), text)
	frappe.db.sql(
		"""
		update `tabExam Submission`
		set violation_count = ifnull(violation_count, 0) + 1,
			violation_log = concat(ifnull(violation_log, ''), %(entry)s)
		where name = %(name)s and user = %(user)s and status = 'In Progress'
		""",
		{"entry": entry, "name": submission, "user": user},
	)
	count = frappe.db.get_value("Exam Submission", {"name": submission, "user": user}, "violation_count")
	if count is None:
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	return cint(count)


# ------------------------------------------------------------------ scheduler


def finalize_expired_attempts():
	"""Every few minutes: submit attempts whose time ran out, using their autosaved answers."""
	cutoff = add_to_date(now_datetime(), seconds=-GRACE_SECONDS)
	names = frappe.get_all(
		"Exam Submission",
		filters={"status": "In Progress", "deadline": ("<", cutoff)},
		pluck="name",
		limit_page_length=FINALIZE_BATCH,
	)
	for name in names:
		try:
			doc = frappe.get_doc("Exam Submission", name, for_update=True)
			if doc.status == "In Progress":
				finalize_submission(doc, "Time Up")
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(title=f"Online exam auto-submit failed: {name}")
