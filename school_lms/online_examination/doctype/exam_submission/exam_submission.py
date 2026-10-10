import frappe
from frappe.model.document import Document


class ExamSubmission(Document):
	pass


def on_doctype_update():
	# Evaluation list (exam + status) and the auto-submit scheduler (status + deadline).
	frappe.db.add_index("Exam Submission", ["exam_paper", "status"])
	frappe.db.add_index("Exam Submission", ["status", "deadline"])
