"""Question types and marking rules shared by the student APIs, the scheduler and evaluation."""

import json
from collections import defaultdict

import frappe
from frappe.utils import flt, now_datetime

MCQ = "Single Choice (MCQ)"
MSQ = "Multiple Choice (MSQ)"
TRUE_FALSE = "True / False"
FILL_BLANK = "Fill in the Blank"
NUMERIC = "Numeric"
SHORT = "Short Answer"
LONG = "Long Answer"
DRAWING = "Drawing"

OPTION_TYPES = (MCQ, MSQ, TRUE_FALSE)
TEXT_AUTO_TYPES = (FILL_BLANK, NUMERIC)
AUTO_TYPES = OPTION_TYPES + TEXT_AUTO_TYPES
MANUAL_TYPES = (SHORT, LONG, DRAWING)


def normalise_text(value):
	return " ".join(str(value or "").split()).lower()


def accepted_lines(text):
	return [line.strip() for line in str(text or "").splitlines() if line.strip()]


def parse_selected(question_type, answer):
	"""Option-based answers are stored as the option row name, or a JSON list for MSQ."""
	answer = (answer or "").strip()
	if not answer:
		return set()
	if question_type == MSQ:
		try:
			value = json.loads(answer)
		except ValueError:
			value = [answer]
		if not isinstance(value, list):
			value = [value]
		return {str(v) for v in value if v}
	return {answer}


def load_answer_keys(question_names):
	"""One query for the questions and one for their correct options."""
	question_names = list({q for q in question_names if q})
	if not question_names:
		return {}, {}
	questions = {
		q.name: q
		for q in frappe.get_all(
			"Exam Question",
			filters={"name": ("in", question_names)},
			fields=["name", "question_type", "accepted_answers", "numeric_tolerance"],
		)
	}
	correct = defaultdict(set)
	for opt in frappe.get_all(
		"Exam Question Option",
		filters={"parent": ("in", question_names), "parenttype": "Exam Question", "is_correct": 1},
		fields=["name", "parent"],
	):
		correct[opt.parent].add(opt.name)
	return questions, correct


def grade_row(row, question, correct_options):
	"""Mark objective answers and blank answers. Subjective answers are left for the teacher."""
	answer = (row.answer or "").strip()
	question_type = row.question_type
	max_marks = flt(row.max_marks)
	negative = flt(row.negative_marks)

	if question_type in MANUAL_TYPES:
		if not answer:
			row.is_correct = 0
			row.marks_obtained = 0
			row.is_evaluated = 1
		return

	correct = False
	answered = bool(answer)
	if question_type in OPTION_TYPES:
		selected = parse_selected(question_type, answer)
		answered = bool(selected)
		correct = answered and bool(correct_options) and selected == correct_options
	elif question_type == FILL_BLANK:
		correct = answered and normalise_text(answer) in {
			normalise_text(a) for a in accepted_lines(question.accepted_answers if question else "")
		}
	elif question_type == NUMERIC:
		correct = answered and _numeric_match(answer, question)

	row.is_correct = 1 if correct else 0
	row.marks_obtained = max_marks if correct else (-negative if answered else 0)
	row.is_evaluated = 1


def _numeric_match(answer, question):
	if not question:
		return False
	try:
		value = float(str(answer).strip().replace(",", ""))
	except ValueError:
		return False
	tolerance = abs(flt(question.numeric_tolerance))
	for accepted in accepted_lines(question.accepted_answers):
		try:
			if abs(value - float(accepted.replace(",", ""))) <= tolerance + 1e-9:
				return True
		except ValueError:
			continue
	return False


def compute_totals(doc):
	doc.score = flt(sum(flt(r.marks_obtained) for r in doc.answers if r.is_evaluated), 2)
	doc.pending_evaluation = sum(1 for r in doc.answers if not r.is_evaluated)
	if doc.status != "In Progress":
		doc.status = "Submitted" if doc.pending_evaluation else "Evaluated"


def finalize_submission(doc, mode):
	"""Close an attempt: mark objective answers, set status, save. Answers must already be saved on the rows."""
	questions, correct = load_answer_keys([r.question for r in doc.answers])
	for row in doc.answers:
		if row.question_type in AUTO_TYPES and row.question not in questions:
			# Question deleted from the bank after the exam started.
			row.is_correct = 0
			row.marks_obtained = 0
			row.is_evaluated = 1
			continue
		grade_row(row, questions.get(row.question), correct.get(row.question, set()))

	doc.status = "Submitted"
	doc.submit_mode = mode
	doc.submitted_at = now_datetime()
	compute_totals(doc)
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	return doc
