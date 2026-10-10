frappe.pages["answer-evaluation"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Answer Evaluation"),
		single_column: true,
	});
	wrapper.answer_evaluation = new AnswerEvaluation(page);
};

frappe.pages["answer-evaluation"].on_page_show = function (wrapper) {
	const ev = wrapper.answer_evaluation;
	if (ev && frappe.route_options && frappe.route_options.exam_paper) {
		const exam = frappe.route_options.exam_paper;
		frappe.route_options = null;
		ev.exam_field.set_value(exam);
	}
};

const EV_METHOD = "school_lms.online_examination.page.answer_evaluation.answer_evaluation.";
const ev_esc = (s) => frappe.utils.escape_html(s == null ? "" : String(s));

class AnswerEvaluation {
	constructor(page) {
		this.page = page;
		this.add_styles();
		this.$wrap = $(`
			<div class="ev-wrap">
				<div class="ev-filter"></div>
				<div class="ev-summary"></div>
				<div class="ev-grid">
					<div class="ev-list"></div>
					<div class="ev-detail"><div class="ev-placeholder text-muted">${__("Select an exam, then a student.")}</div></div>
				</div>
			</div>
		`).appendTo(page.main);

		this.exam_field = frappe.ui.form.make_control({
			parent: this.$wrap.find(".ev-filter"),
			df: {
				fieldtype: "Link",
				options: "Exam Paper",
				label: __("Exam Paper"),
				placeholder: __("Select exam"),
				get_query: () => ({ filters: { docstatus: 1 } }),
				change: () => this.load_exam(this.exam_field.get_value()),
			},
			render_input: true,
		});
		this.exam_field.refresh();
		this.page.set_secondary_action(__("Refresh"), () => this.load_exam(this.exam_field.get_value(), true));
	}

	load_exam(exam, keep_selection) {
		if (!exam) return;
		if (exam === this.exam && !keep_selection && this._loaded) return;
		this.exam = exam;
		this._loaded = true;
		frappe.call({
			method: EV_METHOD + "get_submissions",
			args: { exam_paper: exam },
			freeze: true,
			callback: (r) => {
				this.data = r.message;
				this.render_list();
				if (keep_selection && this.current) this.open(this.current);
				else this.$wrap.find(".ev-detail").html(`<div class="ev-placeholder text-muted">${__("Select a student.")}</div>`);
			},
		});
	}

	render_list() {
		const { exam, submissions, counts } = this.data;
		this.$wrap.find(".ev-summary").html(`
			<div class="ev-stats">
				<div><b>${counts.total}</b><span>${__("Attempted")}</span></div>
				<div><b>${counts.in_progress}</b><span>${__("Writing now")}</span></div>
				<div><b>${counts.pending}</b><span>${__("To evaluate")}</span></div>
				<div><b>${counts.evaluated}</b><span>${__("Evaluated")}</span></div>
			</div>
			<div class="text-muted ev-exam-line">${ev_esc(exam.exam_title)} · ${ev_esc(exam.class)}${
			exam.section ? " / " + ev_esc(exam.section) : ""
		} · ${ev_esc(exam.subject_name)} · ${__("Total")} ${ev_esc(exam.total_marks)} · ${
			exam.publish_result ? __("Results published") : __("Results not published")
		}</div>
		`);

		const pill = (s) =>
			({
				"In Progress": `<span class="ev-pill ev-blue">${__("Writing")}</span>`,
				Submitted: `<span class="ev-pill ev-orange">${__("To evaluate")}</span>`,
				Evaluated: `<span class="ev-pill ev-green">${__("Evaluated")}</span>`,
			})[s] || ev_esc(s);

		const rows = submissions
			.map(
				(s) => `
			<div class="ev-row ${s.name === this.current ? "ev-active" : ""}" data-name="${ev_esc(s.name)}">
				<div class="ev-roll">${ev_esc(s.roll_number || "—")}</div>
				<div class="ev-name">${ev_esc(s.student_name)}<div class="text-muted ev-small">${ev_esc(s.section || "")}${
					s.violation_count ? ` · <span class="ev-warn">${__("left exam {0}×", [s.violation_count])}</span>` : ""
				}</div></div>
				<div class="ev-right">${pill(s.status)}<div class="ev-small">${
					s.status === "In Progress" ? "" : `${ev_esc(s.score)} / ${ev_esc(s.total_marks)}`
				}${s.pending_evaluation ? ` · ${__("{0} pending", [s.pending_evaluation])}` : ""}</div></div>
			</div>`
			)
			.join("");
		this.$wrap
			.find(".ev-list")
			.html(rows || `<div class="ev-placeholder text-muted">${__("No student has attempted this exam yet.")}</div>`);
		this.$wrap.find(".ev-row").on("click", (e) => this.open($(e.currentTarget).attr("data-name")));
	}

