"""Clean up the old names that clashed on /app/online-exam.

Before: module, DocType, Page and Workspace were all called "Online Exam", and the page
"exam-evaluation" clashed with School Edtech's "Exam Evaluation" DocType.
Now: module "Online Examination", DocType "Exam Paper", pages "my-exams" and
"answer-evaluation", workspace "Student LMS".
"""

import frappe


def execute():
	if not frappe.db.exists("Module Def", "Online Examination"):
		frappe.get_doc(
			{"doctype": "Module Def", "module_name": "Online Examination", "app_name": "school_lms"}
		).insert(ignore_permissions=True)

	for page in ("online-exam", "exam-evaluation", "student-exam"):
		if frappe.db.exists("Page", page) and frappe.db.get_value("Page", page, "module") == "Online Exam":
			frappe.delete_doc("Page", page, force=True, ignore_permissions=True)

	if frappe.db.exists("Workspace", "Online Exam"):
		frappe.delete_doc("Workspace", "Online Exam", force=True, ignore_permissions=True)

	if frappe.db.exists("DocType", "Online Exam"):
		# Attempts belong to the old exams (test data from the first versions of this app).
		if frappe.db.table_exists("Exam Submission"):
			frappe.db.delete("Exam Submission Answer", {"parenttype": "Exam Submission"})
			frappe.db.delete("Exam Submission")
		for doctype in ("Online Exam Question", "Online Exam"):
			if frappe.db.exists("DocType", doctype):
				frappe.delete_doc("DocType", doctype, force=True, ignore_permissions=True)
			frappe.db.sql_ddl(f"drop table if exists `tab{doctype}`")
