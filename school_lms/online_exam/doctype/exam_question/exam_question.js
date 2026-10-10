frappe.ui.form.on("Exam Question", {
	setup(frm) {
		frm.set_query("subject", () => ({
			filters: frm.doc.class ? { class: frm.doc.class, enabled: 1 } : { enabled: 1 },
		}));
	},

	class(frm) {
		if (frm.doc.subject) frm.set_value("subject", null);
	},

	question_type(frm) {
		if (frm.doc.question_type === "True / False") {
			frm.clear_table("options");
			frm.add_child("options", { option_text: __("True") });
			frm.add_child("options", { option_text: __("False") });
			frm.refresh_field("options");
		}
	},
});

frappe.ui.form.on("Exam Question Option", {
	is_correct(frm, cdt, cdn) {
		// Single-answer types: ticking one option unticks the others.
		const row = locals[cdt][cdn];
		if (!row.is_correct) return;
		if (!["Single Choice (MCQ)", "True / False"].includes(frm.doc.question_type)) return;
		(frm.doc.options || []).forEach((o) => {
			if (o.name !== row.name && o.is_correct) frappe.model.set_value(o.doctype, o.name, "is_correct", 0);
		});
	},
});
