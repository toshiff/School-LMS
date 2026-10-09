import json
import random

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, get_datetime, now_datetime, time_diff_in_seconds

EXAM_MINUTES = 10
QUESTION_COUNT = 5
GRACE_SECONDS = 30  # allowance for slow networks after the deadline
VALID_OPTIONS = ("A", "B", "C", "D")


def _require_login():
	if frappe.session.user == "Guest":
		frappe.throw(_("Please log in to take the exam."), frappe.PermissionError)
	return frappe.session.user


@frappe.whitelist()
def get_classes():
	"""Classes that have at least one question (uses the index on class_name)."""
	_require_login()
	return frappe.db.sql_list(
		"select distinct class_name from `tabExam Question` order by class_name"
	)


@frappe.whitelist(methods=["POST"])
def start_exam(class_name):
	"""Start a new attempt, or resume the student's running one for this class.

	The deadline is fixed on the server at start; the browser only shows a countdown.
	"""
	user = _require_login()
	now = now_datetime()

	running = frappe.db.get_value(
		"Exam Submission",
		{"student": user, "class_name": class_name, "status": "In Progress"},
		["name", "deadline"],
		as_dict=True,
	)
	if running:
		deadline = get_datetime(running.deadline)
		if add_to_date(deadline, seconds=GRACE_SECONDS) > now:
			return _paper(running.name, deadline, now)
		_close(running.name, now)

	names = frappe.get_all(
		"Exam Question", filters={"class_name": class_name}, pluck="name", limit_page_length=0
	)
	if len(names) < QUESTION_COUNT:
		frappe.throw(
			_("Class {0} needs at least {1} questions; it has {2}.").format(
				class_name, QUESTION_COUNT, len(names)
			)
		)

	picked = random.sample(names, QUESTION_COUNT)
	qs = {
		q.name: q
		for q in frappe.get_all(
			"Exam Question",
			filters={"name": ("in", picked)},
			fields=["name", "question", "correct_option", "marks"],
		)
	}

	deadline = add_to_date(now, minutes=EXAM_MINUTES)
	doc = frappe.get_doc(
		{
			"doctype": "Exam Submission",
			"student": user,
			"class_name": class_name,
			"status": "In Progress",
			"started_at": now,
			"deadline": deadline,
			"total_marks": sum((qs[n].marks or 1) for n in picked),
			"answers": [
				{
					"question": n,
					"question_text": qs[n].question,
					"correct_option": qs[n].correct_option,
					"max_marks": qs[n].marks or 1,
				}
				for n in picked
			],
		}
	)
	doc.insert(ignore_permissions=True)
	return _paper(doc.name, deadline, now)


def _paper(submission, deadline, now):
	"""Questions for an attempt, in its stored order. Never includes correct answers."""
	order = frappe.get_all(
		"Exam Submission Answer",
		filters={"parent": submission, "parenttype": "Exam Submission"},
		order_by="idx asc",
		pluck="question",
	)
	rows = frappe.get_all(
		"Exam Question",
		filters={"name": ("in", order)},
		fields=["name", "question", "option_a", "option_b", "option_c", "option_d", "marks"],
	)
	by_name = {r.name: r for r in rows}

	questions = []
	for qn in order:
		r = by_name.get(qn)
		if not r:
			continue
		questions.append(
			{
				"name": r.name,
				"question": r.question,
				"marks": r.marks or 1,
				"options": {"A": r.option_a, "B": r.option_b, "C": r.option_c, "D": r.option_d},
			}
		)

	return {
		"submission": submission,
		"questions": questions,
		"remaining_seconds": max(0, cint(time_diff_in_seconds(deadline, now))),
	}


@frappe.whitelist(methods=["POST"])
def submit_exam(submission, answers=None):
	"""Store the student's answers against each question and score them."""
	user = _require_login()

	head = frappe.db.get_value(
		"Exam Submission",
		submission,
		["student", "status", "deadline"],
		as_dict=True,
		for_update=True,  # blocks a double submit from two tabs
	)
	if not head or head.student != user:
		frappe.throw(_("Not permitted"), frappe.PermissionError)
	if head.status != "In Progress":
		frappe.throw(_("This exam has already been submitted."))

	now = now_datetime()
	if now > add_to_date(get_datetime(head.deadline), seconds=GRACE_SECONDS):
		_close(submission, now)
		return {"status": "Auto Submitted", "message": _("Time was over; answers were not accepted.")}

	if isinstance(answers, str):
		answers = json.loads(answers or "{}")
	if not isinstance(answers, dict):
		answers = {}

	doc = frappe.get_doc("Exam Submission", submission)
	score = 0
	for row in doc.answers:
		selected = str(answers.get(row.question) or "").strip().upper()
		if selected not in VALID_OPTIONS:
			selected = ""
		row.selected_option = selected
		row.is_correct = 1 if selected and selected == row.correct_option else 0
		row.marks_obtained = row.max_marks if row.is_correct else 0
		score += row.marks_obtained

	doc.score = score
	doc.status = "Submitted"
	doc.submitted_at = now
	doc.save(ignore_permissions=True)

	return {"status": doc.status, "score": score, "total_marks": doc.total_marks}


def _close(submission, now):
	frappe.db.set_value(
		"Exam Submission",
		submission,
		{"status": "Auto Submitted", "submitted_at": now, "score": 0},
		update_modified=True,
	)


def auto_close_expired():
	"""Scheduler: close attempts that ran out of time without a submit."""
	now = now_datetime()
	cutoff = add_to_date(now, seconds=-GRACE_SECONDS)
	frappe.db.sql(
		"""
		update `tabExam Submission`
		set status = 'Auto Submitted', submitted_at = %(now)s, score = 0, modified = %(now)s
		where status = 'In Progress' and deadline < %(cutoff)s
		""",
		{"now": now, "cutoff": cutoff},
	)
	frappe.db.commit()
