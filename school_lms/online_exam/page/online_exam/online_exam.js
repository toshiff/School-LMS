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
		this.lockdown = false;
		this.fs_supported = !!(
			document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen
		);
		this.add_styles();
		this.bind_route_guard();
		this.show_start();
	}

	// ---------- start screen ----------
	show_start() {
		this.disable_lockdown();
		this.stop_timer();
		this.page.clear_primary_action();
		this.$body.html(`
			<div class="oe-card oe-start">
				<h4>${__("Start an exam")}</h4>
				<p class="text-muted">${__("5 questions · 10 minutes. The exam submits itself when time runs out.")}</p>
				<div class="oe-rules">
					<b>${__("Exam rules")}</b>
					<ul>
						<li>${__("The exam opens in full screen. Stay on this screen until you submit.")}</li>
						<li>${__("Switching tabs or windows, minimising, or leaving full screen is recorded as a warning.")}</li>
						<li>${__("Closing or reloading the exam page also counts as a warning.")}</li>
						<li>${__("After {0} warnings your exam is submitted automatically.", [3])}</li>
					</ul>
				</div>
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

		this.$body.find(".oe-start-btn").on("click", (e) => {
			const class_name = this.$body.find(".oe-class").val();
			if (!class_name) {
				frappe.msgprint(__("Please select a class."));
				return;
			}
			const $btn = $(e.currentTarget).prop("disabled", true);
			// Must be called directly inside the click, or the browser refuses full screen.
			this.enter_fullscreen();
			frappe.call({
				method: "school_lms.api.start_exam",
				args: { class_name },
				freeze: true,
				freeze_message: __("Loading your paper…"),
				callback: (r) => r.message && this.show_exam(r.message),
				error: () => {
					$btn.prop("disabled", false);
					this.exit_fullscreen();
				},
			});
		});
	}

	// ---------- exam screen ----------
	show_exam(data) {
		this.data = data;
		this.submitting = false;
		this.violations = data.violation_count || 0;
		this.max_violations = data.max_violations || 3;
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
				<span class="oe-warnings"></span>
				<span class="oe-timer">--:--</span>
				<button class="btn btn-primary btn-sm oe-submit-btn">${__("Submit")}</button>
			</div>
			${cards}
			<div class="oe-footer">
				<button class="btn btn-primary btn-lg oe-submit-btn">${__("Submit Exam")}</button>
			</div>
		`);

		this.$body.off("change").on("change", "input[type=radio]", (e) => {
			const $r = $(e.currentTarget);
			this.answers[$r.attr("data-q")] = $r.val();
			this.save_answers();
			this.update_progress();
		});
		this.$body.find(".oe-submit-btn").on("click", () => this.confirm_submit());

		this.update_progress();
		this.update_warnings();
		this.enable_lockdown();
		this.start_timer(data.remaining_seconds);

		if (this.violations >= this.max_violations) {
			this.auto_submit_for_violations();
		} else if (this.violations > 0) {
			// Came back after closing/reloading the page.
			this.show_overlay(__("You left the exam page."));
		}
	}

	update_progress() {
		const done = this.data.questions.filter((q) => this.answers[q.name]).length;
		this.$body.find(".oe-progress").text(__("Answered {0} of {1}", [done, this.data.questions.length]));
	}

	update_warnings() {
		this.$body
			.find(".oe-warnings")
			.text(__("Warnings {0}/{1}", [this.violations, this.max_violations]))
			.toggleClass("oe-danger", this.violations > 0);
	}

	// ---------- lockdown ----------
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
		["contextmenu", "copy", "cut", "paste", "dragstart"].forEach((ev) =>
			document.addEventListener(ev, this.h.block, true)
		);
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
		["contextmenu", "copy", "cut", "paste", "dragstart"].forEach((ev) =>
			document.removeEventListener(ev, this.h.block, true)
		);
		window.removeEventListener("beforeunload", this.h.beforeunload);
		this.hide_overlay();
		this.exit_fullscreen();
	}

	bind_route_guard() {
		// Browser Back button or a Desk link would leave the page without unloading it.
		if (!frappe.router || !frappe.router.on) return;
		frappe.router.on("change", () => {
			if (!this.lockdown) return;
			if (frappe.get_route()[0] !== "online-exam") {
				this.violation("route");
				frappe.set_route("online-exam");
			}
		});
	}

	block_keys(e) {
		const k = (e.key || "").toLowerCase();
		const mod = e.ctrlKey || e.metaKey;
		const blocked =
			k === "f12" ||
			k === "f5" ||
			(mod && e.shiftKey && ["i", "j", "c"].includes(k)) || // dev tools
			(mod && ["c", "v", "x", "a", "p", "s", "u", "f", "g", "r", "b", "j", "k"].includes(k)) ||
			(e.altKey && ["arrowleft", "arrowright"].includes(k)); // back/forward
		if (blocked) {
			e.preventDefault();
			e.stopPropagation(); // also stops Frappe's own Ctrl+G, Ctrl+B... shortcuts
		}
	}

	violation(reason) {
		if (!this.lockdown || this.submitting) return;
		// One action (e.g. Alt+Tab) fires blur + visibility + fullscreen events together: count once.
		const now = Date.now();
		if (this.last_violation && now - this.last_violation < 2000) return;
		this.last_violation = now;

		this.violations++;
		this.update_warnings();

		frappe.call({
			method: "school_lms.api.log_violation",
			args: { submission: this.data.submission, reason },
			callback: (r) => {
				if (!r.message || this.submitting) return;
				this.violations = Math.max(this.violations, r.message.count);
				this.update_warnings();
				if (this.violations >= this.max_violations) this.auto_submit_for_violations();
			},
		});

		if (this.violations >= this.max_violations) {
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
		this.submit(true);
	}

	show_overlay(message) {
		this.hide_overlay();
		const left = this.max_violations - this.violations;
		this.$overlay = $(`
			<div class="oe-overlay">
				<div class="oe-overlay-box">
					<h4>${__("Warning {0} of {1}", [this.violations, this.max_violations])}</h4>
					<p>${message}</p>
					<p class="text-muted">${
						left === 1
							? __("If you leave the exam once more, it will be submitted automatically.")
							: __("{0} more and your exam will be submitted automatically.", [left])
					}</p>
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
		this.hide_overlay();
		this.$body.find(".oe-submit-btn").prop("disabled", true);

		frappe.call({
			method: "school_lms.api.submit_exam",
			args: { submission: this.data.submission, answers: JSON.stringify(this.answers) },
			freeze: true,
			freeze_message: __("Submitting…"),
			callback: (r) => {
				this.clear_answers();
				this.disable_lockdown();
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
			.oe-start { max-width: 520px; margin: 30px auto; }
			.oe-rules { background: var(--bg-light-gray, var(--subtle-fg)); border-radius: var(--border-radius);
				padding: 10px 14px; margin: 12px 0 16px; font-size: 13px; }
			.oe-rules ul { margin: 6px 0 0; padding-left: 18px; }
			.oe-bar { position: sticky; top: var(--navbar-height, 48px); z-index: 5; display: flex; gap: 16px;
				justify-content: space-between; align-items: center; background: var(--card-bg);
				border: 1px solid var(--border-color); border-radius: var(--border-radius-md);
				padding: 10px 16px; margin-bottom: 14px; }
			.oe-timer { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-left: auto; }
			.oe-danger { color: var(--red-500); font-weight: 600; }
			.oe-qhead { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 8px; }
			.oe-question { white-space: pre-wrap; margin-bottom: 12px; font-size: 15px; }
			.oe-option { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
				border: 1px solid var(--border-color); border-radius: var(--border-radius);
				margin-bottom: 8px; cursor: pointer; font-weight: normal; }
			.oe-option:hover { background: var(--fg-hover-color); }
			.oe-option input { margin: 0; }
			.oe-key { font-weight: 600; width: 18px; }
			.oe-footer { text-align: center; margin-top: 20px; }

			/* Lockdown: hide Desk navigation while the exam runs */
			body.oe-lockdown .navbar,
			body.oe-lockdown .page-head { display: none !important; }
			body.oe-lockdown .oe-bar { top: 0; }
			body.oe-lockdown .oe-wrap { padding-top: 16px; user-select: none; -webkit-user-select: none; }
			body.oe-lockdown { background: var(--bg-color); }
			.oe-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,.75);
				display: flex; align-items: center; justify-content: center; padding: 16px; }
			.oe-overlay-box { background: var(--card-bg); border-radius: var(--border-radius-lg, 12px);
				padding: 24px; max-width: 420px; text-align: center; }
			.oe-overlay-box h4 { color: var(--red-500); }
		</style>`).appendTo("head");
	}
}