	open(name) {
		this.current = name;
		this.$wrap.find(".ev-row").removeClass("ev-active");
		this.$wrap.find(`.ev-row[data-name="${CSS.escape(name)}"]`).addClass("ev-active");
		frappe.call({
			method: EV_METHOD + "get_submission",
			args: { submission: name },
			freeze: true,
			callback: (r) => this.render_detail(r.message),
		});
	}

	render_detail(d) {
		this.detail = d;
		const h = d.head;
		const answers = d.answers.map((a) => this.answer_card(a, h.status === "In Progress")).join("");
		const mode = { "Time Up": __("Time up"), Proctoring: __("Auto-submitted: left exam") }[h.submit_mode];
		const $d = this.$wrap.find(".ev-detail").html(`
			<div class="ev-card ev-head">
				<div>
					<div class="ev-student">${ev_esc(h.student_name)} <span class="text-muted">· ${__("Roll")} ${ev_esc(
			h.roll_number || "—"
		)}</span></div>
					<div class="text-muted ev-small">${ev_esc(h.class)}${h.section ? " / " + ev_esc(h.section) : ""} · ${ev_esc(
			h.student
		)}${mode ? " · " + mode : ""}</div>
					${
						h.violation_count
							? `<details class="ev-small ev-warn"><summary>${__("Left the exam {0} time(s)", [
									h.violation_count,
							  ])}</summary><pre>${ev_esc(h.violation_log || "")}</pre></details>`
							: ""
					}
				</div>
				<div class="ev-score"><b class="ev-score-val">${ev_esc(h.score)}</b> / ${ev_esc(h.total_marks)}
					<div class="ev-small text-muted ev-pending">${
						h.pending_evaluation ? __("{0} answer(s) to evaluate", [h.pending_evaluation]) : __("Fully evaluated")
					}</div></div>
			</div>
			${answers}
			${
				h.status === "In Progress"
					? `<div class="ev-placeholder text-muted">${__("The student is still writing. Evaluate after submission.")}</div>`
					: `<div class="ev-actions">
						<button class="btn btn-default ev-save">${__("Save")}</button>
						<button class="btn btn-primary ev-save-next">${__("Save & Next to Evaluate")}</button>
					</div>`
			}
		`);
		$d.find(".ev-save").on("click", () => this.save(false));
		$d.find(".ev-save-next").on("click", () => this.save(true));
		$d.get(0).scrollIntoView({ behavior: "smooth", block: "start" });
	}

