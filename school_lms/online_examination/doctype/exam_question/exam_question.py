import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt, strip_html

from school_lms.grading import (
	MCQ,
	MSQ,
	NUMERIC,
	OPTION_TYPES,
	TEXT_AUTO_TYPES,
	TRUE_FALSE,
	accepted_lines,
)


class ExamQuestion(Document):
	def validate(self):
		self.question_summary = " ".join(strip_html(self.question or "").split())[:140]
		if not self.question_summary and not self.question_image:
			frappe.throw(_("Please enter the question."))

		if flt(self.marks) <= 0:
			frappe.throw(_("Marks must be greater than 0."))
		if flt(self.negative_marks) < 0:
			frappe.throw(_("Negative Marks cannot be less than 0."))

		self.validate_subject_class()

		if self.question_type in OPTION_TYPES:
			self.validate_options()
		else:
			self.options = []

		if self.question_type in TEXT_AUTO_TYPES:
			self.validate_accepted_answers()

		if cint(self.answer_word_limit) < 0:
			self.answer_word_limit = 0

	def validate_subject_class(self):
		subject_class = frappe.db.get_value("Subject", self.subject, "class")
		if subject_class and self.get("class") and subject_class != self.get("class"):
			frappe.throw(
				_("Subject {0} belongs to class {1}, not {2}.").format(
					frappe.bold(self.subject), frappe.bold(subject_class), frappe.bold(self.get("class"))
				)
			)

	def validate_options(self):
		if self.question_type == TRUE_FALSE and not self.options:
			self.append("options", {"option_text": _("True")})
			self.append("options", {"option_text": _("False")})

		self.options = [o for o in self.options if (o.option_text or "").strip() or o.option_image]
		for i, o in enumerate(self.options, start=1):
			o.idx = i

		if len(self.options) < 2:
			frappe.throw(_("Add at least two options."))

		correct = sum(1 for o in self.options if o.is_correct)
		if self.question_type in (MCQ, TRUE_FALSE) and correct != 1:
			frappe.throw(_("Tick exactly one correct option for a {0} question.").format(self.question_type))
		if self.question_type == MSQ and correct < 1:
			frappe.throw(_("Tick at least one correct option."))

	def validate_accepted_answers(self):
		lines = accepted_lines(self.accepted_answers)
		if not lines:
			frappe.throw(_("Enter at least one accepted answer."))
		if self.question_type == NUMERIC:
			for line in lines:
				try:
					float(line.replace(",", ""))
				except ValueError:
					frappe.throw(_("Accepted answer {0} is not a number.").format(frappe.bold(line)))
			self.numeric_tolerance = abs(flt(self.numeric_tolerance))
