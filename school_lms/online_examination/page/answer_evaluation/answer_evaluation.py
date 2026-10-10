import json

import frappe
from frappe import _
from frappe.utils import cint, flt

from school_lms.grading import MANUAL_TYPES, OPTION_TYPES, compute_totals, parse_selected

EVALUATOR_ROLES = ("Teacher", "Examination Admin", "Academic Admin", "System Manager")


def _require_evaluator():
	if not set(frappe.get_roles()) & set(EVALUATOR_ROLES):
		frappe.throw(_("Only teachers and exam admins can evaluate answers."), frappe.PermissionError)


@frappe.whitelist()
def get_submissions(exam_paper):
	_require_evaluator()
	exam = frappe.db.get_value(
		"Exam Paper",
		exam_paper,
		["name", "exam_title", "class", "section", "subject", "total_marks", "passing_marks", "publish_result", "docstatus"],
		as_dict=True,
	)
	if not exam:
		frappe.throw(_("Exam Paper {0} not found").format(exam_paper))
	exam.subject_name = frappe.db.get_value("Subject", exam.subject, "subject_name") or exam.subject

	rows = frappe.get_all(
		"Exam Submission",
		filters={"exam_paper": exam_paper},
		fields=["name", "student", "student_name", "roll_number", "section", "status", "submit_mode",
		        "score", "total_marks", "pending_evaluation", "violation_count", "submitted_at"],
		limit_page_length=5000,
	)

	def roll_key(r):
		roll = (r.roll_number or "").strip()
		return (0, int(roll), "") if roll.isdigit() else (1, 0, roll or r.student_name or "")

	rows.sort(key=roll_key)
	counts = {
		"total": len(rows),
		"in_progress": sum(1 for r in rows if r.status == "In Progress"),
		"pending": sum(1 for r in rows if r.status == "Submitted"),
		"evaluated": sum(1 for r in rows if r.status == "Evaluated"),
	}
	return {"exam": exam, "submissions": rows, "counts": counts}


@frappe.whitelist()
def get_submission(submission):
	_require_evaluator()
	doc = frappe.get_doc("Exam Submission", submission)
	qnames = [r.question for r in doc.answers]

	bank = {
		q.name: q
		for q in frappe.get_all(
			"Exam Question",
			filters={"name": ("in", qnames)},
			fields=["name", "question", "question_image", "drawing_background", "model_answer",
			        "accepted_answers", "answer_word_limit"],
		)
	}
	options = {}
	for o in frappe.get_all(
		"Exam Question Option",
		filters={"parent": ("in", qnames), "parenttype": "Exam Question"},
		fields=["name", "parent", "option_text", "option_image", "is_correct"],
		order_by="idx asc",
	):
		options.setdefault(o.parent, []).append(o)

	answers = []
	for r in doc.answers:
		q = bank.get(r.question) or frappe._dict()
		item = {
			"row": r.name,
			"idx": r.idx,
			"question": r.question,
			"type": r.question_type,
			"html": q.question or _("(question deleted from the bank)"),
			"image": q.question_image,
			"model_answer": q.model_answer,
			"max_marks": r.max_marks,
			"negative_marks": r.negative_marks,
			"marks_obtained": r.marks_obtained,
			"is_evaluated": r.is_evaluated,
			"is_correct": r.is_correct,
			"remarks": r.remarks,
			"manual": r.question_type in MANUAL_TYPES,
			"answer": r.answer or "",
		}
		if r.question_type in OPTION_TYPES:
			selected = parse_selected(r.question_type, r.answer)
			item["options"] = [
				{"text": o.option_text, "image": o.option_image, "is_correct": o.is_correct, "selected": o.name in selected}
				for o in options.get(r.question, [])
			]
		elif r.question_type in ("Fill in the Blank", "Numeric"):
			item["accepted_answers"] = q.accepted_answers
		elif r.question_type in ("Short Answer", "Long Answer"):
			item["word_limit"] = cint(q.answer_word_limit)
		answers.append(item)

	head = {
		k: doc.get(k)
		for k in ("name", "exam_paper", "exam_title", "student", "student_name", "roll_number", "class", "section",
		          "status", "submit_mode", "started_at", "submitted_at", "score", "total_marks",
		          "pending_evaluation", "violation_count", "violation_log")
	}
	return {"head": head, "answers": answers}


@frappe.whitelist(methods=["POST"])
def save_marks(submission, marks):
	"""marks = {row_name: {"marks": 3, "remarks": "..."}}. Manual answers: 0..max. Objective overrides: -negative..max."""
	_require_evaluator()
	if isinstance(marks, str):
		marks = json.loads(marks or "{}")

	doc = frappe.get_doc("Exam Submission", submission, for_update=True)
	if doc.status == "In Progress":
		frappe.throw(_("The student is still writing this exam."))

	for row in doc.answers:
		entry = marks.get(row.name)
		if entry is None:
			continue
		value = entry.get("marks")
		if value in (None, ""):
			continue
		value = flt(value, 2)
		low = 0 if row.question_type in MANUAL_TYPES else -flt(row.negative_marks)
		if value < low or value > flt(row.max_marks):
			frappe.throw(
				_("Question {0}: marks must be between {1} and {2}.").format(row.idx, low, flt(row.max_marks))
			)
		row.marks_obtained = value
		row.is_evaluated = 1
		row.is_correct = 1 if value >= flt(row.max_marks) else 0
		row.remarks = (entry.get("remarks") or "")[:1000]

	compute_totals(doc)
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	return {"status": doc.status, "score": doc.score, "pending_evaluation": doc.pending_evaluation}