	answer_card(a, readonly) {
		let shown = "";
		const blank = !String(a.answer || "").trim();
		if (a.options) {
			shown = a.options
				.map(
					(o) => `
				<div class="ev-opt ${o.selected ? "ev-opt-sel" : ""} ${o.is_correct ? "ev-opt-ok" : ""}">
					<span class="ev-opt-mark">${o.is_correct ? "✓" : ""}</span>
					<span>${ev_esc(o.text)}${o.image ? `<img src="${ev_esc(o.image)}" class="ev-img-sm">` : ""}</span>
					${o.selected ? `<span class="ev-tag">${__("Student's choice")}</span>` : ""}
				</div>`
				)
				.join("");
		} else if (a.type === "Drawing") {
			shown = blank ? "" : `<img class="ev-drawing" src="${ev_esc(a.answer)}">`;
		} else if (!blank) {
			const words = (a.answer.trim().match(/\S+/g) || []).length;
			shown = `<div class="ev-text">${ev_esc(a.answer)}</div>${
				a.word_limit !== undefined ? `<div class="ev-small text-muted">${__("{0} words", [words])}${
					a.word_limit ? " / " + a.word_limit : ""
				}</div>` : ""
			}`;
		}
		if (blank && !a.options) shown = `<div class="text-muted">${__("Not answered")}</div>`;
		if (a.accepted_answers) {
			shown += `<div class="ev-small text-muted">${__("Accepted")}: ${ev_esc(a.accepted_answers.split("\n").join(", "))}</div>`;
		}

		const status = a.is_evaluated
			? a.manual
				? `<span class="ev-pill ev-green">${__("Evaluated")}</span>`
				: a.is_correct
				? `<span class="ev-pill ev-green">${__("Correct")}</span>`
				: `<span class="ev-pill ev-red">${blank ? __("Not answered") : __("Wrong")}</span>`
			: `<span class="ev-pill ev-orange">${__("To evaluate")}</span>`;

		const min = a.manual ? 0 : -flt(a.negative_marks);
		const value = a.is_evaluated ? a.marks_obtained : "";
		return `
			<div class="ev-card ev-answer ${!a.is_evaluated ? "ev-needs" : ""}" data-row="${ev_esc(a.row)}"
				data-orig-marks="${ev_esc(value)}" data-orig-remarks="${ev_esc(a.remarks || "")}">
				<div class="ev-qhead">
					<span>${__("Q{0}", [a.idx])} · ${ev_esc(__(a.type))} · ${flt(a.max_marks) === 1 ? __("1 mark") : __("{0} marks", [a.max_marks])}</span>
					${status}
				</div>
				<div class="ev-question">${a.html || ""}</div>
				${a.image ? `<img class="ev-img" src="${ev_esc(a.image)}">` : ""}
				<div class="ev-label">${__("Student's answer")}</div>
				${shown}
				${
					a.model_answer
						? `<details class="ev-model"><summary>${__("Model answer / marking guide")}</summary>${a.model_answer}</details>`
						: ""
				}
				<div class="ev-marking">
					<label>${__("Marks")}
						<input type="number" class="form-control ev-marks" step="0.5" min="${min}" max="${ev_esc(a.max_marks)}"
							value="${ev_esc(value)}" ${readonly ? "disabled" : ""}>
					</label>
					<span class="text-muted">/ ${ev_esc(a.max_marks)}</span>
					<input type="text" class="form-control ev-remarks" placeholder="${__("Remarks (optional)")}"
						value="${ev_esc(a.remarks || "")}" ${readonly ? "disabled" : ""}>
				</div>
			</div>`;
	}

	save(next) {
		const marks = {};
		let missing = 0;
		this.$wrap.find(".ev-answer").each((_, el) => {
			const $el = $(el);
			const m = $el.find(".ev-marks").val();
			const rem = $el.find(".ev-remarks").val();
			if (m === "" || m === null) {
				if ($el.hasClass("ev-needs")) missing++;
				return;
			}
			if (String(m) !== String($el.attr("data-orig-marks")) || rem !== $el.attr("data-orig-remarks")) {
				marks[$el.attr("data-row")] = { marks: m, remarks: rem };
			}
		});
		if (!Object.keys(marks).length) {
			if (next) this.open_next_pending();
			else frappe.show_alert({ message: __("Nothing changed"), indicator: "blue" });
			return;
		}
		frappe.call({
			method: EV_METHOD + "save_marks",
			args: { submission: this.current, marks: JSON.stringify(marks) },
			freeze: true,
			callback: (r) => {
				const res = r.message || {};
				frappe.show_alert({
					message: missing
						? __("Saved. {0} answer(s) still need marks.", [missing])
						: __("Saved. Score {0}", [res.score]),
					indicator: "green",
				});
				const row = (this.data.submissions || []).find((s) => s.name === this.current);
				if (row) Object.assign(row, res);
				this.data.counts.pending = this.data.submissions.filter((s) => s.status === "Submitted").length;
				this.data.counts.evaluated = this.data.submissions.filter((s) => s.status === "Evaluated").length;
				this.render_list();
				if (next) this.open_next_pending();
				else this.open(this.current);
			},
		});
	}

	open_next_pending() {
		const list = this.data.submissions || [];
		const i = list.findIndex((s) => s.name === this.current);
		const next = list.slice(i + 1).concat(list.slice(0, i + 1)).find((s) => s.status === "Submitted" && s.name !== this.current);
		if (next) this.open(next.name);
		else frappe.show_alert({ message: __("No more answers to evaluate in this exam."), indicator: "green" });
	}

