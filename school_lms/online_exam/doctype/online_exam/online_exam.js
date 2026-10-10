frappe.ui.form.on("Online Exam", {
	setup(frm) {
		frm.set_query("subject", () => ({
			filters: frm.doc.class ? { class: frm.doc.class, enabled: 1 } : { enabled: 1 },
		}));
		frm.set_query("question", "questions", () => ({
			filters: { class: frm.doc.class, subject: frm.doc.subject, enabled: 1 },
		}));
		frm.set_query("academic_year", () => ({ filters: { enabled: 1 } }));
	},

	refresh(frm) {
		if (frm.doc.docstatus === 0) {
			frm.add_custom_button(__("Add Questions from Bank"), () => add_questions_dialog(frm));
		}
		if (frm.doc.docstatus === 1) {
			frm.add_custom_button(__("Evaluate Answers"), () => {
				frappe.route_options = { online_exam: frm.doc.name };
				frappe.set_route("exam-evaluation");
			});
			frm.add_custom_button(__("Submissions"), () => {
				frappe.set_route("List", "Exam Submission", { online_exam: frm.doc.name });
			});
		}
		show_schedule(frm);
	},

	class(frm) {
		if (frm.doc.subject) frm.set_value("subject", null);
	},

	exam_date: show_schedule,
	start_time: show_schedule,
	duration_minutes: show_schedule,
});

function show_schedule(frm) {
	const d = frm.doc;
	if (!d.exam_date || !d.start_time || !d.duration_minutes) {
		frm.set_intro("");
		return;
	}
	const start = moment(`${d.exam_date} ${d.start_time}`);
	const end = start.clone().add(cint(d.duration_minutes), "minutes");
	frm.set_intro(
		__("Exam window: {0} to {1}. A student who joins late only gets the time left until {2}.", [
			start.format("DD MMM YYYY, hh:mm A"),
			end.format(end.isSame(start, "day") ? "hh:mm A" : "DD MMM YYYY, hh:mm A"),
			end.format("hh:mm A"),
		]),
		"blue"
	);
}

function add_questions_dialog(frm) {
	if (!frm.doc.class || !frm.doc.subject) {
		frappe.msgprint(__("Select Class and Subject first."));
		return;
	}
	const d = new frappe.ui.Dialog({
		title: __("Add Questions from Bank"),
		fields: [
			{ fieldname: "topic", fieldtype: "Link", options: "Topic", label: __("Topic") },
			{
				fieldname: "question_type",
				fieldtype: "Select",
				label: __("Question Type"),
				options: [
					"",
					"Single Choice (MCQ)",
					"Multiple Choice (MSQ)",
					"True / False",
					"Fill in the Blank",
					"Numeric",
					"Short Answer",
					"Long Answer",
					"Drawing",
				].join("\n"),
			},
			{ fieldname: "col", fieldtype: "Column Break" },
			{ fieldname: "difficulty", fieldtype: "Select", label: __("Difficulty"), options: "\nEasy\nMedium\nHard" },
			{ fieldname: "count", fieldtype: "Int", label: __("How many (random)"), default: 10, reqd: 1 },
		],
		primary_action_label: __("Add"),
		primary_action(values) {
			frappe.call({
				method: "school_lms.online_exam.doctype.online_exam.online_exam.pick_questions",
				args: {
					class_name: frm.doc.class,
					subject: frm.doc.subject,
					count: values.count,
					topic: values.topic,
					question_type: values.question_type,
					difficulty: values.difficulty,
					exclude: (frm.doc.questions || []).map((r) => r.question).filter(Boolean),
				},
				freeze: true,
				callback(r) {
					const rows = r.message || [];
					if (!rows.length) {
						frappe.msgprint(__("No more matching questions in the bank."));
						return;
					}
					// Drop the empty row Frappe adds to a new mandatory table.
					frm.doc.questions = (frm.doc.questions || []).filter((row) => row.question);
					rows.forEach((q) => {
						frm.add_child("questions", {
							question: q.name,
							question_summary: q.question_summary,
							question_type: q.question_type,
							marks: q.marks,
							negative_marks: q.negative_marks,
						});
					});
					frm.refresh_field("questions");
					frm.dirty();
					d.hide();
					frappe.show_alert({ message: __("{0} question(s) added", [rows.length]), indicator: "green" });
				},
			});
		},
	});
	d.show();
}
