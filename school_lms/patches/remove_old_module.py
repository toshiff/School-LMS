import frappe


def execute():
	# After the model sync every doctype has moved to "Online Examination".
	if frappe.db.exists("Module Def", "Online Exam") and frappe.db.get_value("Module Def", "Online Exam", "app_name") == "school_lms":
		for doctype in ("DocType", "Page", "Workspace", "Report"):
			if frappe.db.exists(doctype, {"module": "Online Exam"}):
				return
		frappe.delete_doc("Module Def", "Online Exam", force=True, ignore_permissions=True)