	add_styles() {
		if (document.getElementById("ev-styles")) return;
		$(`<style id="ev-styles">
			.ev-wrap { max-width: 1200px; margin: 0 auto; padding-bottom: 40px; }
			.ev-filter { max-width: 360px; }
			.ev-stats { display: flex; gap: 10px; margin: 6px 0; }
			.ev-stats div { flex: 1; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius-md);
				padding: 10px; text-align: center; }
			.ev-stats b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
			.ev-stats span { font-size: 12px; color: var(--text-muted); }
			.ev-exam-line { font-size: 13px; margin-bottom: 12px; }
			.ev-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 12px; align-items: start; }
			.ev-list { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius-md);
				max-height: calc(100vh - 220px); overflow: auto; position: sticky; top: calc(var(--navbar-height, 48px) + 12px); }
			.ev-row { display: flex; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border-color); cursor: pointer; }
			.ev-row:hover { background: var(--fg-hover-color); }
			.ev-row.ev-active { background: var(--subtle-accent, var(--fg-hover-color)); box-shadow: inset 3px 0 0 var(--primary); }
			.ev-roll { width: 36px; font-weight: 600; font-variant-numeric: tabular-nums; }
			.ev-name { flex: 1; min-width: 0; }
			.ev-right { text-align: right; }
			.ev-small { font-size: 12px; }
			.ev-warn { color: var(--orange-600, #d97706); }
			.ev-pill { display: inline-block; font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 10px; }
			.ev-blue { background: var(--blue-50, #eef5ff); color: var(--blue-700, #1d4ed8); }
			.ev-green { background: var(--green-50, #ecfdf3); color: var(--green-700, #15803d); }
			.ev-orange { background: var(--orange-50, #fff7ed); color: var(--orange-700, #c2410c); }
			.ev-red { background: var(--red-50, #fef2f2); color: var(--red-700, #b91c1c); }
			.ev-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius-md);
				padding: 14px 16px; margin-bottom: 10px; }
			.ev-needs { border-color: var(--orange-400, #fb923c); }
			.ev-head { display: flex; justify-content: space-between; gap: 12px; }
			.ev-student { font-size: 16px; font-weight: 600; }
			.ev-score { text-align: right; font-size: 15px; }
			.ev-score b { font-size: 24px; font-variant-numeric: tabular-nums; }
			.ev-head pre { white-space: pre-wrap; font-size: 12px; margin: 6px 0 0; }
			.ev-qhead { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 8px; }
			.ev-question { margin-bottom: 8px; }
			.ev-question img, .ev-img { max-width: 100%; max-height: 300px; }
			.ev-label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin: 10px 0 4px; }
			.ev-text { white-space: pre-wrap; background: var(--subtle-fg); border-radius: var(--border-radius); padding: 10px 12px; }
			.ev-drawing { max-width: 100%; border: 1px solid var(--border-color); border-radius: var(--border-radius); background: #fff; }
			.ev-opt { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border: 1px solid var(--border-color);
				border-radius: var(--border-radius); margin-bottom: 6px; }
			.ev-opt-mark { width: 14px; color: var(--green-600, #16a34a); font-weight: 700; }
			.ev-opt-ok { border-color: var(--green-400, #4ade80); }
			.ev-opt-sel:not(.ev-opt-ok) { border-color: var(--red-400, #f87171); }
			.ev-tag { margin-left: auto; font-size: 11px; color: var(--text-muted); }
			.ev-img-sm { display: block; max-height: 120px; margin-top: 4px; }
			.ev-model { margin-top: 10px; font-size: 13px; }
			.ev-marking { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
			.ev-marking label { display: flex; gap: 8px; align-items: center; margin: 0; font-weight: 500; }
			.ev-marks { width: 90px; }
			.ev-remarks { flex: 1; min-width: 180px; }
			.ev-actions { display: flex; gap: 8px; justify-content: flex-end; position: sticky; bottom: 0; padding: 10px 0;
				background: var(--bg-color); }
			.ev-placeholder { padding: 30px 16px; text-align: center; }
			@media (max-width: 900px) { .ev-grid { grid-template-columns: 1fr; } .ev-list { position: static; max-height: 360px; } }
		</style>`).appendTo("head");
	}
}
