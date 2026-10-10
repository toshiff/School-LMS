frappe.pages["my-exams"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("My Exams"),
		single_column: true,
	});
	wrapper.my_exams = new MyExams(page);
};

frappe.pages["my-exams"].on_page_show = function (wrapper) {
	const app = wrapper.my_exams;
	if (app && !app.in_exam) app.load_home();
};

const OE_API = "school_lms.api.";
const oe_esc = (s) => frappe.utils.escape_html(s == null ? "" : String(s));
const OE_PAD_W = 1000;
const OE_PAD_H = 625;

class MyExams {
	constructor(page) {
		this.page = page;
		this.$body = $(`<div class="oe-wrap"></div>`).appendTo(page.main);
		this.in_exam = false;
		this.lockdown = false;
		this.fs_supported = !!(
			document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen
		);
		this.add_styles();
		this.bind_route_guard();
	}

	// Promise wrapper around frappe.call that rejects on any failure.
	call(method, args, opts = {}) {
		return new Promise((resolve, reject) => {
			const xhr = frappe.call({
				method: OE_API + method,
				args,
				freeze: !!opts.freeze,
				freeze_message: opts.freeze_message,
				silent: !!opts.silent,
				callback: (r) => resolve(r ? r.message : undefined),
				error: (e) => reject(e || new Error("request failed")),
			});
			if (xhr && xhr.fail) xhr.fail((e) => reject(e || new Error("request failed")));
		});
	}

	// =====================================================================
	// Home: student details + exam list
	// =====================================================================
	load_home() {
		this.stop_home_ticker();
		this.page.set_title(__("My Exams"));
		this.$body.html(`<div class="oe-loading text-muted">${__("Loading your exams…")}</div>`);
		this.call("get_my_exams")
			.then((data) => this.render_home(data || {}))
			.catch(() =>
				this.$body.html(`<div class="oe-card oe-empty">${__("Could not load exams. Please refresh.")}</div>`)
			);
	}

	render_home(data) {
		const st = data.student;
		if (!st) {
			this.$body.html(`<div class="oe-card oe-empty">${oe_esc(data.message || __("No student record found."))}</div>`);
			return;
		}

		const exams = data.exams || [];
		this.exams_by_name = {};
		exams.forEach((e) => (this.exams_by_name[e.name] = e));
		const now = Date.now();
		exams.forEach((e) => {
			e._start_at = now + e.seconds_to_start * 1000;
			e._end_at = now + e.seconds_to_end * 1000;
		});

		const live = exams.filter((e) => ["live", "in_progress"].includes(e.state));
		const upcoming = exams.filter((e) => e.state === "upcoming");
		const done = exams.filter((e) => ["submitted", "missed", "closing"].includes(e.state));

		const section = (title, list, empty) => `
			<div class="oe-section">
				<div class="oe-section-title">${title}</div>
				${list.length ? list.map((e) => this.exam_card(e)).join("") : `<div class="oe-muted-box">${empty}</div>`}
			</div>`;

		this.$body.html(`
			<div class="oe-card oe-student">
				<div class="oe-avatar">${oe_esc((st.student_name || "?").trim().charAt(0).toUpperCase())}</div>
				<div class="oe-student-info">
					<div class="oe-student-name">${oe_esc(st.student_name)}</div>
					<div class="oe-student-meta">
						<span><b>${__("Class")}</b> ${oe_esc(st.class || "—")}</span>
						<span><b>${__("Section")}</b> ${oe_esc(st.section || "—")}</span>
						<span><b>${__("Roll No.")}</b> ${oe_esc(st.roll_number || "—")}</span>
						<span><b>${__("Academic Year")}</b> ${oe_esc(st.academic_year || "—")}</span>
					</div>
				</div>
			</div>
			${data.message ? `<div class="oe-muted-box">${oe_esc(data.message)}</div>` : ""}
			${section(__("Live now"), live, __("No exam is running right now."))}
			${section(__("Upcoming"), upcoming, __("No upcoming exams."))}
			${section(__("Recently finished"), done, __("Nothing here yet."))}
		`);

		this.$body.find(".oe-start-exam").on("click", (ev) => {
			const exam = this.exams_by_name[$(ev.currentTarget).attr("data-name")];
			if (exam) this.confirm_start(exam);
		});
		this.start_home_ticker();
	}

	exam_card(e) {
		const start = moment(e.start_datetime);
		const end = moment(e.end_datetime);
		const when = `${start.format("ddd, DD MMM YYYY")} · ${start.format("hh:mm A")} – ${end.format(
			end.isSame(start, "day") ? "hh:mm A" : "DD MMM, hh:mm A"
		)}`;

		let status = "";
		let action = "";
		if (e.state === "upcoming") {
			status = `<span class="oe-pill oe-pill-blue">${__("Starts in")} <span class="oe-count" data-name="${oe_esc(
				e.name
			)}" data-kind="start"></span></span>`;
			action = `<button class="btn btn-default btn-sm" disabled>${__("Not started")}</button>`;
		} else if (e.state === "live" || e.state === "in_progress") {
			status = `<span class="oe-pill oe-pill-green">${
				e.state === "live" ? __("Live") : __("In progress")
			} · <span class="oe-count" data-name="${oe_esc(e.name)}" data-kind="end"></span> ${__("left")}</span>`;
			action = `<button class="btn btn-primary btn-sm oe-start-exam" data-name="${oe_esc(e.name)}">${
				e.state === "live" ? __("Start Exam") : __("Resume Exam")
			}</button>`;
		} else if (e.state === "submitted") {
			if (e.score !== undefined) {
				const verdict =
					e.passed === undefined ? "" : e.passed ? ` · ${__("Pass")}` : ` · ${__("Fail")}`;
				status = `<span class="oe-pill ${e.passed === false ? "oe-pill-red" : "oe-pill-green"}">${__(
					"Score"
				)} ${oe_esc(e.score)} / ${oe_esc(e.result_total)}${verdict}</span>`;
			} else {
				status = `<span class="oe-pill oe-pill-gray">${__("Submitted · result pending")}</span>`;
			}
		} else if (e.state === "closing") {
			status = `<span class="oe-pill oe-pill-gray">${__("Time over · submitting your answers")}</span>`;
		} else {
			status = `<span class="oe-pill oe-pill-red">${__("Missed")}</span>`;
		}

		return `
			<div class="oe-card oe-exam-card">
				<div class="oe-exam-main">
					<div class="oe-exam-subject">${oe_esc(e.subject_name)}${
						e.exam_type ? ` <span class="oe-tag">${oe_esc(e.exam_type)}</span>` : ""
					}</div>
					<div class="oe-exam-title">${oe_esc(e.exam_title)}</div>
					<div class="oe-exam-when">${oe_esc(when)} · ${oe_esc(e.duration_minutes)} ${__("min")} · ${
			flt(e.total_marks) === 1 ? __("1 mark") : __("{0} marks", [oe_esc(e.total_marks)])
		}</div>
					<div class="oe-exam-status">${status}</div>
				</div>
				<div class="oe-exam-action">${action}</div>
			</div>`;
	}

