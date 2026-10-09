frappe.pages["online-exam"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Online Exam"),
		single_column: true,
	});
	wrapper.online_exam = new OnlineExam(page);
};

class OnlineExam {
	constructor(page) {
		this.page = page;
		this.$body = $(`<div class="oe-wrap"></div>`).appendTo(page.main);
		this.add_styles();
		this.show_start();
	}

	// ---------- start screen ----------
	show_start() {
		this.stop_timer();
		this.page.clear_primary_action();
		this.$body.html(`
			<div class="oe-card oe-start">
				<h4>${__("Start an exam")}</h4>
				<p class="text-muted">${__("5 questions · 10 minutes. The exam submits itself when time runs out.")}</p>
				<div class="form-group">
					<label>${__("Class")}</label>
					<select class="form-control oe-class"><option value="">${__("Loading…")}</option></select>
				</div>
				<button class="btn btn-primary oe-start-btn">${__("Start Exam")}</button>
			</div>
		`);

		frappe.call("school_lms.api.get_classes").then((r) => {
			const opts = (r.message || [])
				.map((c) => `<option value="${frappe.utils.escape_html(c)}">${frappe.utils.escape_html(c)}</option>`)
				.join("");
			this.$body.find(".oe-class").html(`<option value="">${__("Select class")}</option>${opts}`);
		});

		this.$body.find(".oe-start-btn").on("click", () => {
			const class_name = this.$body.find(".oe-class").val();
			if (!class_name) {
				frappe.msgprint(__("Please select a class."));
				return;
			}
			frappe.call({
				method: "school_lms.api.start_exam",
				args: { class_name },
				freeze: true,
				freeze_message: __("Loading your paper…"),
				callback: (r) => r.message && this.show_exam(r.message),
			});
		});
	}

	// ---------- exam screen ----------
	show_exam(data) {
		this.data = data;
		this.submitting = false;
		this.storage_key = `oe_answers_${data.submission}`;
		this.answers = this.load_answers();

		const esc = frappe.utils.escape_html;
		const cards = data.questions
			.map((q, i) => {
				const opts = ["A", "B", "C", "D"]
					.map(
						(k) => `
					<label class="oe-option">
						<input type="radio" name="oe-q-${i}" data-q="${esc(q.name)}" value="${k}"
							${this.answers[q.name] === k ? "checked" : ""}>
						<span class="oe-key">${k}</span>
						<span class="oe-text">${esc(q.options[k] || "")}</span>
					</label>`
					)
					.join("");
				return `
				<div class="oe-card">
					<div class="oe-qhead">
						<span>${__("Question {0}", [i + 1])}</span>
						<span class="text-muted">${__("{0} mark(s)", [q.marks])}</span>
					</div>
					<div class="oe-question">${esc(q.question)}</div>
					${opts}
				</div>`;
			})
			.join("");

		this.$body.html(`
			<div class="oe-bar">
				<span class="oe-progress"></span>
				<span class="oe-timer">--:--</span>
			</div>
			${cards}
			<div class="oe-footer">
				<button class="btn btn-primary btn-lg oe-submit-btn">${__("Submit Exam")}</button>
			</div>
		`);

		this.$body.on("change", "input[type=radio]", (e) => {
			const $r = $(e.currentTarget);
			this.answers[$r.attr("data-q")] = $r.val();
			this.save_answers();
			this.update_progress();
		});
		this.$body.find(".oe-submit-btn").on("click", () => this.confirm_submit());
		this.page.set_primary_action(__("Submit"), () => this.confirm_submit());

		this.update_progress();
		this.start_timer(data.remaining_seconds);
	}

	update_progress() {
		const done = this.data.questions.filter((q) => this.answers[q.name]).length;
		this.$body.find(".oe-progress").text(__("Answered {0} of {1}", [done, this.data.questions.length]));
	}

	// ---------- timer ----------
	start_timer(seconds) {
		this.stop_timer();
		// Counted from the server's remaining seconds, so the PC clock doesn't matter.
		this.end_at = Date.now() + seconds * 1000;
		const tick = () => {
			const left = Math.max(0, Math.ceil((this.end_at - Date.now()) / 1000));
			const mm = String(Math.floor(left / 60)).padStart(2, "0");
			const ss = String(left % 60).padStart(2, "0");
			this.$body.find(".oe-timer").text(`${mm}:${ss}`).toggleClass("oe-danger", left <= 60);
			if (left === 0) {
				this.stop_timer();
				frappe.show_alert({ message: __("Time is up. Submitting…"), indicator: "orange" });
				this.submit(true);
			}
		};
		tick();
		this.timer = setInterval(tick, 500);
	}

