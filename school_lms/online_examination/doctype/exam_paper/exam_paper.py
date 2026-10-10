import json
import random
from datetime import datetime, timedelta

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt, get_time, getdate, now_datetime

MAX_DURATION_MINUTES = 24 * 60


class ExamPaper(Document):
	def validate(self):
		self.validate_subject_class()
		self.set_schedule()
		self.validate_questions()

	def before_submit(self):
		if not self.questions:
			frappe.throw(_("Add at least one question before submitting."))
		if self.end_datetime and self.end_datetime <= now_datetime():
			frappe.throw(_("This exam's time is already over. Change the date or time before submitting."))

	def before_update_after_submit(self):
		self.set_schedule()
		if self.has_value_changed("end_datetime"):
			# Students already writing the exam follow the new end time.
			frappe.db.sql(
				"""
				update `tabExam Submission`
				set deadline = %(end)s
				where exam_paper = %(exam)s and status = 'In Progress'
				""",
				{"end": self.end_datetime, "exam": self.name},
			)

	def validate_subject_class(self):
		subject_class = frappe.db.get_value("Subject", self.subject, "class")
		if subject_class and subject_class != self.get("class"):
			frappe.throw(
				_("Subject {0} belongs to class {1}, not {2}.").format(
					frappe.bold(self.subject), frappe.bold(subject_class), frappe.bold(self.get("class"))
				)
			)

	def set_schedule(self):
		duration = cint(self.duration_minutes)
		if duration <= 0 or duration > MAX_DURATION_MINUTES:
			frappe.throw(_("Duration must be between 1 and {0} minutes.").format(MAX_DURATION_MINUTES))
		start = datetime.combine(getdate(self.exam_date), get_time(self.start_time))
		self.start_datetime = start
		self.end_datetime = start + timedelta(minutes=duration)

	def validate_questions(self):
		names = [r.question for r in self.questions if r.question]
		if len(names) != len(set(names)):
			frappe.throw(_("The same question has been added more than once."))

		if names:
			bank = {
				q.name: q
				for q in frappe.get_all(
					"Exam Question",
					filters={"name": ("in", names)},
					fields=["name", "class", "subject", "enabled"],
				)
			}
			for row in self.questions:
				q = bank.get(row.question)
				if not q:
					continue
				if not q.enabled:
					frappe.throw(_("Row {0}: question {1} is disabled.").format(row.idx, row.question))
				if q.get("class") != self.get("class") or q.subject != self.subject:
					frappe.throw(
						_("Row {0}: question {1} belongs to {2} / {3}, not this exam's class and subject.").format(
							row.idx, row.question, q.get("class"), q.subject
						)
					)

		for row in self.questions:
			if flt(row.marks) <= 0:
				frappe.throw(_("Row {0}: marks must be greater than 0.").format(row.idx))
			if flt(row.negative_marks) < 0:
				row.negative_marks = 0

		self.total_marks = flt(sum(flt(r.marks) for r in self.questions), 2)
		if flt(self.passing_marks) > self.total_marks:
			frappe.throw(_("Passing Marks cannot be more than Total Marks ({0}).").format(self.total_marks))


def on_doctype_update():
	# Student exam list: exams of a class/year that haven't ended yet.
	frappe.db.add_index("Exam Paper", ["class", "academic_year", "end_datetime"])


@frappe.whitelist()
def pick_questions(class_name, subject, count=10, topic=None, question_type=None, difficulty=None, exclude=None):
	"""Random questions from the bank for the 'Add Questions from Bank' button."""
	frappe.has_permission("Exam Paper", "write", throw=True)

	count = max(1, min(cint(count), 200))
	if isinstance(exclude, str):
		exclude = json.loads(exclude or "[]")

	filters = {"class": class_name, "subject": subject, "enabled": 1}
	if topic:
		filters["topic"] = topic
	if question_type:
		filters["question_type"] = question_type
	if difficulty:
		filters["difficulty"] = difficulty
	if exclude:
		filters["name"] = ("not in", exclude)

	# Question banks per class+subject are small (hundreds), and the filter uses the indexed columns.
	names = frappe.get_all("Exam Question", filters=filters, pluck="name", limit_page_length=5000)
	picked = random.sample(names, min(count, len(names)))
	if not picked:
		return []

	rows = frappe.get_all(
		"Exam Question",
		filters={"name": ("in", picked)},
		fields=["name", "question_summary", "question_type", "marks", "negative_marks"],
	)
	order = {n: i for i, n in enumerate(picked)}
	rows.sort(key=lambda r: order[r.name])
	return rows