	start_home_ticker() {
		const tick = () => {
			if (frappe.get_route()[0] !== "my-exams") return this.stop_home_ticker();
			const now = Date.now();
			let refresh = false;
			this.$body.find(".oe-count").each((_, el) => {
				const e = this.exams_by_name[el.getAttribute("data-name")];
				if (!e) return;
				const target = el.getAttribute("data-kind") === "start" ? e._start_at : e._end_at;
				const left = Math.max(0, Math.round((target - now) / 1000));
				el.textContent = this.fmt_span(left);
				if (left === 0) refresh = true;
			});
			if (refresh && !this.home_refresh_pending) {
				// Spread the reload so a whole class doesn't hit the server in the same second.
				this.home_refresh_pending = true;
				setTimeout(() => {
					this.home_refresh_pending = false;
					if (!this.in_exam) this.load_home();
				}, 1000 + Math.random() * 5000);
			}
		};
		tick();
		this.home_ticker = setInterval(tick, 1000);
	}

	stop_home_ticker() {
		if (this.home_ticker) clearInterval(this.home_ticker);
		this.home_ticker = null;
	}

	fmt_span(sec) {
		const d = Math.floor(sec / 86400);
		const h = Math.floor((sec % 86400) / 3600);
		const m = Math.floor((sec % 3600) / 60);
		const s = sec % 60;
		if (d) return `${d}d ${h}h ${m}m`;
		if (h) return `${h}h ${m}m ${s}s`;
		return `${m}m ${String(s).padStart(2, "0")}s`;
	}