	stop_timer() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	// ---------- submit ----------
	confirm_submit() {
		const total = this.data.questions.length;
		const done = this.data.questions.filter((q) => this.answers[q.name]).length;
		const msg =
			done < total
				? __("You have answered {0} of {1} questions. Submit anyway?", [done, total])
				: __("Submit your exam? You can't change answers after this.");
		frappe.confirm(msg, () => this.submit(false));
	}

	submit(auto, attempt = 1) {
		if (this.submitting && attempt === 1) return;
		this.submitting = true;
		this.stop_timer();
		this.page.clear_primary_action();
		this.$body.find(".oe-submit-btn").prop("disabled", true);

		frappe.call({
			method: "school_lms.api.submit_exam",
			args: { submission: this.data.submission, answers: JSON.stringify(this.answers) },
			freeze: true,
			freeze_message: __("Submitting…"),
			callback: (r) => {
				this.clear_answers();
				this.show_result(r.message || {});
			},
			error: () => {
				// Slow or dropped network: retry a few times inside the server's grace period.
				if (attempt < 5) {
					frappe.show_alert({ message: __("Network problem, retrying…"), indicator: "orange" });
					setTimeout(() => this.submit(auto, attempt + 1), 3000);
				} else {
					this.submitting = false;
					this.$body.find(".oe-submit-btn").prop("disabled", false);
				}
			},
		});
	}

	show_result(res) {
		this.page.clear_primary_action();
		const body =
			res.status === "Submitted"
				? `<h3>${__("Score: {0} / {1}", [res.score, res.total_marks])}</h3>`
				: `<p>${frappe.utils.escape_html(res.message || __("Exam closed."))}</p>`;
		this.$body.html(`
			<div class="oe-card oe-start">
				<h4>${__("Exam submitted")}</h4>
				${body}
				<button class="btn btn-default oe-back">${__("Back")}</button>
			</div>
		`);
		this.$body.off("change");
		this.$body.find(".oe-back").on("click", () => this.show_start());
	}

	// ---------- local backup of answers (survives a page refresh) ----------
	load_answers() {
		try {
			return JSON.parse(localStorage.getItem(this.storage_key) || "{}");
		} catch (e) {
			return {};
		}
	}
	save_answers() {
		try {
			localStorage.setItem(this.storage_key, JSON.stringify(this.answers));
		} catch (e) {}
	}
	clear_answers() {
		try {
			localStorage.removeItem(this.storage_key);
		} catch (e) {}
	}

	add_styles() {
		if (document.getElementById("oe-styles")) return;
		$(`<style id="oe-styles">
			.oe-wrap { max-width: 820px; margin: 0 auto; padding-bottom: 40px; }
			.oe-card { background: var(--card-bg); border: 1px solid var(--border-color);
				border-radius: var(--border-radius-md); padding: 18px 20px; margin-bottom: 14px; }
			.oe-start { max-width: 460px; margin: 30px auto; }
			.oe-bar { position: sticky; top: var(--navbar-height, 48px); z-index: 5; display: flex;
				justify-content: space-between; align-items: center; background: var(--card-bg);
				border: 1px solid var(--border-color); border-radius: var(--border-radius-md);
				padding: 10px 16px; margin-bottom: 14px; }
			.oe-timer { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
			.oe-timer.oe-danger { color: var(--red-500); }
			.oe-qhead { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 8px; }
			.oe-question { white-space: pre-wrap; margin-bottom: 12px; font-size: 15px; }
			.oe-option { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
				border: 1px solid var(--border-color); border-radius: var(--border-radius);
				margin-bottom: 8px; cursor: pointer; font-weight: normal; }
			.oe-option:hover { background: var(--fg-hover-color); }
			.oe-option input { margin: 0; }
			.oe-key { font-weight: 600; width: 18px; }
			.oe-footer { text-align: center; margin-top: 20px; }
		</style>`).appendTo("head");
	}
}
