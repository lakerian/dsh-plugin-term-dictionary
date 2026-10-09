"use strict";

/**
 * The dictionary panel's React views.
 *
 * Layout follows the host's management pages: a titled header with a search
 * field and filter tabs, then a scrolling list of rows, then a detail editor
 * that replaces the list rather than opening a modal over it. Every color,
 * radius and border comes from a `--dsw-alias-*` / `--dsw-radius-*` theme token,
 * so light and dark themes follow without a second code path.
 *
 * The panel reaches the dictionary only through the injected `store`, which is
 * what keeps this file free of the detector and the host API.
 */

const React = require("react");
const { SEARCH_INPUT_STYLE, applyStyles } = require("./styles.js");
const { formatStamp } = require("./core.js");

const h = React.createElement;

/** How long a revealed entry stays marked after a transcript click opens it. */
const REVEAL_FLASH_MS = 2600;

/** The compact glyph the sidebar's panel list renders (and its collapsed rail). */
function DictionaryGlyph(props) {
	const size = typeof props?.size === "number" ? props.size : 16;
	const active = props?.active === true;
	return h(
		"svg",
		{
			width: size,
			height: size,
			viewBox: "0 0 20 20",
			fill: "none",
			"aria-hidden": "true",
			style: { display: "block", color: active ? "var(--dsw-alias-label-primary)" : "inherit" }
		},
		h("path", {
			d: "M10 5.1c-1.05-.85-2.4-1.25-4.1-1.25-.42 0-.68.26-.68.68v7.05c0 .42.26.68.68.68 1.7 0 3.05.4 4.1 1.25",
			stroke: "currentColor",
			strokeWidth: 1.5,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		}),
		h("path", {
			d: "M10 5.1c1.05-.85 2.4-1.25 4.1-1.25.42 0 .68.26.68.68v7.05c0 .42-.26.68-.68.68-1.7 0-3.05.4-4.1 1.25",
			stroke: "currentColor",
			strokeWidth: 1.5,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		}),
		h("path", { d: "M10 5.1v8.41", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" })
	);
}

/** A small inline icon set, drawn to match the host's outline controls. */
const Icons = {
	search: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("circle", { cx: 7, cy: 7, r: 4.4, stroke: "currentColor", strokeWidth: 1.4 }),
			h("path", { d: "M10.4 10.4 14 14", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" })
		),
	close: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("path", { d: "M4 4l8 8M12 4l-8 8", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" })
		),
	pin: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("path", {
				d: "M6 2h4l-.6 3.2 2.1 2.1H4.5l2.1-2.1L6 2Z",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinejoin: "round"
			}),
			h("path", { d: "M8 7.3V14", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
		),
	edit: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("path", {
				d: "M10.6 2.9l2.5 2.5-7 7-3 .5.5-3 7-7Z",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinejoin: "round"
			})
		),
	trash: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("path", { d: "M3 4.5h10M6.2 4.5V3h3.6v1.5M4.4 4.5l.6 8h6l.6-8", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" })
		),
	/** A flag: "there is something to say about this entry". */
	flag: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("path", {
				d: "M4 2.6v10.8M4 3.4h7.4l-1.3 2.5 1.3 2.5H4",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			})
		),
	/** Two sheets: copy this entry's text. */
	copy: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("rect", { x: 5.4, y: 5.4, width: 7.2, height: 7.6, rx: 1.4, stroke: "currentColor", strokeWidth: 1.3 }),
			h("path", { d: "M10.6 4.2V3.6A1.4 1.4 0 0 0 9.2 2.2H4.6A1.4 1.4 0 0 0 3.2 3.6v6.2a1.4 1.4 0 0 0 1.4 1.4h.8", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
		),
	sparkle: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("path", { d: "M8 2.2l1.3 3.5L12.8 7l-3.5 1.3L8 11.8 6.7 8.3 3.2 7l3.5-1.3L8 2.2Z", stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round" })
		),
	plus: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("path", { d: "M8 3.2v9.6M3.2 8h9.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" })
		),
	/** A checked box, used both for "pick rows" and for a picked row. */
	select: (size) =>
		h(
			"svg",
			{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			h("rect", { x: 2.6, y: 2.6, width: 10.8, height: 10.8, rx: 2.4, stroke: "currentColor", strokeWidth: 1.3 }),
			h("path", { d: "M5.4 8.2 7.3 10.1l3.5-3.9", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" })
		)
};

/** Settings used when the panel is rendered without a settings store (tests, odd hosts). */
const FALLBACK_SETTINGS = { autoCollect: true, autoAnnotate: true, autoExplain: true, explainLang: "auto", explainDepth: "normal", explainParagraph: true, collectMinLength: 4, collectIdentifiers: false, collectCjk: true };

/** The accepted preference values, so the page offers exactly what the store validates. */
const { EXPLAIN_LANGS, EXPLAIN_DEPTHS, COLLECT_LENGTHS, HOVER_DELAY_MIN, HOVER_DELAY_MAX, HOVER_DELAY_STEP } = require("./settings.js");
const { buildExport, buildFeedbackReport, parseImport, planImport, domainsIn } = require("./transfer.js");
const { FEEDBACK_KINDS, isFlagged, entryAsText } = require("./entries.js");
const { selectionInside } = require("./selection.js");

/** A subscribe that never fires, so the hook order stays the same without a store. */
const NO_SUBSCRIPTION = () => () => {};

/**
 * A two-state preference, as a switch.
 *
 * `role="switch"` with `aria-checked`, so assistive technology reports a state rather than an
 * anonymous button — the state is carried by the control, not by its text.
 *
 * @param props - `checked`, `title`, `onToggle`.
 * @returns the switch element.
 */
function ToggleSwitch(props) {
	return h(
		"button",
		{
			type: "button",
			role: "switch",
			"aria-checked": props.checked === true,
			"aria-label": props.title,
			title: props.title,
			onClick: props.onToggle,
			style: { ...applyStyles.toggleTrack, ...(props.checked === true ? applyStyles.toggleTrackOn : null) }
		},
		h("span", { style: { ...applyStyles.toggleKnob, ...(props.checked === true ? applyStyles.toggleKnobOn : null) } })
	);
}

/**
 * A preference with more than two values, as an option bar.
 *
 * A radiogroup rather than a set of independent buttons: exactly one value is in effect, and that
 * is what the roles say.
 *
 * @param props - `label`, `options` (`[{ value, label }]`), `value`, `onSelect`.
 * @returns the option bar element.
 */
function OptionBar(props) {
	const { label, options, value, onSelect } = props;
	return h(
		"div",
		{ style: applyStyles.optionBar, role: "radiogroup", "aria-label": label },
		options.map((option) =>
			h(
				"button",
				{
					key: String(option.value),
					type: "button",
					role: "radio",
					"aria-checked": option.value === value,
					"data-value": String(option.value),
					title: option.label,
					onClick: () => onSelect(option.value),
					style: { ...applyStyles.optionItem, ...(option.value === value ? applyStyles.optionItemActive : null) }
				},
				option.label
			)
		)
	);
}

/**
 * A delay setting: a slider, and a box to type the number.
 *
 * The third control shape, and it exists because the value is a NUMBER IN A RANGE rather than one of
 * a few named choices: a switch cannot express 110ms, and an option bar over 0–200 in steps of ten
 * would be twenty-one buttons. The two inputs are ONE control — the slider is for finding a feel,
 * the box for entering a number you already know — so both write the same value, and the box is
 * clamped by the store rather than by a second set of rules living here.
 *
 * @param props - `label`, `value`, `min`, `max`, `step`, `unit`, `onChange`.
 * @returns the row's control.
 */
function DelayField(props) {
	const { label, value, min, max, step, unit, onChange } = props;
	const number = typeof value === "number" && Number.isFinite(value) ? value : min;
	return h(
		"div",
		{ style: applyStyles.delayField },
		h("input", {
			type: "range",
			"aria-label": label,
			title: label,
			min,
			max,
			step,
			value: number,
			onChange: (event) => onChange(Number.parseInt(event.target.value, 10)),
			style: applyStyles.delaySlider
		}),
		h("input", {
			type: "number",
			"aria-label": label,
			title: label,
			min,
			max,
			step: 1,
			value: number,
			onChange: (event) => onChange(Number.parseInt(event.target.value, 10)),
			style: applyStyles.delayBox
		}),
		h("span", { style: applyStyles.delayUnit }, unit)
	);
}

/**
 * Import and export, as a page of the panel.
 *
 * The decisions this page only carries out live in `transfer.js`: what a file holds, what a scope
 * selects, and what happens to an entry that cannot be taken. What is here is the wiring — a file
 * input, a download, and a report the user can read.
 *
 * Two things are deliberate:
 *
 *  - the export offers **all** or **by category**, and by category starts from the categories the
 *    dictionary actually has (`domainsIn`). A checkbox list of invented categories would be a menu
 *    of things nobody wrote;
 *  - the import REPORTS what it passed over. "12 imported" and "12 imported, 3 already here, 2 you
 *    deleted" are different facts, and only the second one is the truth.
 *
 * @param props - `store`, `t`.
 * @returns the transfer page.
 */
function TransferPage(props) {
	const { store, t } = props;
	const [scope, setScope] = React.useState("all");
	const [chosen, setChosen] = React.useState([]);
	const [report, setReport] = React.useState(null);
	const [busy, setBusy] = React.useState(false);
	/**
	 * Whether the import also takes the entries the user deleted.
	 *
	 * Off by default and asked for explicitly, because the tombstone list IS the blacklist: a file
	 * containing those terms is not a reason to empty it. Tick it and they come back with the file's
	 * text; leave it and they stay struck out, and the report says how many that was.
	 */
	const [includeDeleted, setIncludeDeleted] = React.useState(false);
	/**
	 * Whether the feedback report carries the explanation each remark is about.
	 *
	 * Off by default. A remark without its text is harder to act on, and the text is the user's own
	 * dictionary — but it is still text they did not write in the report, so attaching it is a choice
	 * rather than a default. The conversation context is never in the report at all; that is not a
	 * choice this page offers.
	 */
	const [includeGloss, setIncludeGloss] = React.useState(false);
	/**
	 * What came back from the host's own feedback channel, or null when nothing was sent yet.
	 *
	 * Six outcomes, and the page says all six differently: sending, recorded, this build has no channel,
	 * the session is gone, no conversation has been seen yet, and anything else. Collapsing them into
	 * "failed" is how a user ends up retrying something that cannot work.
	 */
	const [feedbackState, setFeedbackState] = React.useState(null);
	const entries = store.getState().entries ?? [];
	const domains = domainsIn(entries);
	const flagged = entries.filter((entry) => isFlagged(entry));

	/** The text the export would write, given the current choices. */
	const textOf = () => JSON.stringify(buildExport(entries, { scope, domains: chosen }, Date.now()), null, 2);

	/** The feedback report the page would write, given the current choices. */
	const feedbackTextOf = () => JSON.stringify(buildFeedbackReport(entries, { now: Date.now(), includeGloss }), null, 2);

	/**
	 * The one line the host's feedback channel would record.
	 *
	 * A summary rather than the report: the host's log is a session-level remark, and pasting a whole
	 * JSON document into it would bury the remark. The term, the category and the user's own note are
	 * what the plugin can offer to say — and the note is text THEY wrote about the dictionary, not a
	 * piece of any conversation.
	 *
	 * @returns the line, capped by the host at 500 characters.
	 */
	const feedbackLine = () => {
		const parts = flagged.map((entry) => {
			const kind = t(`feedbackKind_${entry.feedback?.kind ?? "other"}`);
			return entry.untrusted === true ? `${entry.term}(${kind}+${t("flaggedUntrusted")})` : `${entry.term}(${kind})`;
		});
		const notes = flagged.map((entry) => entry.feedback?.note ?? "").filter((note) => note !== "");
		return [
			`${t("nav")}: ${flagged.length}`,
			parts.join(" / "),
			notes.length === 0 ? "" : `${t("feedbackNoteLabel")}: ${notes.join(" | ")}`
		]
			.filter((part) => part !== "")
			.join(" — ");
	};

	/** Record the summary into the host's own feedback log, and report what came of it. */
	const sendFeedback = async () => {
		if (feedbackState === "sending") return;
		const sessionId = typeof props.sessionId === "function" ? props.sessionId() : "";
		// Checked here rather than sent and refused: an empty id would come back as
		// `session-not-found`, which blames the session for what is really "no transcript seen yet".
		if (sessionId === "") {
			setFeedbackState("no-session");
			return;
		}
		if (typeof props.recordFeedback !== "function") {
			setFeedbackState("unavailable");
			return;
		}
		setFeedbackState("sending");
		const answer = await props.recordFeedback({ sessionId, text: feedbackLine(), category: "product-interaction" });
		if (answer?.ok === true) return setFeedbackState("ok");
		const error = answer?.error;
		if (error === "unavailable" || error === "session-not-found") return setFeedbackState(error);
		setFeedbackState("failed");
	};

	/** Save one text as a file, and report it. */
	const downloadText = (text, name) => {
		try {
			const blob = new Blob([text], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const link = globalThis.document.createElement("a");
			link.href = url;
			link.download = name;
			link.click();
			URL.revokeObjectURL(url);
			props.setToast?.({ kind: "auto", text: t("transferExported"), undoable: false });
		} catch (error) {
			props.setToast?.({ kind: "auto", text: t("transferFailed", { message: String(error?.message ?? error) }), undoable: false });
		}
	};

	/** Save the export as a file. */
	const download = () => downloadText(textOf(), `term-dictionary-${new Date().toISOString().slice(0, 10)}.json`);

	/** Take a file, and say what came of it. */
	const takeFile = async (event) => {
		const file = event?.target?.files?.[0];
		if (file === undefined || file === null) return;
		setBusy(true);
		try {
			const parsed = parseImport(await file.text());
			if (parsed.ok !== true) {
				setReport({ failed: parsed.error });
				return;
			}
			const plan = planImport(entries, parsed.entries, store.getState().deletedKeys ?? new Set(), { includeDeleted });
			for (const entry of plan.accepted) {
				await store.saveEntry(entry.term, {
					definition: entry.definition,
					domain: entry.domain,
					aliases: entry.aliases,
					pinned: entry.pinned
				});
			}
			setReport({
				imported: plan.accepted.length,
				existing: plan.existing.length,
				deleted: plan.deleted.length,
				duplicates: plan.duplicates + (parsed.skipped ?? 0)
			});
		} catch (error) {
			setReport({ failed: String(error?.message ?? error) });
		} finally {
			setBusy(false);
		}
	};

	/** One selectable row of the category list. */
	const domainRow = (domain) =>
		h(
			"label",
			// The marker names the category, so a check can read the checklist the page built instead of
			// inferring it from the export it produced.
			{ key: domain.domain, style: applyStyles.transferItem, "data-term-domain": domain.domain },
			h("input", {
				type: "checkbox",
				style: applyStyles.checkbox,
				checked: chosen.includes(domain.domain),
				onChange: () => setChosen(chosen.includes(domain.domain) ? chosen.filter((name) => name !== domain.domain) : [...chosen, domain.domain])
			}),
			h("span", { style: applyStyles.transferName }, domain.domain),
			h("span", { style: applyStyles.transferCount }, t("seenTimes", { count: domain.count }))
		);

	return h(
		"div",
		{ style: applyStyles.settingsPage, "data-term-dictionary": "transfer" },
		//#region export
		h("p", { style: applyStyles.settingLabel }, t("transferExportTitle")),
		h("p", { style: applyStyles.settingHint }, t("transferExportHint")),
		h(
			"div",
			{ style: applyStyles.transferRow, role: "radiogroup", "aria-label": t("transferExportTitle") },
			h(OptionBar, {
				label: t("transferExportTitle"),
				value: scope,
				options: [
					{ value: "all", label: t("transferScopeAll") },
					{ value: "domains", label: t("transferScopeDomains") }
				],
				onSelect: (value) => setScope(value)
			})
		),
		scope === "domains"
			? domains.length === 0
				? h("p", { style: applyStyles.settingHint }, t("transferNoDomains"))
				: h(
					"div",
					{ style: applyStyles.transferList },
					h(
						"div",
						{ style: applyStyles.transferRow },
						h("button", { type: "button", style: applyStyles.linkButton, onClick: () => setChosen(domains.map((domain) => domain.domain)) }, t("transferSelectAll")),
						h("button", { type: "button", style: applyStyles.linkButton, onClick: () => setChosen([]) }, t("transferSelectNone"))
					),
					domains.map(domainRow)
				)
			: null,
		h(
			"div",
			{ style: applyStyles.transferRow },
			h(Button, { label: t("transferDownload"), onClick: download }, t("transferDownload")),
			h(Button, { label: t("transferCopy"), onClick: () => void globalThis.navigator?.clipboard?.writeText(textOf()) }, t("transferCopy"))
		),
		//#endregion
		//#region feedback report
		//
		// The other half of the feedback feature, and the half that can actually reach someone: the
		// host's own channel records a remark into THIS machine's session log. A report is a file the
		// user decides to send.
		h("p", { style: applyStyles.settingLabel }, t("feedbackExportTitle")),
		h("p", { style: applyStyles.settingHint }, t("feedbackExportHint", { count: String(flagged.length) })),
		h(
			"label",
			{ style: applyStyles.transferItem, "data-term-dictionary": "feedback-include-gloss" },
			h("input", {
				type: "checkbox",
				style: applyStyles.checkbox,
				checked: includeGloss,
				onChange: () => setIncludeGloss(!includeGloss)
			}),
			h("span", { style: applyStyles.transferName }, t("feedbackIncludeGloss"))
		),
		h(
			"div",
			{ style: applyStyles.transferRow },
			h(
				Button,
				{ label: t("feedbackDownload"), disabled: flagged.length === 0, onClick: () => downloadText(feedbackTextOf(), `term-dictionary-feedback-${new Date().toISOString().slice(0, 10)}.json`) },
				t("feedbackDownload")
			),
			h(
				Button,
				{ label: t("feedbackCopy"), disabled: flagged.length === 0, onClick: () => void globalThis.navigator?.clipboard?.writeText(feedbackTextOf()) },
				t("feedbackCopy")
			)
		),
		//#region the host's own channel
		//
		// The third way to say something, and the only one that lands somewhere the plugin does not own:
		// the host keeps it in THIS machine's session log. It cannot reach the plugin's author — nothing
		// leaves the machine — which is exactly why the report above exists.
		h("p", { style: applyStyles.settingHint }, t("feedbackRecordHint")),
		h(
			"div",
			{ style: applyStyles.transferRow },
			h(
				Button,
				{ label: t("feedbackRecord"), disabled: flagged.length === 0 || feedbackState === "sending", onClick: () => void sendFeedback() },
				t("feedbackRecord")
			),
			feedbackState === null
				? null
				: h("span", { style: applyStyles.meta, "data-term-feedback-state": feedbackState }, t(`feedbackState_${feedbackState}`))
		),
		//#endregion
		//#region import
		h("p", { style: applyStyles.settingLabel }, t("transferImportTitle")),
		h("p", { style: applyStyles.settingHint }, t("transferImportHint")),
		h(
			"label",
			{ style: applyStyles.transferItem, "data-term-dictionary": "transfer-include-deleted" },
			h("input", {
				type: "checkbox",
				style: applyStyles.checkbox,
				checked: includeDeleted,
				onChange: () => setIncludeDeleted(!includeDeleted)
			}),
			h("span", { style: applyStyles.transferName }, t("transferIncludeDeleted"))
		),
		h("p", { style: applyStyles.settingHint }, t("transferIncludeDeletedHint")),
		h("input", {
			type: "file",
			accept: ".json,application/json",
			"aria-label": t("transferImportTitle"),
			disabled: busy,
			onChange: (event) => void takeFile(event),
			style: applyStyles.transferFile
		}),
		report === null
			? null
			: h(
				"p",
				{ style: report.failed === undefined ? applyStyles.settingHint : applyStyles.error },
				report.failed === undefined
					? t("transferReport", { imported: report.imported, existing: report.existing, deleted: report.deleted, duplicates: report.duplicates })
					: t("transferFailed", { message: report.failed })
			)
		//#endregion
	);
}

/**
 * What the user deleted, and the one action that matters here: take it back.
 *
 * The dictionary is a blacklist as well as a glossary — a struck-out term is refused by collection
 * and by import — and a blacklist nobody can read is one nobody can correct. Before this view a term
 * deleted by mistake (or by a mis-aimed click on a row) was gone for good: the tombstone was doing
 * its job with no way to retract it.
 *
 * The row shows the DELETION, not the entry, so it carries what the decision needs: which term, when
 * it was struck out, and the way back. It is deliberately not clickable — opening the editor here
 * would be a second, silent way to undo the deletion.
 *
 * Exported so the checks can render it directly, for the same reason {@link SettingsPage} is: the
 * panel only reaches it through the tab, and a check that has to simulate that click is a check that
 * tests the click.
 *
 * @param props - `entries` (the tombstones, newest first), `t`, `onRevive`.
 * @returns the deleted view.
 */
function DeletedList(props) {
	const { entries, t, onRevive } = props;
	return h(
		"div",
		{ style: applyStyles.deletedList, "data-term-dictionary": "deleted" },
		h("p", { style: applyStyles.settingHint }, t("deletedHint")),
		entries.length === 0
			? h("p", { style: applyStyles.blank }, t("deletedEmpty"))
			: entries.map((entry) =>
				h(
					"article",
					{ key: entry.id, style: applyStyles.row, "data-term-deleted": entry.key },
					h(
						"div",
						{ style: applyStyles.rowHead },
						h("span", { style: applyStyles.deletedTerm }, entry.term),
						h("span", { style: applyStyles.spacer }),
						h("span", { style: applyStyles.meta }, t("deletedAt", { time: formatStamp(entry.deletedAt) })),
						h(Button, { label: t("revive"), onClick: () => onRevive(entry) }, t("revive"))
					)
				)
			)
	);
}

/**
 * What the user said about entries, and the one action that matters here: take it back.
 *
 * The row shows the REMARK — its kind, the user's own words, and when — because that is the thing
 * being reviewed. Retracting is one press rather than a trip through the editor: a remark is easy to
 * make by accident (a stray click on a kind), and a correction that costs a form is a correction
 * nobody makes.
 *
 * Exported so the checks can render it directly, like {@link SettingsPage} and {@link DeletedList}.
 *
 * @param props - `entries` (the flagged ones), `t`, `onClear`.
 * @returns the flagged view.
 */
function FlaggedList(props) {
	const { entries, t, onClear } = props;
	return h(
		"div",
		{ style: applyStyles.flaggedList, "data-term-dictionary": "flagged" },
		h("p", { style: applyStyles.settingHint }, t("flaggedHint")),
		entries.length === 0
			? h("p", { style: applyStyles.blank }, t("flaggedEmpty"))
			: entries.map((entry) =>
				h(
					"article",
					{ key: entry.id, style: applyStyles.row, "data-term-flagged": entry.key },
					h(
						"div",
						{ style: applyStyles.rowHead },
						h("span", { style: applyStyles.termPlain }, entry.term),
						entry.feedback !== null && entry.feedback !== undefined
							? h("span", { style: applyStyles.badgeWarn }, t(`feedbackKind_${entry.feedback.kind}`))
							: null,
						entry.untrusted === true ? h("span", { style: applyStyles.badgeWarn }, t("flaggedUntrusted")) : null,
						h("span", { style: applyStyles.spacer }),
						h("span", { style: applyStyles.meta }, t("flaggedAt", { time: formatStamp(Math.max(entry.feedbackAt ?? 0, entry.untrustedAt ?? 0)) })),
						h(Button, { label: t("flaggedClear"), onClick: () => onClear(entry) }, t("flaggedClear"))
					),
					entry.feedback !== null && entry.feedback !== undefined && entry.feedback.note !== ""
						? h("p", { style: applyStyles.gloss }, entry.feedback.note)
						: null
				)
			)
	);
}

/**
 * The plugin's preferences, as a page of its own inside the panel.
 *
 * Why a page rather than a row of chips under the tabs: a chip can only state its CURRENT value,
 * so the row read as a status line you could also poke, not as settings. A page has room for the
 * thing each preference actually does — and there are now nine of them, which is past what a row
 * can carry without becoming a puzzle.
 *
 * Every row is the same three parts: the preference's name (which never changes as you use it),
 * what it does, and the control its VALUE SHAPE calls for — a switch for two states, an option bar
 * for more, so the control itself says how many choices there are.
 *
 * Exported so it can be rendered and driven directly by the checks, the way the glyph and the
 * popup are: putting it behind the panel's own state would mean a check could only see it by
 * simulating a click first.
 *
 * @param props - `settings`, `setSwitch`, `t`.
 * @returns the settings page.
 */
function SettingsPage(props) {
	const { settings, setSwitch, t } = props;

	/**
	 * One preference line.
	 * @param key - React's list key.
	 * @param label - the preference's name.
	 * @param hint - what it does.
	 * @param control - the switch or option bar.
	 * @returns the row.
	 */
	const row = (key, label, hint, control) =>
		h(
			"div",
			{ style: applyStyles.settingRow, key },
			h("div", { style: applyStyles.settingText }, h("p", { style: applyStyles.settingLabel }, label), h("p", { style: applyStyles.settingHint }, hint)),
			control
		);

	/**
	 * A two-state row.
	 * @param key - React's list key.
	 * @param label - the name.
	 * @param hint - what it does.
	 * @param checked - the current state.
	 * @param toggle - the setter.
	 * @returns the row.
	 */
	const flag = (key, label, hint, checked, toggle) => row(key, label, hint, h(ToggleSwitch, { checked, title: label, onToggle: toggle }));

	return h(
		"div",
		{ style: applyStyles.settingsPage, "data-term-dictionary": "settings" },
		flag("collect", t("autoDetectOn"), t("autoDetectHint"), settings.autoCollect, () => setSwitch("autoCollect", !settings.autoCollect)),
		flag("annotate", t("annotateOn"), t("annotateHint"), settings.autoAnnotate, () => setSwitch("autoAnnotate", !settings.autoAnnotate)),
		flag("explain", t("autoExplainOn"), t("autoExplainHint"), settings.autoExplain, () => setSwitch("autoExplain", !settings.autoExplain)),
		flag(
			"paragraph",
			t("explainParagraphOn"),
			t("explainParagraphHint"),
			settings.explainParagraph !== false,
			() => setSwitch("explainParagraph", settings.explainParagraph === false)
		),
		row(
			"lang",
			t("explainLangName"),
			t("explainLangHint"),
			h(OptionBar, {
				label: t("explainLangName"),
				value: EXPLAIN_LANGS.includes(settings.explainLang) ? settings.explainLang : "auto",
				options: EXPLAIN_LANGS.map((value) => ({ value, label: t(`explainLang_${value}`) })),
				onSelect: (value) => setSwitch("explainLang", value)
			})
		),
		row(
			"depth",
			t("explainDepthName"),
			t("explainDepthHint"),
			h(OptionBar, {
				label: t("explainDepthName"),
				value: EXPLAIN_DEPTHS.includes(settings.explainDepth) ? settings.explainDepth : "normal",
				options: EXPLAIN_DEPTHS.map((value) => ({ value, label: t(`explainDepth_${value}`) })),
				onSelect: (value) => setSwitch("explainDepth", value)
			})
		),
		flag(
			"identifiers",
			t("collectIdentifiersOn"),
			t("collectIdentifiersHint"),
			settings.collectIdentifiers === true,
			() => setSwitch("collectIdentifiers", settings.collectIdentifiers !== true)
		),
		row(
			"minLength",
			t("collectMinLengthName"),
			t("collectMinLengthHint"),
			h(OptionBar, {
				label: t("collectMinLengthName"),
				value: COLLECT_LENGTHS.includes(settings.collectMinLength) ? settings.collectMinLength : 4,
				options: COLLECT_LENGTHS.map((value) => ({ value, label: t("collectMinLengthOption", { count: value }) })),
				onSelect: (value) => setSwitch("collectMinLength", value)
			})
		),
		flag("cjk", t("collectCjkOn"), t("collectCjkHint"), settings.collectCjk !== false, () => setSwitch("collectCjk", settings.collectCjk === false)),
		// The hover delays. Both are numbers in a range, so both are slider + box; the exit delay
		// sits right under the entry delay because they are read together.
		row(
			"hoverIn",
			t("hoverInName"),
			t("hoverInHint"),
			h(DelayField, {
				label: t("hoverInName"),
				value: settings.hoverInMs,
				min: HOVER_DELAY_MIN,
				max: HOVER_DELAY_MAX,
				step: HOVER_DELAY_STEP,
				unit: t("hoverUnit"),
				onChange: (value) => setSwitch("hoverInMs", value)
			})
		),
		row(
			"hoverOut",
			t("hoverOutName"),
			t("hoverOutHint"),
			h(DelayField, {
				label: t("hoverOutName"),
				value: settings.hoverOutMs,
				min: HOVER_DELAY_MIN,
				max: HOVER_DELAY_MAX,
				step: HOVER_DELAY_STEP,
				unit: t("hoverUnit"),
				onChange: (value) => setSwitch("hoverOutMs", value)
			})
		)
	);
}

/** One clickable icon button, sized like the host's 28px controls. */
function IconButton(props) {
	return h(
		"button",
		{
			type: "button",
			title: props.title,
			"aria-label": props.title,
			"aria-pressed": props.pressed,
			disabled: props.disabled === true,
			onClick: props.onClick,
			style: {
				...applyStyles.iconButton,
				...(props.pressed === true ? applyStyles.iconButtonActive : null),
				...(props.disabled === true ? { opacity: 0.45, cursor: "default" } : null)
			}
		},
		props.children
	);
}

/** A labelled text input. */
function Field(props) {
	return h(
		"label",
		{ style: applyStyles.field },
		h("span", { style: applyStyles.fieldLabel }, props.label),
		h("input", {
			type: "text",
			value: props.value,
			placeholder: props.placeholder,
			onChange: (event) => props.onChange(event.target.value),
			style: applyStyles.input,
			"aria-label": props.label
		})
	);
}

/** A labelled multi-line text area. */
function Area(props) {
	return h(
		"label",
		{ style: applyStyles.field },
		h("span", { style: applyStyles.fieldLabel }, props.label),
		h("textarea", {
			value: props.value,
			placeholder: props.placeholder,
			rows: props.rows ?? 3,
			onChange: (event) => props.onChange(event.target.value),
			style: { ...applyStyles.input, resize: "vertical", minHeight: `${(props.rows ?? 3) * 1.5}em`, lineHeight: 1.5 },
			"aria-label": props.label
		})
	);
}

/** A primary or secondary button. */
function Button(props) {
	return h(
		"button",
		{
			type: "button",
			disabled: props.disabled === true,
			onClick: props.onClick,
			"aria-label": props.label,
			style: {
				...(props.variant === "primary" ? applyStyles.primaryButton : applyStyles.button),
				...(props.disabled === true ? { opacity: 0.5, cursor: "default" } : null),
				...(props.extra ?? null)
			}
		},
		props.children
	);
}

/**
 * The dictionary panel body, rendered as the `main` center region once the user
 * picks the Dictionary row in the sidebar.
 *
 * @param props - injected `store`, `t`, plus the theme/font context the host
 *   provides to a main panel; it uses no session data.
 * @returns the panel element tree.
 */
/** @type {null | { term: string, context: string, id?: string, zh: string, gloss: string, usage: string, notes: string, domain: string, aliases: string, pinned: boolean, isNew: boolean }} */
function DictionaryPanel(props) {
	const { store, t, bus } = props;
	const settingsStore = props.settings ?? null;
	const view = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	// The three-argument form is used with a stable fallback so the hook order does not
	// depend on whether this deployment passed a settings store.
	const settings = React.useSyncExternalStore(
		settingsStore === null ? NO_SUBSCRIPTION : settingsStore.subscribe,
		settingsStore === null ? () => FALLBACK_SETTINGS : settingsStore.getSnapshot,
		settingsStore === null ? () => FALLBACK_SETTINGS : settingsStore.getSnapshot
	);
	const [query, setQuery] = React.useState("");
	const [filter, setFilter] = React.useState("all");
	const [editing, setEditing] = React.useState(null);
	/** Whether the panel is showing its settings page instead of the entry list. */
	const [settingsOpen, setSettingsOpen] = React.useState(false);
	/** Whether it is showing the import/export page instead. */
	const [transferOpen, setTransferOpen] = React.useState(false);
	const [busy, setBusy] = React.useState(false);
	/** Whether rows are being picked for a batch action. */
	const [picking, setPicking] = React.useState(false);
	/** The ids of the picked rows. */
	const [picked, setPicked] = React.useState([]);
	/** The entry a transcript click asked to reveal, held long enough to be noticed. */
	const [revealedKey, setRevealedKey] = React.useState(null);
	const revealedRef = React.useRef(null);
	const [status, setStatus] = React.useState(() => store.getStatus());
	const [syncError, setSyncError] = React.useState(() => store.getSyncError());

	/** Turn one switch over. The settings store is what persists and broadcasts it. */
	const setSwitch = (key, value) => {
		if (settingsStore === null) return;
		settingsStore.set(key, value);
	};

	/** Add or remove one row from the picked set. */
	const togglePicked = (id) => {
		setPicked((current) => (current.includes(id) ? current.filter((each) => each !== id) : [...current, id]));
	};

	// The store is the single owner of the document, so the panel only needs to
	// observe when hydration finishes and when the host rejected a write.
	React.useEffect(() => {
		let alive = true;
		const sync = () => {
			if (!alive) return;
			setStatus(store.getStatus());
			setSyncError(store.getSyncError());
		};
		const unsubscribe = store.subscribe(sync);
		sync();
		return () => {
			alive = false;
			unsubscribe();
		};
	}, [store]);

	const visible = React.useMemo(() => store.list(query, filter), [view, query, filter]);
	const current = view.state.entries;
	/**
	 * Whether the panel is showing what was deleted.
	 *
	 * This is not a fourth predicate over the same list: tombstones live in `backing`, so the deleted
	 * view is a different list, rendered by {@link DeletedList} — and the batch-selection bar, whose
	 * checkboxes only exist on live rows, has nothing to act on here.
	 */
	const showingDeleted = filter === "deleted";
	/**
	 * Whether the panel is showing what the user said about entries.
	 *
	 * A third list rather than a predicate: these rows are about the REMARK, so they read differently
	 * (kind, note, when) and their one action is to take it back. The batch bar is hidden for the same
	 * reason as in the deleted view — these rows have no checkbox.
	 */
	const showingFlagged = filter === "flagged";

	/** Open the editor for a blank entry, prefilled from an optional term. */
	const startCreate = (term = "", context = "") => {
		setEditing({
			term,
			zh: "",
			gloss: "",
			usage: "",
			notes: "",
			domain: "",
			aliases: "",
			pinned: false,
			// Nothing to say yet, and `feedbackTouched` is what tells a save apart from a retraction:
			// an untouched pair of empty fields must not create an empty remark.
			feedbackKind: "wrong-gloss",
			feedbackNote: "",
			feedbackTouched: false,
			untrusted: false,
			context,
			isNew: true
		});
	};

	/** Open the editor on an existing entry. */
	const startEdit = (entry) => {
		setEditing({
			id: entry.id,
			term: entry.term,
			zh: entry.definition.zh,
			gloss: entry.definition.gloss,
			usage: entry.definition.usage,
			notes: entry.definition.notes,
			domain: entry.domain,
			aliases: entry.aliases.join(", "),
			pinned: entry.pinned,
			// Seeded from the entry, and `touched` starts true when there is already a remark: saving
			// the form again must not read as "the user retracted it".
			feedbackKind: entry.feedback?.kind ?? "wrong-gloss",
			feedbackNote: entry.feedback?.note ?? "",
			feedbackTouched: entry.feedback !== null && entry.feedback !== undefined,
			untrusted: entry.untrusted === true,
			context: entry.context,
			isNew: false
		});
	};

	// A click on a term in the transcript reaches the editor through the shell's
	// command bus, so the transcript never has to know the panel's shape.
	React.useEffect(() => {
		if (bus === undefined || bus === null) return undefined;
		const consume = () => {
			const command = bus.consumeCreate();
			if (command !== null) {
				setRevealedKey(null);
				startCreate(command.term, command.context);
			}
			const reveal = typeof bus.consumeFocus === "function" ? bus.consumeFocus() : null;
			if (reveal === null || reveal === undefined) return;
			// The entry exists, so the panel's job is to show it: drop whatever narrows
			// the list and whatever replaces it, or the row the user asked for would be
			// filtered out or hidden behind an open editor.
			setEditing(null);
			setQuery("");
			setFilter("all");
			setRevealedKey(reveal.key);
		};
		consume();
		return bus.subscribe(consume);
	}, [bus]);

	// The mark is a cue, not a mode: it fades on its own so the list goes back to
	// reading as a list.
	React.useEffect(() => {
		if (revealedKey === null) return undefined;
		const timer = setTimeout(() => setRevealedKey(null), REVEAL_FLASH_MS);
		return () => clearTimeout(timer);
	}, [revealedKey]);

	// Bring the revealed row into view. The list scrolls, so a row below the fold
	// would otherwise be "revealed" out of sight.
	React.useLayoutEffect(() => {
		const element = revealedRef.current;
		if (element === null || revealedKey === null) return;
		if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center" });
	}, [revealedKey, query, filter]);

	/** Persist the editor's fields. */
	const commitEditing = async () => {
		if (editing === null || editing.term.trim() === "" || busy) return;
		setBusy(true);
		try {
			await store.saveEntry(editing.term, {
				definition: { zh: editing.zh, gloss: editing.gloss, usage: editing.usage, notes: editing.notes },
				domain: editing.domain,
				aliases: editing.aliases
					.split(",")
					.map((alias) => alias.trim())
					.filter((alias) => alias !== ""),
				pinned: editing.pinned,
				// What the two feedback fields say, and nothing when the user never touched them — an
				// untouched pair of empty fields means "no remark", not "the user retracted one", which
				// is why a save that only fixes a typo in the gloss leaves the remark alone.
				feedback: editing.feedbackTouched ? { kind: editing.feedbackKind, note: editing.feedbackNote } : null,
				untrusted: editing.untrusted
			});
			setEditing(null);
		} finally {
			setBusy(false);
		}
	};

	/** Ask the host's model for an explanation of the term being edited. */
	const generate = async () => {
		if (editing === null || editing.term.trim() === "" || busy) return;
		if (typeof props.explain !== "function") {
			setSyncError(t("generateNoHost"));
			return;
		}
		setBusy(true);
		try {
			// `retry` when the user has called the current explanation untrustworthy: the host appends
			// one fixed sentence saying the last answer was rejected. The user's own note is never sent.
			const answer = await props.explain(editing.term.trim(), editing.context ?? "", { retry: editing.untrusted === true });
			if (answer !== null && answer !== undefined && answer.ok === true && answer.definition !== null && typeof answer.definition === "object") {
				setEditing((previous) =>
					previous === null
						? previous
						: {
							...previous,
							gloss: typeof answer.definition.gloss === "string" && answer.definition.gloss !== "" ? answer.definition.gloss : previous.gloss,
							zh: typeof answer.definition.zh === "string" && answer.definition.zh !== "" ? answer.definition.zh : previous.zh,
							usage: typeof answer.definition.usage === "string" && answer.definition.usage !== "" ? answer.definition.usage : previous.usage,
							domain: typeof answer.definition.domain === "string" && answer.definition.domain !== "" ? answer.definition.domain : previous.domain
						}
				);
				setSyncError("");
			} else {
				setSyncError(t("generateFailed", { message: answer?.error ?? "unknown" }));
			}
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Copy one entry as text.
	 *
	 * No selection involved, which is the whole point: the list re-sorts itself as new sightings arrive
	 * and the click that ends a selection used to open the editor over it. A button cannot be
	 * interrupted by either.
	 *
	 * @param entry - the entry to copy.
	 */
	const copyEntry = async (entry) => {
		const text = entryAsText(entry);
		if (text === "") return;
		try {
			if (typeof navigator?.clipboard?.writeText !== "function") {
				setSyncError(t("copyUnavailable"));
				return;
			}
			await navigator.clipboard.writeText(text);
			props.setToast?.({ kind: "auto", text: t("toastCopied", { term: entry.term }), undoable: false });
		} catch (error) {
			void error;
			setSyncError(t("copyUnavailable"));
		}
	};

	/** Copy the whole dictionary as JSON to the clipboard. */
	const exportJson = async () => {
		try {
			if (typeof navigator?.clipboard?.writeText !== "function") {
				setSyncError(t("exportFailed"));
				return;
			}
			const text = JSON.stringify({ schemaVersion: 1, entries: current }, null, 2);
			await navigator.clipboard.writeText(text);
			setSyncError(t("exportDone"));
		} catch (error) {
			setSyncError(t("exportFailed"));
		}
	};

	/**
	 * Delete every picked row in one document write.
	 *
	 * One `store.deleteEntries` call rather than a loop of `deleteEntry`: each delete
	 * persists the whole document and pushes it to the host, so twenty rows done one at a
	 * time would mean twenty round trips. The tombstones are still one per entry, which is
	 * what stops the host's copy from bringing them back.
	 */
	const deletePicked = async () => {
		if (picked.length === 0) return;
		if (globalThis.confirm?.(t("deleteSelectedConfirm", { count: String(picked.length) })) === false) return;
		await store.deleteEntries(picked);
		setPicked([]);
		setPicking(false);
	};

	/**
	 * Take one deletion back.
	 *
	 * The toast is the confirmation, and it is not decoration: the revived row LEAVES this list, so
	 * without a word about where it went, a click on 撤回 looks like a row that simply disappeared.
	 */
	const revive = async (entry) => {
		const restored = await store.reviveEntry(entry.id);
		if (restored !== null) props.setToast?.({ kind: "auto", text: t("toastRevived", { term: entry.term }), undoable: false });
	};

	/**
	 * Take a remark back.
	 *
	 * Clears BOTH things the user said — the remark and the verdict on the explanation — because the
	 * row's one press is "never mind", and leaving the entry marked untrustworthy while its remark
	 * disappeared would keep the automatic explainer away with nothing on screen to explain why.
	 */
	const clearFlag = async (entry) => {
		const cleared = await store.markEntry(entry.id, { feedback: null, untrusted: false });
		if (cleared !== null) props.setToast?.({ kind: "auto", text: t("toastFlagCleared", { term: entry.term }), undoable: false });
	};

	if (editing !== null) {
		return h(
			"div",
			{ style: applyStyles.panel, "data-term-dictionary": "editor" },
			h(
				"header",
				{ style: applyStyles.header },
				h("div", { style: applyStyles.headerText },
					h("h2", { style: applyStyles.title }, editing.isNew ? t("editorTitle") : t("editorTitleEdit")),
					editing.context !== "" ? h("p", { style: applyStyles.context }, editing.context) : null
				),
				h(IconButton, { title: t("close"), onClick: () => setEditing(null) }, Icons.close(14))
			),
			h(
				"div",
				{ style: applyStyles.editorBody },
				h(Field, {
					label: t("termLabel"),
					value: editing.term,
					placeholder: t("termPlaceholder"),
					onChange: (value) => setEditing({ ...editing, term: value })
				}),
				h(Field, {
					label: t("translationLabel"),
					value: editing.zh,
					placeholder: t("zhPlaceholder"),
					onChange: (value) => setEditing({ ...editing, zh: value })
				}),
				h(Area, {
					label: t("glossLabel"),
					value: editing.gloss,
					placeholder: t("glossPlaceholder"),
					rows: 4,
					onChange: (value) => setEditing({ ...editing, gloss: value })
				}),
				h(Area, {
					label: t("usageLabel"),
					value: editing.usage,
					placeholder: t("usagePlaceholder"),
					rows: 2,
					onChange: (value) => setEditing({ ...editing, usage: value })
				}),
				h(Field, {
					label: t("domainLabel"),
					value: editing.domain,
					placeholder: t("domainPlaceholder"),
					onChange: (value) => setEditing({ ...editing, domain: value })
				}),
				h(Area, {
					label: t("notesLabel"),
					value: editing.notes,
					placeholder: t("notesPlaceholder"),
					rows: 2,
					onChange: (value) => setEditing({ ...editing, notes: value })
				}),
				//#region feedback
				//
				// The remark lives HERE, on the entry's own page, rather than behind a separate "report
				// a problem" dialog. Two reasons: a report and a fix are the same visit — the person who
				// says the explanation is wrong is looking right at the field they would correct it in —
				// and the editor is where an entry's state is edited, so a second place to change the
				// same entry is exactly the drift this plugin keeps designing out.
				h("p", { style: applyStyles.settingLabel }, t("feedbackTitle")),
				h("p", { style: applyStyles.settingHint }, t("feedbackHint")),
				h(
					"div",
					{ style: applyStyles.settingRow },
					h("div", { style: applyStyles.settingText }, h("span", { style: applyStyles.settingLabel }, t("feedbackKindName"))),
					h(OptionBar, {
						label: t("feedbackKindName"),
						value: editing.feedbackKind,
						options: FEEDBACK_KINDS.map((kind) => ({ value: kind, label: t(`feedbackKind_${kind}`) })),
						// Picking a kind IS making a remark, so the pair stops being "untouched" here.
						onSelect: (value) => setEditing({ ...editing, feedbackKind: value, feedbackTouched: true })
					})
				),
				h(
					"div",
					{ style: applyStyles.settingRow },
					h(
						"div",
						{ style: applyStyles.settingText },
						h("span", { style: applyStyles.settingLabel }, t("feedbackUntrustedOn")),
						h("span", { style: applyStyles.settingHint }, t("feedbackUntrustedHint"))
					),
					h(ToggleSwitch, {
						title: t("feedbackUntrustedOn"),
						checked: editing.untrusted === true,
						onToggle: () => setEditing({ ...editing, untrusted: !editing.untrusted })
					})
				),
				h(Area, {
					label: t("feedbackNoteLabel"),
					value: editing.feedbackNote,
					placeholder: t("feedbackNotePlaceholder"),
					rows: 2,
					onChange: (value) => setEditing({ ...editing, feedbackNote: value, feedbackTouched: true })
				}),
				//#endregion
				syncError !== "" ? h("p", { style: applyStyles.error }, syncError) : null,
				h(
					"div",
					{ style: applyStyles.actions },
					h(Button, { variant: "primary", label: t("saveAndClose"), disabled: busy || editing.term.trim() === "", onClick: commitEditing }, t("save")),
					h(Button, { label: t("generate"), disabled: busy || editing.term.trim() === "", onClick: generate }, busy ? t("generating") : t("generate")),
					// Copy what is on the FORM, not what is stored: the editor is where somebody has just
					// written the text they want to paste somewhere, and it may not be saved yet.
					h(
						Button,
						{
							label: t("copyEntry"),
							disabled: editing.term.trim() === "",
							onClick: () =>
								void copyEntry({
									term: editing.term.trim(),
									definition: { zh: editing.zh, gloss: editing.gloss, usage: editing.usage }
								})
						},
						t("copyEntry")
					),
					h(Button, { label: t("cancel"), onClick: () => setEditing(null) }, t("cancel"))
				)
			)
		);
	}

	if (transferOpen) {
		return h(
			"div",
			{ style: applyStyles.panel, "data-term-dictionary": "panel" },
			h(
				"header",
				{ style: applyStyles.header },
				h(
					"div",
					{ style: applyStyles.headerText },
					h("h2", { style: applyStyles.title }, t("transferTitle")),
					h("p", { style: applyStyles.subtitle }, t("transferSubtitle"))
				),
				h(Button, { label: t("settingsBack"), onClick: () => setTransferOpen(false) }, t("settingsBack"))
			),
			h(TransferPage, { store, t, setToast: props.setToast })
		);
	}

	if (settingsOpen) {
		return h(
			"div",
			{ style: applyStyles.panel, "data-term-dictionary": "panel" },
			h(
				"header",
				{ style: applyStyles.header },
				h(
					"div",
					{ style: applyStyles.headerText },
					h("h2", { style: applyStyles.title }, t("settingsTitle")),
					h("p", { style: applyStyles.subtitle }, t("settingsSubtitle"))
				),
				h(Button, { label: t("settingsBack"), onClick: () => setSettingsOpen(false) }, t("settingsBack"))
			),
			h(SettingsPage, { settings, setSwitch, t })
		);
	}

	return h(
		"div",
		{ style: applyStyles.panel, "data-term-dictionary": "panel" },
		h(
			"header",
			{ style: applyStyles.header },
			h(
				"div",
				{ style: applyStyles.headerText },
				h("h2", { style: applyStyles.title }, t("title")),
				h("p", { style: applyStyles.subtitle }, status === "loading" ? t("loading") : t("count", { total: view.stats.total, unexplained: view.stats.unexplained }))
			),
			h(Button, { label: t("settingsOpen"), onClick: () => setSettingsOpen(true) }, t("settingsOpen")),
			h(Button, { label: t("transferTitle"), onClick: () => setTransferOpen(true) }, t("transferTitle")),
			h(IconButton, { title: t("addTerm"), onClick: () => startCreate() }, Icons.plus(14)),
			h(
				IconButton,
				{
					title: picking ? t("selectExit") : t("selectEnter"),
					pressed: picking,
					onClick: () => {
						setPicking(!picking);
						setPicked([]);
					}
				},
				Icons.select(14)
			)
		),
		h(
			"div",
			{ style: applyStyles.searchRow },
			h("span", { style: applyStyles.searchIcon, "aria-hidden": "true" }, Icons.search(14)),
			h("input", {
				type: "search",
				value: query,
				placeholder: t("search"),
				"aria-label": t("search"),
				onChange: (event) => setQuery(event.target.value),
				style: SEARCH_INPUT_STYLE
			})
		),
		h(
			"div",
			{ style: applyStyles.tabs, role: "tablist" },
			[
				["all", t("filterAll")],
				["unexplained", t("filterUnexplained")],
				["pinned", t("filterPinned")],
				["flagged", t("filterFlagged")],
				["deleted", t("filterDeleted")]
			].map(([id, label]) =>
				h(
					"button",
					{
						key: id,
						type: "button",
						role: "tab",
						"aria-selected": filter === id,
						onClick: () => setFilter(id),
						style: { ...applyStyles.tab, ...(filter === id ? applyStyles.tabActive : null) }
					},
					label
				)
			)
		),
	// The preferences are NOT a row here any more. A row of chips under the tabs could only
	// state each value, never explain it, and at nine controls it read as a puzzle — so they
	// moved to their own page ({@link SettingsPage}), reached from the header. One place per
	// preference: two places to change the same thing is how the two drift apart.
	picking && !showingDeleted && !showingFlagged
			? h(
				"div",
				{ style: applyStyles.selectBar, "data-term-dictionary": "select-bar" },
				h("span", null, t("selectedCount", { count: String(picked.length) })),
				h(
					"button",
					{
						type: "button",
						style: applyStyles.linkButton,
						onClick: () => setPicked(picked.length === visible.length ? [] : visible.map((entry) => entry.id))
					},
					picked.length === visible.length && visible.length > 0 ? t("selectNone") : t("selectAll")
				),
				h("span", { style: applyStyles.spacer }),
				h(
					"button",
					{
						type: "button",
						style: { ...applyStyles.button, ...(picked.length === 0 ? { opacity: 0.5, cursor: "default" } : null) },
						disabled: picked.length === 0,
						onClick: deletePicked
					},
					t("deleteSelected")
				)
			)
			: null,
		syncError !== "" ? h(
			"div",
			{ style: applyStyles.notice },
			h("span", null, syncError),
			h("button", { type: "button", onClick: () => store.retrySync(), style: applyStyles.linkButton }, t("retrySync"))
		) : null,
		h(
			"div",
			{ style: applyStyles.list },
			showingDeleted
				? h(DeletedList, { entries: visible, t, onRevive: (entry) => void revive(entry) })
				: showingFlagged
				? h(FlaggedList, { entries: visible, t, onClear: (entry) => void clearFlag(entry) })
				: visible.length === 0
				? h("p", { style: applyStyles.blank }, current.length === 0 ? t("empty") : t("searchEmpty"))
				: visible.map((entry) =>
					picking
						? h(
							"article",
							{
								key: entry.id,
								style: applyStyles.rowPicking,
								"data-term-entry": entry.key,
								"data-term-picked": picked.includes(entry.id) ? "true" : undefined
							},
							h("input", {
								type: "checkbox",
								style: applyStyles.checkbox,
								checked: picked.includes(entry.id),
								"aria-label": entry.term,
								onChange: () => togglePicked(entry.id)
							}),
							h("button", {
								type: "button",
								style: applyStyles.termButton,
								onClick: () => togglePicked(entry.id),
								title: t("selectEnter")
							}, entry.term),
							entry.definition.zh !== "" ? h("span", { style: applyStyles.zh }, entry.definition.zh) : null,
							entry.pinned ? h("span", { style: applyStyles.badge }, t("pinned")) : null,
							h("span", { style: applyStyles.spacer }),
							h("span", { style: applyStyles.domain }, entry.domain)
						)
						: h(
						"article",
						{
							key: entry.id,
							ref: revealedKey === entry.key ? revealedRef : null,
							style: revealedKey === entry.key ? { ...applyStyles.row, ...applyStyles.rowRevealed } : applyStyles.row,
							"data-term-entry": entry.key,
							"data-term-revealed": revealedKey === entry.key ? "true" : undefined,
							// The whole BLOCK opens the entry, not only its name.
							//
							// A pointer convenience, deliberately not a control: the term-name button
							// inside is the accessible one (focusable, labelled), so this adds no role,
							// no tab stop and no key handler — and it must not, because the row holds
							// several buttons of its own and a `role="button"` wrapped around them would
							// report the whole row as a single control.
							onClick: (event) => {
								// The buttons inside keep their own meaning: pressing pin, copy, edit or
								// delete must not also open the editor behind it.
								if (typeof event?.target?.closest === "function" && event.target.closest("button") !== null) return;
								// And a click that just ENDED a text selection is a selection gesture: this
								// used to open the editor on top of the text somebody was selecting to copy.
								if (selectionInside(event?.currentTarget)) return;
								startEdit(entry);
							}
						},
						h(
							"div",
							{ style: applyStyles.rowHead },
							h("button", {
								type: "button",
								style: applyStyles.termButton,
								onClick: () => startEdit(entry),
								title: t("edit")
							}, entry.term),
							entry.definition.zh !== "" ? h("span", { style: applyStyles.zh }, entry.definition.zh) : null,
							entry.pinned ? h("span", { style: applyStyles.badge }, t("pinned")) : null,
							entry.definition.gloss === "" && entry.definition.zh === "" ? h("span", { style: applyStyles.badgeWarn }, t("unexplained")) : null,
							// A flagged entry says so in the list, not only in its own view: the badge is
							// how a reader learns there is something to read before opening anything.
							entry.feedback !== null && entry.feedback !== undefined
								? h("span", { style: applyStyles.badgeWarn, "data-term-badge": "feedback" }, t(`feedbackKind_${entry.feedback.kind}`))
								: null,
							entry.untrusted === true ? h("span", { style: applyStyles.badgeWarn, "data-term-badge": "untrusted" }, t("flaggedUntrusted")) : null,
							h("span", { style: applyStyles.spacer }),
							entry.domain !== "" ? h("span", { style: applyStyles.domain }, entry.domain) : null,
							h(IconButton, { title: entry.pinned ? t("unpin") : t("pin"), pressed: entry.pinned, onClick: () => store.togglePinned(entry.id) }, Icons.pin(13)),
							h(IconButton, { title: t("copyEntry"), onClick: () => void copyEntry(entry) }, Icons.copy(13)),
							h(IconButton, { title: t("feedbackTitle"), pressed: entry.feedback !== null && entry.feedback !== undefined, onClick: () => startEdit(entry) }, Icons.flag(13)),
							h(IconButton, { title: t("edit"), onClick: () => startEdit(entry) }, Icons.edit(13)),
							h(IconButton, { title: t("remove"), onClick: () => { if (globalThis.confirm?.(t("removeConfirm")) !== false) store.deleteEntry(entry.id); } }, Icons.trash(13))
						),
						entry.definition.gloss !== "" ? h("p", { style: applyStyles.gloss }, entry.definition.gloss) : h("p", { style: applyStyles.glossMuted }, t("noDefinition")),
						entry.definition.usage !== "" ? h("p", { style: applyStyles.usage }, entry.definition.usage) : null,
						h(
							"p",
							{ style: applyStyles.meta },
							[
								t("seenTimes", { count: entry.seen }),
								entry.lastSeenAt > 0 ? t("lastSeen", { time: formatStamp(entry.lastSeenAt) }) : "",
								sourceLabel(entry.source, t)
							].filter((part) => part !== "").join(" · ")
						)
					)
				)
		),
		storageNote(view.hostInfo, t),
		h(
			"footer",
			{ style: applyStyles.footer },
			h("span", null, t("countShort", { total: view.stats.total })),
			h("span", { style: applyStyles.spacer }),
			h("button", { type: "button", onClick: exportJson, style: applyStyles.linkButton }, t("exportJson")),
			h("button", {
				type: "button",
				onClick: () => {
					// Ask with the NUMBERS in the question. "Delete everything?" and "delete 8, keep the
					// 3 you pinned" are different offers, and only the second one is what happens —
					// a confirmation that under-describes its own effect is how a pinned entry gets
					// deleted by a user who believed it was safe.
					const all = store.getState().entries ?? [];
					const kept = all.filter((entry) => entry.pinned === true).length;
					if (globalThis.confirm?.(t("clearConfirm", { removed: all.length - kept, kept })) === true) store.clearAll();
				},
				style: applyStyles.linkButton
			}, t("clearAll"))
		)
	);
}

/**
 * Where the dictionary is stored, when the host told the page.
 *
 * A read-only profile is the interesting case: the panel keeps working from local
 * storage, so the user needs to know the file is not being written rather than
 * discovering it after a restart.
 *
 * @param hostInfo - the `location` block from `GET /state`, or null.
 * @param t - the panel's localization function.
 * @returns the note element, or null when there is nothing to say.
 */
function storageNote(hostInfo, t) {
	if (hostInfo === null || hostInfo === undefined) return null;
	const writable = hostInfo.writable !== false;
	return h(
		"p",
		{ style: writable ? applyStyles.storageNote : applyStyles.error, "data-term-dictionary": "storage-note" },
		writable ? t("storageAt", { path: hostInfo.directory ?? "" }) : t("storageReadOnly")
	);
}

/** Localized label for an entry's provenance. */
function sourceLabel(source, t) {
	switch (source) {
		case "user":
			return t("popupSourceUser");
		case "llm":
			return t("popupSourceLlm");
		case "heuristic":
			return t("popupSourceHeuristic");
		case "import":
			return t("popupSourceImport");
		default:
			return t("popupSourceAuto");
	}
}

module.exports = { DictionaryGlyph, DictionaryPanel, DeletedList, FlaggedList, SettingsPage, TransferPage, ToggleSwitch, OptionBar, Icons, IconButton, Button, sourceLabel };