	confirm_start(exam) {
		const max = cint(exam.max_violations);
		const rules = [
			__("The exam opens in full screen. Stay on this screen until you submit."),
			__("Switching tabs or windows, minimising, or leaving full screen is recorded as a warning."),
			__("Closing or reloading the exam page also counts as a warning."),
			max
				? __("After {0} warnings your exam is submitted automatically.", [max])
				: __("Every warning is reported to your teacher."),
			__("Your answers are saved automatically. The exam submits itself when time runs out."),
		];
		const left = Math.max(0, Math.round((exam._end_at - Date.now()) / 1000));
		const d = new frappe.ui.Dialog({
			title: `${exam.subject_name} · ${exam.exam_title}`,
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "info",
					options: `
						<div class="oe-start-info">
							<div class="oe-start-stats">
								<div><b>${oe_esc(exam.question_count || "")}</b><span>${__("Questions")}</span></div>
								<div><b>${oe_esc(exam.total_marks)}</b><span>${__("Marks")}</span></div>
								<div><b>${this.fmt_span(left)}</b><span>${__("Time left")}</span></div>
							</div>
							${exam.instructions ? `<div class="oe-instructions">${exam.instructions}</div>` : ""}
							<div class="oe-rules"><b>${__("Exam rules")}</b><ul>${rules
								.map((r) => `<li>${r}</li>`)
								.join("")}</ul></div>
						</div>`,
				},
			],
			primary_action_label: exam.state === "in_progress" ? __("Resume Exam") : __("Start Exam"),
			primary_action: () => {
				// Must run directly inside the click, or the browser refuses full screen.
				this.enter_fullscreen();
				d.hide();
				this.call("start_exam", { exam_paper: exam.name }, { freeze: true, freeze_message: __("Loading your paper…") })
					.then((paper) => paper && this.show_exam(paper))
					.catch(() => {
						this.exit_fullscreen();
						this.load_home();
					});
			},
		});
		d.show();
	}

	// =====================================================================
	// Exam screen
	// =====================================================================
	show_exam(paper) {
		this.stop_home_ticker();
		this.in_exam = true;
		this.paper = paper;
		this.sub = paper.submission;
		this.qs = paper.questions || [];
		this.current = 0;
		this.submitting = false;
		this.violations = cint(paper.violation_count);
		this.max_violations = cint(paper.max_violations);
		this.local_key = `oe_${this.sub}`;

		// Server answers first, then this device's backup (it is newer than the last autosave).
		this.answers = {};
		this.drawing_layers = {};
		this.drawing_saved_url = {};
		this.drawing_versions = {};
		this.dirty = new Set();
		this.dirty_drawings = new Set();
		this.qs.forEach((q) => {
			if (q.type === "Drawing") this.drawing_saved_url[q.name] = q.answer || null;
			else this.answers[q.name] = q.answer;
		});
		const local = this.load_local();
		this.review = new Set(local.review || []);
		Object.entries(local.answers || {}).forEach(([k, v]) => {
			if (k in this.answers && JSON.stringify(v) !== JSON.stringify(this.answers[k])) {
				this.answers[k] = v;
				this.dirty.add(k);
			}
		});
		Object.entries(local.drawings || {}).forEach(([k, v]) => {
			if (k in this.drawing_saved_url) {
				this.drawing_layers[k] = v;
				this.dirty_drawings.add(k);
			}
		});

		const ex = paper.exam || {};
		const st = paper.student || {};
		this.page.set_title(`${ex.subject_name || ""} · ${ex.title || ""}`);
		this.$body.html(`
			<div class="oe-bar">
				<div class="oe-bar-title">
					<div class="oe-bar-exam">${oe_esc(ex.subject_name)} · ${oe_esc(ex.title)}</div>
					<div class="oe-bar-student">${oe_esc(st.student_name)} · ${__("Roll")} ${oe_esc(st.roll_number || "—")} · ${oe_esc(
			st.class
		)}${st.section ? " / " + oe_esc(st.section) : ""}</div>
				</div>
				<span class="oe-warnings"></span>
				<span class="oe-timer">--:--</span>
				<button class="btn btn-primary btn-sm oe-submit-btn">${__("Submit")}</button>
			</div>
			<div class="oe-grid">
				<div class="oe-main">
					<div class="oe-card oe-qcard"></div>
					<div class="oe-nav">
						<button class="btn btn-default oe-prev">${__("Previous")}</button>
						<button class="btn btn-default oe-review"></button>
						<button class="btn btn-default oe-clear">${__("Clear answer")}</button>
						<button class="btn btn-primary oe-next">${__("Next")}</button>
					</div>
				</div>
				<div class="oe-side">
					<div class="oe-card">
						<div class="oe-side-title">${__("Questions")}</div>
						<div class="oe-palette"></div>
						<div class="oe-legend">
							<span><i class="oe-dot oe-answered"></i>${__("Answered")}</span>
							<span><i class="oe-dot oe-marked"></i>${__("For review")}</span>
							<span><i class="oe-dot"></i>${__("Not answered")}</span>
						</div>
						<div class="oe-save-state text-muted"></div>
					</div>
				</div>
			</div>
		`);

		this.$body.find(".oe-submit-btn").on("click", () => this.confirm_submit());
		this.$body.find(".oe-prev").on("click", () => this.go(this.current - 1));
		this.$body.find(".oe-next").on("click", () => this.go(this.current + 1));
		this.$body.find(".oe-clear").on("click", () => this.clear_current());
		this.$body.find(".oe-review").on("click", () => {
			const q = this.qs[this.current];
			if (this.review.has(q.name)) this.review.delete(q.name);
			else this.review.add(q.name);
			this.save_local();
			this.update_nav();
			this.update_palette_item(this.current);
		});

		this.render_palette();
		this.render_question(0);
		this.update_warnings();
		this.enable_lockdown();
		this.start_timer(paper.remaining_seconds);
		this.start_autosave();

		if (this.max_violations && this.violations >= this.max_violations) {
			this.auto_submit_for_violations();
		} else if (this.violations > 0) {
			this.show_overlay(__("You left the exam page."));
		}
	}

	go(i) {
		if (i < 0 || i >= this.qs.length || i === this.current) return;
		this.render_question(i);
	}

	render_question(i) {
		this.commit_pad();
		this.current = i;
		const q = this.qs[i];
		const marks = flt(q.marks) === 1 ? __("1 mark") : __("{0} marks", [oe_esc(q.marks)]);
		const neg = flt(q.negative_marks) ? ` · <span class="oe-neg">−${oe_esc(q.negative_marks)} ${__("if wrong")}</span>` : "";
		const $card = this.$body.find(".oe-qcard");
		$card.html(`
			<div class="oe-qhead">
				<span>${__("Question {0} of {1}", [i + 1, this.qs.length])}</span>
				<span class="oe-qtype">${oe_esc(__(q.type))} · ${marks}${neg}</span>
			</div>
			<div class="oe-question">${q.html || ""}</div>
			${q.image ? `<img class="oe-qimg" src="${oe_esc(q.image)}" alt="">` : ""}
			<div class="oe-answer"></div>
		`);
		this.render_answer_widget(q, $card.find(".oe-answer"));
		this.update_nav();
		this.render_palette();
		const top = this.$body.find(".oe-bar").get(0);
		if (top && window.scrollY > top.offsetTop) window.scrollTo({ top: top.offsetTop, behavior: "smooth" });
	}

	render_answer_widget(q, $w) {
		const val = this.answers[q.name];
		if (["Single Choice (MCQ)", "Multiple Choice (MSQ)", "True / False"].includes(q.type)) {
			const multi = q.type === "Multiple Choice (MSQ)";
			const selected = new Set(multi ? val || [] : val ? [val] : []);
			$w.html(
				(multi ? `<div class="oe-hint">${__("Select all correct options.")}</div>` : "") +
					(q.options || [])
						.map(
							(o, k) => `
					<label class="oe-option ${selected.has(o.id) ? "oe-selected" : ""}">
						<input type="${multi ? "checkbox" : "radio"}" name="oe-opt" value="${oe_esc(o.id)}"
							${selected.has(o.id) ? "checked" : ""}>
						<span class="oe-key">${String.fromCharCode(65 + k)}</span>
						<span class="oe-opt-body">${oe_esc(o.text)}${
								o.image ? `<img class="oe-opt-img" src="${oe_esc(o.image)}" alt="">` : ""
							}</span>
					</label>`
						)
						.join("")
			);
			$w.on("change", "input", () => {
				const checked = $w.find("input:checked").map((_, el) => el.value).get();
				$w.find(".oe-option").each((_, el) => $(el).toggleClass("oe-selected", $(el).find("input").is(":checked")));
				this.set_answer(q.name, multi ? checked : checked[0] || "");
			});
		} else if (q.type === "Fill in the Blank" || q.type === "Numeric") {
			const numeric = q.type === "Numeric";
			$w.html(`
				<input type="text" class="form-control oe-text-input" maxlength="500" autocomplete="off" spellcheck="false"
					${numeric ? 'inputmode="decimal"' : ""} placeholder="${numeric ? __("Enter a number") : __("Type your answer")}">
			`);
			$w.find("input")
				.val(val || "")
				.on("input", (ev) => this.set_answer(q.name, ev.target.value));
		} else if (q.type === "Short Answer" || q.type === "Long Answer") {
			const rows = q.type === "Long Answer" ? 14 : 5;
			$w.html(`
				<textarea class="form-control oe-textarea" rows="${rows}" spellcheck="false"
					placeholder="${__("Write your answer here")}"></textarea>
				<div class="oe-wordcount"></div>
			`);
			const $ta = $w.find("textarea");
			const count = () => {
				const words = ($ta.val().trim().match(/\S+/g) || []).length;
				const limit = cint(q.word_limit);
				$w.find(".oe-wordcount")
					.text(limit ? __("{0} / {1} words", [words, limit]) : __("{0} words", [words]))
					.toggleClass("oe-danger", !!limit && words > limit);
			};
			$ta.val(val || "").on("input", () => {
				this.set_answer(q.name, $ta.val());
				count();
			});
			count();
		} else if (q.type === "Drawing") {
			this.pad = new OEDrawingPad($w, {
				background: q.background,
				initial_layer: this.drawing_layers[q.name],
				initial_url: this.drawing_layers[q.name] ? null : this.drawing_saved_url[q.name],
				on_change: (layer) => this.set_drawing(q.name, layer),
			});
			this.pad_question = q.name;
		}
	}

	commit_pad() {
		if (this.pad) {
			this.pad.flush();
			this.pad.destroy();
		}
		this.pad = null;
		this.pad_question = null;
	}

	set_answer(qname, value) {
		this.answers[qname] = value;
		this.dirty.add(qname);
		this.save_local();
		this.update_palette_item(this.qs.findIndex((q) => q.name === qname));
	}

	set_drawing(qname, layer) {
		this.drawing_layers[qname] = layer; // null = cleared
		this.drawing_versions[qname] = (this.drawing_versions[qname] || 0) + 1;
		this.dirty_drawings.add(qname);
		this.save_local();
		this.update_palette_item(this.qs.findIndex((q) => q.name === qname));
	}

	clear_current() {
		const q = this.qs[this.current];
		if (q.type === "Drawing") {
			if (this.pad) this.pad.clear();
			return;
		}
		this.set_answer(q.name, q.type === "Multiple Choice (MSQ)" ? [] : "");
		this.render_question(this.current);
	}

	is_answered(q) {
		if (q.type === "Drawing") {
			if (q.name in this.drawing_layers) return !!this.drawing_layers[q.name];
			return !!this.drawing_saved_url[q.name];
		}
		const v = this.answers[q.name];
		if (Array.isArray(v)) return v.length > 0;
		return !!(v && String(v).trim());
	}

	render_palette() {
		const html = this.qs
			.map((q, i) => `<button class="oe-pal" data-i="${i}">${i + 1}</button>`)
			.join("");
		const $p = this.$body.find(".oe-palette").html(html);
		$p.find(".oe-pal").on("click", (ev) => this.go(cint($(ev.currentTarget).attr("data-i"))));
		this.qs.forEach((_, i) => this.update_palette_item(i));
	}

	update_palette_item(i) {
		if (i < 0) return;
		const q = this.qs[i];
		this.$body
			.find(`.oe-pal[data-i="${i}"]`)
			.toggleClass("oe-answered", this.is_answered(q))
			.toggleClass("oe-marked", this.review.has(q.name))
			.toggleClass("oe-current", i === this.current);
	}

	update_nav() {
		const q = this.qs[this.current];
		this.$body.find(".oe-prev").prop("disabled", this.current === 0);
		this.$body.find(".oe-next").prop("disabled", this.current === this.qs.length - 1);
		this.$body
			.find(".oe-review")
			.text(this.review.has(q.name) ? __("Unmark review") : __("Mark for review"))
			.toggleClass("oe-review-on", this.review.has(q.name));
	}

	update_warnings() {
		const $w = this.$body.find(".oe-warnings");
		if (!this.max_violations && !this.violations) {
			$w.text("");
			return;
		}
		$w.text(
			this.max_violations
				? __("Warnings {0}/{1}", [this.violations, this.max_violations])
				: __("Warnings {0}", [this.violations])
		).toggleClass("oe-danger", this.violations > 0);
	}

	// ---------------- local backup (survives refresh / power cut) ----------------
	load_local() {
		try {
			return JSON.parse(localStorage.getItem(this.local_key) || "{}");
		} catch (e) {
			return {};
		}
	}

	save_local() {
		clearTimeout(this._local_timer);
		this._local_timer = setTimeout(() => {
			const drawings = {};
			this.dirty_drawings.forEach((k) => (drawings[k] = this.drawing_layers[k] || null));
			try {
				localStorage.setItem(
					this.local_key,
					JSON.stringify({ answers: this.answers, drawings, review: [...this.review] })
				);
			} catch (e) {
				// Storage full or blocked: the server autosave still runs.
			}
		}, 600);
	}

	clear_local() {
		clearTimeout(this._local_timer);
		try {
			localStorage.removeItem(this.local_key);
		} catch (e) {}
	}

	// ---------------- autosave ----------------
	start_autosave() {
		this.stop_autosave();
		// 20–30 s, different per student, so a full class doesn't save in the same second.
		this.autosave_timer = setInterval(() => this.flush(), 20000 + Math.random() * 10000);
	}

	stop_autosave() {
		if (this.autosave_timer) clearInterval(this.autosave_timer);
		this.autosave_timer = null;
	}

	set_save_state(text) {
		this.$body.find(".oe-save-state").text(text || "");
	}

	async flush() {
		if (this.flushing || this.submitting) return;
		if (this.pad) this.pad.flush();
		if (!this.dirty.size && !this.dirty_drawings.size) return;
		this.flushing = true;
		this.set_save_state(__("Saving…"));
		try {
			if (this.dirty.size) {
				const snapshot = {};
				this.dirty.forEach((k) => (snapshot[k] = this.answers[k]));
				const r = await this.call("save_answers", { submission: this.sub, answers: JSON.stringify(snapshot) }, { silent: true });
				if (r && r.closed) {
					this.flushing = false;
					this.submit("Time Up");
					return;
				}
				Object.keys(snapshot).forEach((k) => {
					if (JSON.stringify(this.answers[k]) === JSON.stringify(snapshot[k])) this.dirty.delete(k);
				});
			}
			for (const k of [...this.dirty_drawings]) {
				const version = this.drawing_versions[k] || 0;
				const r = await this.upload_drawing(k);
				if (r && r.closed) {
					this.flushing = false;
					this.submit("Time Up");
					return;
				}
				if ((this.drawing_versions[k] || 0) === version) this.dirty_drawings.delete(k);
			}
			this.save_local();
			this.set_save_state(__("All answers saved at {0}", [moment().format("hh:mm:ss A")]));
		} catch (e) {
			this.set_save_state(__("Not saved yet — will retry. Your answers are kept on this device."));
		}
		this.flushing = false;
	}

	async upload_drawing(qname) {
		const layer = this.drawing_layers[qname];
		const q = this.qs.find((x) => x.name === qname);
		const image = layer ? await OEDrawingPad.compose(layer, q && q.background) : "";
		const r = await this.call("save_drawing", { submission: this.sub, question: qname, image }, { silent: true });
		if (r && r.saved) this.drawing_saved_url[qname] = image ? "saved" : null;
		return r;
	}

	// ---------------- timer ----------------
	start_timer(seconds) {
		this.stop_timer();
		// Counted from the server's remaining seconds, so the device clock doesn't matter.
		this.end_at = Date.now() + seconds * 1000;
		const tick = () => {
			const left = Math.max(0, Math.ceil((this.end_at - Date.now()) / 1000));
			const h = Math.floor(left / 3600);
			const mm = String(Math.floor((left % 3600) / 60)).padStart(2, "0");
			const ss = String(left % 60).padStart(2, "0");
			this.$body
				.find(".oe-timer")
				.text(h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`)
				.toggleClass("oe-danger", left <= 60)
				.toggleClass("oe-warn", left > 60 && left <= 300);
			if (left === 300) frappe.show_alert({ message: __("5 minutes left"), indicator: "orange" });
			if (left === 0) {
				this.stop_timer();
				frappe.show_alert({ message: __("Time is up. Submitting…"), indicator: "orange" });
				this.submit("Time Up");
			}
		};
		tick();
		this.timer = setInterval(tick, 500);
	}

	stop_timer() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	// ---------------- submit ----------------
	confirm_submit() {
		if (this.pad) this.pad.flush();
		const total = this.qs.length;
		const answered = this.qs.filter((q) => this.is_answered(q)).length;
		const marked = this.review.size;
		let msg = __("You have answered {0} of {1} questions.", [answered, total]);
		if (marked) msg += " " + __("{0} marked for review.", [marked]);
		msg += "<br><br>" + __("Submit your exam? You can't change answers after this.");
		frappe.confirm(msg, () => this.submit("Student"));
	}

	async submit(mode) {
		if (this.submitting) return;
		this.submitting = true;
		this.stop_timer();
		this.stop_autosave();
		this.hide_overlay();
		if (this.pad) this.pad.flush();
		this.$body.find(".oe-submit-btn, .oe-nav button").prop("disabled", true);
		frappe.dom.freeze(__("Submitting your exam…"));

		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		try {
			// Wait for an autosave already on the wire.
			for (let i = 0; i < 20 && this.flushing; i++) await sleep(250);

			for (const k of [...this.dirty_drawings]) {
				for (let attempt = 1; attempt <= 3; attempt++) {
					try {
						const r = await this.upload_drawing(k);
						if (r && r.closed) break;
						this.dirty_drawings.delete(k);
						break;
					} catch (e) {
						if (attempt === 3) throw e;
						await sleep(2000);
					}
				}
			}

			const answers = {};
			this.qs.forEach((q) => {
				if (q.type !== "Drawing") answers[q.name] = this.answers[q.name];
			});
			let res;
			for (let attempt = 1; ; attempt++) {
				try {
					res = await this.call("submit_exam", { submission: this.sub, answers: JSON.stringify(answers), mode });
					break;
				} catch (e) {
					if (attempt >= 5) throw e;
					frappe.show_alert({ message: __("Network problem, retrying…"), indicator: "orange" });
					await sleep(3000);
				}
			}
			frappe.dom.unfreeze();
			this.clear_local();
			this.disable_lockdown();
			this.show_result(res || {});
		} catch (e) {
			frappe.dom.unfreeze();
			this.submitting = false;
			this.$body.find(".oe-submit-btn, .oe-nav button").prop("disabled", false);
			this.update_nav();
			this.start_autosave();
			const left = Math.max(0, Math.ceil((this.end_at - Date.now()) / 1000));
			if (left > 0) this.start_timer(left);
			frappe.msgprint(
				__("Could not reach the server. Your answers are kept on this device. Check your internet and press Submit again.")
			);
		}
	}

	show_result(res) {
		this.commit_pad();
		this.in_exam = false;
		this.page.set_title(__("My Exams"));
		let body;
		if (res.score !== undefined) {
			const verdict = res.passed === undefined ? "" : res.passed ? __("Pass") : __("Fail");
			body = `<div class="oe-result-score">${oe_esc(res.score)} <span>/ ${oe_esc(res.total_marks)}</span></div>
				${verdict ? `<div class="oe-pill ${res.passed ? "oe-pill-green" : "oe-pill-red"}">${verdict}</div>` : ""}`;
		} else {
			body = `<p class="text-muted">${__("Your answers have been saved. Your result will be shown here once it is published.")}</p>`;
		}
		const how = {
			"Time Up": __("Time ran out, so your saved answers were submitted automatically."),
			Proctoring: __("Your exam was submitted automatically because you left the exam screen too many times."),
		}[res.submit_mode];
		this.$body.html(`
			<div class="oe-card oe-result">
				<h4>${__("Exam submitted")}</h4>
				${how ? `<p>${how}</p>` : ""}
				${body}
				<button class="btn btn-default oe-back">${__("Back to my exams")}</button>
			</div>
		`);
		this.$body.find(".oe-back").on("click", () => this.load_home());
	}

	// =====================================================================
	// Lockdown
	// =====================================================================
	enable_lockdown() {
		if (this.lockdown) return;
		this.lockdown = true;
		$("body").addClass("oe-lockdown");

		this.h = {
			visibility: () => document.hidden && this.violation("tab"),
			blur: () => this.violation("blur"),
			fullscreen: () => {
				if (this.fs_supported && !this.is_fullscreen()) this.violation("fullscreen");
			},
			keydown: (e) => this.block_keys(e),
			block: (e) => e.preventDefault(),
			beforeunload: (e) => {
				e.preventDefault();
				e.returnValue = "";
			},
		};
		document.addEventListener("visibilitychange", this.h.visibility);
		window.addEventListener("blur", this.h.blur);
		document.addEventListener("fullscreenchange", this.h.fullscreen);
		document.addEventListener("webkitfullscreenchange", this.h.fullscreen);
		document.addEventListener("keydown", this.h.keydown, true);
		["contextmenu", "copy", "cut", "paste", "drop"].forEach((ev) => document.addEventListener(ev, this.h.block, true));
		window.addEventListener("beforeunload", this.h.beforeunload);
	}

	disable_lockdown() {
		if (!this.lockdown) return;
		this.lockdown = false;
		$("body").removeClass("oe-lockdown");
		document.removeEventListener("visibilitychange", this.h.visibility);
		window.removeEventListener("blur", this.h.blur);
		document.removeEventListener("fullscreenchange", this.h.fullscreen);
		document.removeEventListener("webkitfullscreenchange", this.h.fullscreen);
		document.removeEventListener("keydown", this.h.keydown, true);
		["contextmenu", "copy", "cut", "paste", "drop"].forEach((ev) =>
			document.removeEventListener(ev, this.h.block, true)
		);
		window.removeEventListener("beforeunload", this.h.beforeunload);
		this.hide_overlay();
		this.exit_fullscreen();
	}

	bind_route_guard() {
		if (!frappe.router || !frappe.router.on) return;
		frappe.router.on("change", () => {
			if (!this.lockdown) return;
			if (frappe.get_route()[0] !== "my-exams") {
				this.violation("route");
				frappe.set_route("my-exams");
			}
		});
	}

	block_keys(e) {
		const k = (e.key || "").toLowerCase();
		const mod = e.ctrlKey || e.metaKey;
		const in_field = /^(input|textarea)$/i.test((e.target && e.target.tagName) || "");
		const blocked =
			k === "f12" ||
			k === "f5" ||
			(mod && e.shiftKey && ["i", "j", "c"].includes(k)) ||
			(mod && ["c", "v", "x", "p", "s", "u", "f", "g", "r", "b", "j", "k", "h", "o"].includes(k)) ||
			(mod && !in_field && ["a", "z", "y"].includes(k)) ||
			(e.altKey && ["arrowleft", "arrowright"].includes(k));
		if (blocked) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	violation(reason) {
		if (!this.lockdown || this.submitting) return;
		const now = Date.now();
		// One action (e.g. Alt+Tab) fires blur + visibility + full-screen events together: count once.
		if (this.last_violation && now - this.last_violation < 2000) return;
		this.last_violation = now;

		this.violations++;
		this.update_warnings();
		this.call("log_violation", { submission: this.sub, reason }, { silent: true })
			.then((r) => {
				if (!r || this.submitting) return;
				this.violations = Math.max(this.violations, r.count);
				this.update_warnings();
				if (this.max_violations && this.violations >= this.max_violations) this.auto_submit_for_violations();
			})
			.catch(() => {});

		if (this.max_violations && this.violations >= this.max_violations) {
			this.auto_submit_for_violations();
			return;
		}
		const labels = {
			tab: __("You switched tab or minimised the browser."),
			blur: __("You left the exam window."),
			fullscreen: __("You exited full screen."),
			route: __("You tried to leave the exam page."),
		};
		this.show_overlay(labels[reason] || __("You left the exam."));
	}

	auto_submit_for_violations() {
		if (this.submitting) return;
		this.hide_overlay();
		frappe.show_alert({
			message: __("You left the exam {0} times. Your exam is being submitted.", [this.violations]),
			indicator: "red",
		});
		this.submit("Proctoring");
	}

	show_overlay(message) {
		this.hide_overlay();
		let note = __("This has been reported to your teacher.");
		if (this.max_violations) {
			const left = this.max_violations - this.violations;
			note =
				left === 1
					? __("If you leave the exam once more, it will be submitted automatically.")
					: __("{0} more and your exam will be submitted automatically.", [left]);
		}
		this.$overlay = $(`
			<div class="oe-overlay">
				<div class="oe-overlay-box">
					<h4>${
						this.max_violations
							? __("Warning {0} of {1}", [this.violations, this.max_violations])
							: __("Warning {0}", [this.violations])
					}</h4>
					<p>${message}</p>
					<p class="text-muted">${note}</p>
					<button class="btn btn-primary oe-return">${__("Return to exam")}</button>
				</div>
			</div>
		`).appendTo("body");
		this.$overlay.find(".oe-return").on("click", () => {
			this.enter_fullscreen();
			this.hide_overlay();
		});
	}

	hide_overlay() {
		if (this.$overlay) this.$overlay.remove();
		this.$overlay = null;
	}

	is_fullscreen() {
		return !!(document.fullscreenElement || document.webkitFullscreenElement);
	}

	enter_fullscreen() {
		if (!this.fs_supported || this.is_fullscreen()) return;
		const el = document.documentElement;
		const req = el.requestFullscreen || el.webkitRequestFullscreen;
		try {
			const p = req.call(el);
			if (p && p.catch) p.catch(() => {});
		} catch (e) {}
	}

	exit_fullscreen() {
		if (!this.is_fullscreen()) return;
		const exit = document.exitFullscreen || document.webkitExitFullscreen;
		try {
			const p = exit.call(document);
			if (p && p.catch) p.catch(() => {});
		} catch (e) {}
	}

	// =====================================================================
	add_styles() {
		if (document.getElementById("oe-styles")) return;
		$(`<style id="oe-styles">
			.oe-wrap { max-width: 1100px; margin: 0 auto; padding-bottom: 48px; }
			.oe-card { background: var(--card-bg); border: 1px solid var(--border-color);
				border-radius: var(--border-radius-md); padding: 16px 18px; margin-bottom: 12px; }
			.oe-empty, .oe-loading { text-align: center; padding: 40px 16px; }
			.oe-muted-box { color: var(--text-muted); background: var(--subtle-fg); border-radius: var(--border-radius-md);
				padding: 14px 16px; margin-bottom: 12px; }

			.oe-student { display: flex; gap: 14px; align-items: center; }
			.oe-avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--primary); color: #fff;
				display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 600; flex: none; }
			.oe-student-name { font-size: 17px; font-weight: 600; }
			.oe-student-meta { display: flex; flex-wrap: wrap; gap: 4px 18px; color: var(--text-muted); font-size: 13px; margin-top: 2px; }
			.oe-student-meta b { color: var(--text-color); font-weight: 500; margin-right: 4px; }

			.oe-section { margin-top: 20px; }
			.oe-section-title { font-weight: 600; font-size: 15px; margin-bottom: 8px; }
			.oe-exam-card { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
			.oe-exam-subject { font-weight: 600; font-size: 15px; }
			.oe-exam-title { margin-top: 2px; }
			.oe-exam-when { color: var(--text-muted); font-size: 13px; margin-top: 4px; }
			.oe-exam-status { margin-top: 8px; }
			.oe-tag { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 10px; background: var(--subtle-fg);
				color: var(--text-muted); margin-left: 6px; vertical-align: middle; }
			.oe-pill { display: inline-block; font-size: 12px; font-weight: 500; padding: 3px 10px; border-radius: 12px;
				font-variant-numeric: tabular-nums; }
			.oe-pill-blue { background: var(--blue-50, #eef5ff); color: var(--blue-700, #1d4ed8); }
			.oe-pill-green { background: var(--green-50, #ecfdf3); color: var(--green-700, #15803d); }
			.oe-pill-red { background: var(--red-50, #fef2f2); color: var(--red-700, #b91c1c); }
			.oe-pill-gray { background: var(--subtle-fg); color: var(--text-muted); }

			.oe-start-stats { display: flex; gap: 10px; margin-bottom: 14px; }
			.oe-start-stats div { flex: 1; text-align: center; background: var(--subtle-fg); border-radius: var(--border-radius);
				padding: 10px 6px; }
			.oe-start-stats b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
			.oe-start-stats span { font-size: 12px; color: var(--text-muted); }
			.oe-instructions { margin-bottom: 12px; max-height: 220px; overflow: auto; }
			.oe-rules { background: var(--subtle-fg); border-radius: var(--border-radius); padding: 10px 14px; font-size: 13px; }
			.oe-rules ul { margin: 6px 0 0; padding-left: 18px; }

			.oe-bar { position: sticky; top: var(--navbar-height, 48px); z-index: 5; display: flex; gap: 14px; align-items: center;
				background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius-md);
				padding: 10px 16px; margin-bottom: 12px; }
			.oe-bar-title { flex: 1; min-width: 0; }
			.oe-bar-exam { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.oe-bar-student { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
			.oe-timer { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
			.oe-warn { color: var(--orange-600, #d97706); }
			.oe-danger { color: var(--red-500); font-weight: 600; }
			.oe-warnings { font-size: 13px; }

			.oe-grid { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 12px; align-items: start; }
			.oe-side { position: sticky; top: calc(var(--navbar-height, 48px) + 76px); }
			.oe-qhead { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-weight: 600; margin-bottom: 10px; }
			.oe-qtype { font-weight: 400; color: var(--text-muted); font-size: 13px; }
			.oe-neg { color: var(--red-500); }
			.oe-question { font-size: 15px; line-height: 1.6; margin-bottom: 10px; }
			.oe-question img, .oe-qimg { max-width: 100%; height: auto; border-radius: var(--border-radius); }
			.oe-qimg { display: block; margin: 6px 0 12px; max-height: 420px; }
			.oe-answer { margin-top: 12px; }
			.oe-hint { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
			.oe-option { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--border-color);
				border-radius: var(--border-radius); margin-bottom: 8px; cursor: pointer; font-weight: normal; }
			.oe-option:hover { background: var(--fg-hover-color); }
			.oe-option.oe-selected { border-color: var(--primary); background: var(--subtle-accent, var(--fg-hover-color)); }
			.oe-option input { margin-top: 3px; }
			.oe-key { font-weight: 600; width: 16px; flex: none; }
			.oe-opt-body { flex: 1; min-width: 0; }
			.oe-opt-img { display: block; max-width: 100%; max-height: 180px; margin-top: 6px; }
			.oe-textarea { font-size: 15px; line-height: 1.5; }
			.oe-text-input { max-width: 420px; font-size: 15px; }
			.oe-wordcount { font-size: 12px; color: var(--text-muted); text-align: right; margin-top: 4px; }
			.oe-nav { display: flex; gap: 8px; flex-wrap: wrap; }
			.oe-nav .oe-next { margin-left: auto; }
			.oe-review-on { border-color: var(--purple-500, #8b5cf6) !important; color: var(--purple-600, #7c3aed); }

			.oe-side-title { font-weight: 600; margin-bottom: 8px; }
			.oe-palette { display: grid; grid-template-columns: repeat(auto-fill, minmax(36px, 1fr)); gap: 6px; }
			.oe-pal { height: 34px; border: 1px solid var(--border-color); border-radius: var(--border-radius); background: var(--card-bg);
				font-size: 13px; font-variant-numeric: tabular-nums; }
			.oe-pal.oe-answered { background: var(--green-500, #22c55e); border-color: var(--green-500, #22c55e); color: #fff; }
			.oe-pal.oe-marked { background: var(--purple-500, #8b5cf6); border-color: var(--purple-500, #8b5cf6); color: #fff; }
			.oe-pal.oe-current { outline: 2px solid var(--text-color); outline-offset: 1px; }
			.oe-legend { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); margin-top: 12px; }
			.oe-dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; border: 1px solid var(--border-color);
				margin-right: 6px; vertical-align: -1px; }
			.oe-dot.oe-answered { background: var(--green-500, #22c55e); border-color: transparent; }
			.oe-dot.oe-marked { background: var(--purple-500, #8b5cf6); border-color: transparent; }
			.oe-save-state { font-size: 12px; margin-top: 10px; }

			.oe-pad-tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
			.oe-pad-tools .btn.active { background: var(--primary); color: #fff; }
			.oe-swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid var(--card-bg);
				box-shadow: 0 0 0 1px var(--border-color); cursor: pointer; padding: 0; }
			.oe-swatch.active { box-shadow: 0 0 0 2px var(--text-color); }
			.oe-pad-stage { position: relative; width: 100%; aspect-ratio: 16 / 10; background: #fff;
				border: 1px solid var(--border-color); border-radius: var(--border-radius); overflow: hidden; }
			.oe-pad-stage img, .oe-pad-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
			.oe-pad-stage img { object-fit: contain; pointer-events: none; }
			.oe-pad-stage canvas { touch-action: none; cursor: crosshair; }

			.oe-result { max-width: 480px; margin: 40px auto; text-align: center; }
			.oe-result-score { font-size: 40px; font-weight: 700; margin: 10px 0; font-variant-numeric: tabular-nums; }
			.oe-result-score span { font-size: 20px; color: var(--text-muted); font-weight: 500; }
			.oe-result .oe-back { margin-top: 16px; }

			body.oe-lockdown .navbar, body.oe-lockdown .page-head { display: none !important; }
			body.oe-lockdown .oe-bar { top: 0; }
			body.oe-lockdown .oe-side { top: 76px; }
			body.oe-lockdown .oe-wrap { padding-top: 12px; user-select: none; -webkit-user-select: none; }
			body.oe-lockdown .oe-wrap textarea, body.oe-lockdown .oe-wrap input { user-select: text; -webkit-user-select: text; }
			.oe-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(0, 0, 0, .75); display: flex;
				align-items: center; justify-content: center; padding: 16px; }
			.oe-overlay-box { background: var(--card-bg); border-radius: var(--border-radius-lg, 12px); padding: 24px;
				max-width: 420px; text-align: center; }
			.oe-overlay-box h4 { color: var(--red-500); }

			@media (max-width: 860px) {
				.oe-grid { grid-template-columns: 1fr; }
				.oe-side { position: static; }
				.oe-bar { flex-wrap: wrap; }
				.oe-timer { font-size: 18px; }
			}
		</style>`).appendTo("head");
	}
}

// =========================================================================
// Drawing answer: pen/eraser on a transparent layer over an optional background
// =========================================================================
class OEDrawingPad {
	constructor($container, opts) {
		this.opts = opts;
		this.color = "#111111";
		this.size = 3;
		this.tool = "pen";
		this.undo_stack = [];
		this.has_ink = false;

		const colors = ["#111111", "#2563eb", "#dc2626", "#16a34a", "#d97706"];
		this.$el = $(`
			<div class="oe-pad">
				<div class="oe-pad-tools">
					<button class="btn btn-default btn-xs active" data-tool="pen">${__("Pen")}</button>
					<button class="btn btn-default btn-xs" data-tool="eraser">${__("Eraser")}</button>
					<span style="width:6px"></span>
					${colors
						.map(
							(c, i) =>
								`<button class="oe-swatch ${i === 0 ? "active" : ""}" data-color="${c}" style="background:${c}" title="${c}"></button>`
						)
						.join("")}
					<span style="width:6px"></span>
					<select class="form-control input-xs oe-pad-size" style="width:auto">
						<option value="2">${__("Thin")}</option>
						<option value="3" selected>${__("Medium")}</option>
						<option value="6">${__("Thick")}</option>
					</select>
					<span style="flex:1"></span>
					<button class="btn btn-default btn-xs oe-pad-undo">${__("Undo")}</button>
					<button class="btn btn-default btn-xs oe-pad-clear">${__("Clear")}</button>
				</div>
				<div class="oe-pad-stage">
					${opts.background ? `<img src="${oe_esc(opts.background)}" alt="">` : ""}
					<canvas width="${OE_PAD_W}" height="${OE_PAD_H}"></canvas>
				</div>
			</div>
		`).appendTo($container);

		this.canvas = this.$el.find("canvas").get(0);
		this.ctx = this.canvas.getContext("2d");
		this.bind_tools();
		this.bind_pointer();

		const initial = opts.initial_layer || opts.initial_url;
		if (initial) {
			const img = new Image();
			img.onload = () => {
				this.ctx.drawImage(img, 0, 0, OE_PAD_W, OE_PAD_H);
				this.has_ink = true;
			};
			img.src = initial;
		}
	}

	bind_tools() {
		this.$el.find("[data-tool]").on("click", (e) => {
			this.tool = $(e.currentTarget).attr("data-tool");
			this.$el.find("[data-tool]").removeClass("active");
			$(e.currentTarget).addClass("active");
		});
		this.$el.find(".oe-swatch").on("click", (e) => {
			this.color = $(e.currentTarget).attr("data-color");
			this.$el.find(".oe-swatch").removeClass("active");
			$(e.currentTarget).addClass("active");
			this.$el.find('[data-tool="pen"]').trigger("click");
		});
		this.$el.find(".oe-pad-size").on("change", (e) => (this.size = cint(e.target.value) || 3));
		this.$el.find(".oe-pad-undo").on("click", () => this.undo());
		this.$el.find(".oe-pad-clear").on("click", () => this.clear());
	}

	bind_pointer() {
		const c = this.canvas;
		const pos = (e) => {
			const r = c.getBoundingClientRect();
			return {
				x: ((e.clientX - r.left) * OE_PAD_W) / r.width,
				y: ((e.clientY - r.top) * OE_PAD_H) / r.height,
			};
		};
		c.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			c.setPointerCapture(e.pointerId);
			this.push_undo();
			this.drawing = true;
			this.last = pos(e);
			this.stroke(this.last, this.last);
		});
		c.addEventListener("pointermove", (e) => {
			if (!this.drawing) return;
			const p = pos(e);
			this.stroke(this.last, p);
			this.last = p;
		});
		const end = () => {
			if (!this.drawing) return;
			this.drawing = false;
			this.changed();
		};
		c.addEventListener("pointerup", end);
		c.addEventListener("pointercancel", end);
	}

	stroke(a, b) {
		const ctx = this.ctx;
		ctx.globalCompositeOperation = this.tool === "eraser" ? "destination-out" : "source-over";
		ctx.strokeStyle = this.color;
		ctx.lineWidth = this.tool === "eraser" ? this.size * 6 : this.size;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x + 0.01, b.y + 0.01);
		ctx.stroke();
		if (this.tool === "pen") this.has_ink = true;
	}

	push_undo() {
		this.undo_stack.push(this.ctx.getImageData(0, 0, OE_PAD_W, OE_PAD_H));
		if (this.undo_stack.length > 20) this.undo_stack.shift();
	}

	undo() {
		const snap = this.undo_stack.pop();
		if (!snap) return;
		this.ctx.putImageData(snap, 0, 0);
		this.has_ink = !this.is_blank();
		this.changed();
	}

	clear() {
		this.push_undo();
		this.ctx.clearRect(0, 0, OE_PAD_W, OE_PAD_H);
		this.has_ink = false;
		this.changed();
	}

	is_blank() {
		const d = this.ctx.getImageData(0, 0, OE_PAD_W, OE_PAD_H).data;
		for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
		return true;
	}

	changed() {
		this.pending = true;
		clearTimeout(this._t);
		this._t = setTimeout(() => this.flush(), 700);
	}

	// Push the current layer to the exam (called on a timer, before navigation and before submit).
	flush() {
		clearTimeout(this._t);
		if (!this.pending) return;
		this.pending = false;
		const layer = this.has_ink ? this.canvas.toDataURL("image/png") : null;
		this.opts.on_change && this.opts.on_change(layer);
	}

	destroy() {
		clearTimeout(this._t);
		this.$el.remove();
	}

	// White background + optional background image (contain) + the student's layer → PNG data URL.
	static compose(layer_url, background_url) {
		const load = (src) =>
			new Promise((resolve) => {
				if (!src) return resolve(null);
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = () => resolve(null);
				img.src = src;
			});
		return Promise.all([load(background_url), load(layer_url)]).then(([bg, layer]) => {
			const W = OE_PAD_W;
			const H = OE_PAD_H;
			const c = document.createElement("canvas");
			c.width = W;
			c.height = H;
			const ctx = c.getContext("2d");
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, W, H);
			if (bg) {
				const s = Math.min(W / bg.naturalWidth, H / bg.naturalHeight);
				const w = bg.naturalWidth * s;
				const h = bg.naturalHeight * s;
				ctx.drawImage(bg, (W - w) / 2, (H - h) / 2, w, h);
			}
			if (layer) ctx.drawImage(layer, 0, 0, W, H);
			return c.toDataURL("image/png");
		});
	}
}
