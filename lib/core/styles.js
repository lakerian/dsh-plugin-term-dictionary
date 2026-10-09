"use strict";

/**
 * Shared inline styles for the panel and the popup.
 *
 * Only `--dsw-alias-*` and `--dsw-radius-*` theme tokens appear as colors, so the
 * plugin follows light and dark themes without a second code path and degrades
 * safely if a token is renamed. Geometry literals (padding, sizes) mirror the
 * host's own management pages.
 */

/** Font stack inherited from the host shell, with a CJK-capable fallback. */
const FONT = "inherit";

/** The panel and popup share one bordered-surface recipe. */
const surface = {
	background: "var(--dsw-alias-bg-layer-1)",
	border: "0.5px solid var(--dsw-alias-border-l3)",
	borderRadius: "var(--dsw-radius-md, 10px)"
};

/** Text input recipe copied from the host's settings controls. */
const input = {
	width: "100%",
	boxSizing: "border-box",
	font: FONT,
	fontSize: "13px",
	color: "var(--dsw-alias-label-primary)",
	// The platform's own input fill. `--dsw-alias-bg-l1` (what this used to be) does
	// not exist, and a `var()` with no fallback makes the whole declaration invalid at
	// computed-value time — so the fields silently lost their background instead of
	// falling back to anything.
	background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-base))",
	border: "0.5px solid var(--dsw-alias-border-l3)",
	borderRadius: "var(--dsw-radius-sm, 6px)",
	padding: "6px 8px",
	outline: "none"
};

/** The panel's search field, minus its icon gutter. */
const SEARCH_INPUT_STYLE = {
	...input,
	paddingLeft: "28px",
	background: "transparent",
	border: "none"
};

/** Style table consumed by the views; kept as one object so tests can assert it. */
const applyStyles = {
	panel: {
		display: "flex",
		flexDirection: "column",
		height: "100%",
		minHeight: 0,
		boxSizing: "border-box",
		color: "var(--dsw-alias-label-primary)",
		font: FONT,
		background: "var(--dsw-specific-sidebar-fill, transparent)"
	},
	header: {
		display: "flex",
		alignItems: "flex-start",
		gap: "12px",
		padding: "18px 20px 10px"
	},
	headerText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, flex: "1 1 auto" },
	title: { margin: 0, fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
	subtitle: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.4 },
	searchRow: {
		display: "flex",
		alignItems: "center",
		gap: "6px",
		margin: "0 20px 8px",
		padding: "0 8px",
		border: "0.5px solid var(--dsw-alias-border-l3)",
		borderRadius: "var(--dsw-radius-sm, 6px)",
		background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-base))"
	},
	searchIcon: { display: "flex", color: "var(--dsw-alias-label-tertiary)", flex: "none" },
	tabs: { display: "flex", gap: "4px", padding: "0 20px 10px" },
	tab: {
		appearance: "none",
		font: FONT,
		fontSize: "12px",
		color: "var(--dsw-alias-label-secondary)",
		background: "transparent",
		border: "none",
		borderRadius: "var(--dsw-radius-sm, 6px)",
		padding: "3px 8px",
		cursor: "pointer"
	},
	tabActive: {
		color: "var(--dsw-alias-label-primary)",
		background: "var(--dsw-alias-interactive-bg-hover)"
	},
	notice: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		margin: "0 20px 8px",
		padding: "6px 10px",
		fontSize: "12px",
		color: "var(--dsw-alias-label-secondary)",
		background: "var(--dsw-alias-bg-layer-2, transparent)",
		border: "0.5px solid var(--dsw-alias-border-l3)",
		borderRadius: "var(--dsw-radius-sm, 6px)"
	},
	error: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-state-error-primary)" },
	list: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 20px 16px", display: "flex", flexDirection: "column", gap: "8px" },
	blank: { margin: "8px 0", fontSize: "13px", lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary)" },
	row: {
		...surface,
		display: "flex",
		flexDirection: "column",
		gap: "4px",
		padding: "10px 12px",
		// The whole block opens the entry, so say so before the click: a reader who has to discover
		// that by trial will click the name — which is what they did.
		cursor: "pointer"
	},
	/** The row a transcript click asked to reveal, before the cue fades. */
	rowRevealed: {
		borderColor: "var(--dsw-alias-brand-primary, #4d6bfe)",
		boxShadow: "0 0 0 1px var(--dsw-alias-brand-primary, #4d6bfe)"
	},
	rowHead: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
	termButton: {
		appearance: "none",
		background: "transparent",
		border: "none",
		padding: 0,
		font: FONT,
		fontSize: "14px",
		fontWeight: 600,
		color: "var(--dsw-alias-label-primary)",
		cursor: "pointer",
		textAlign: "left"
	},
	zh: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
	domain: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" },
	spacer: { flex: "1 1 auto" },
	badge: {
		fontSize: "10px",
		lineHeight: 1.6,
		padding: "0 6px",
		borderRadius: "999px",
		color: "var(--dsw-alias-label-secondary)",
		background: "var(--dsw-alias-bg-base)",
		border: "0.5px solid var(--dsw-alias-border-l2)"
	},
	badgeWarn: {
		fontSize: "10px",
		lineHeight: 1.6,
		padding: "0 6px",
		borderRadius: "999px",
		color: "var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-secondary))",
		border: "0.5px dashed var(--dsw-alias-border-l3)"
	},
	gloss: { margin: 0, fontSize: "13px", lineHeight: 1.65, color: "var(--dsw-alias-label-secondary)" },
	glossMuted: { margin: 0, fontSize: "13px", fontStyle: "italic", color: "var(--dsw-alias-label-tertiary)" },
	usage: {
		margin: 0,
		fontSize: "12px",
		lineHeight: 1.6,
		color: "var(--dsw-alias-label-tertiary)",
		paddingLeft: "8px",
		borderLeft: "2px solid var(--dsw-alias-border-l2)"
	},
	meta: { margin: 0, fontSize: "11px", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))" },
	/**
	 * A context line, clamped to three lines.
	 *
	 * The editor renders its context directly under the title, so an unbounded context
	 * does not merely look untidy — it takes the whole panel and pushes the fields and
	 * the Save button out of reach. The collector and the selection path now bound what
	 * they store, and this clamp means even a legacy or imported entry with a huge
	 * context can never do that again.
	 */
	context: {
		margin: 0,
		fontSize: "12px",
		lineHeight: 1.6,
		color: "var(--dsw-alias-label-tertiary)",
		display: "-webkit-box",
		WebkitLineClamp: 3,
		WebkitBoxOrient: "vertical",
		overflow: "hidden",
		overflowWrap: "anywhere"
	},
	storageNote: {
		margin: 0,
		padding: "6px 20px",
		fontSize: "11px",
		color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))",
		overflowWrap: "anywhere"
	},
	footer: {
		display: "flex",
		alignItems: "center",
		gap: "12px",
		padding: "8px 20px 12px",
		borderTop: "0.5px solid var(--dsw-alias-border-l2)",
		fontSize: "11px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	linkButton: {
		appearance: "none",
		background: "transparent",
		border: "none",
		padding: 0,
		font: FONT,
		fontSize: "11px",
		color: "var(--dsw-alias-brand-primary, var(--dsw-alias-label-secondary))",
		cursor: "pointer"
	},
	iconButton: {
		appearance: "none",
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: "24px",
		height: "24px",
		padding: 0,
		border: "none",
		borderRadius: "var(--dsw-radius-sm, 6px)",
		background: "transparent",
		color: "var(--dsw-alias-label-secondary)",
		cursor: "pointer",
		flex: "none"
	},
	iconButtonActive: {
		color: "var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary))",
		background: "var(--dsw-alias-interactive-bg-hover)"
	},

	//#region the settings page and batch selection
	/** The settings page: one preference per line, each with its own explanation. */
	settingsPage: { padding: "0 20px 12px", display: "flex", flexDirection: "column", gap: "2px" },
	/**
	 * One preference line.
	 *
	 * Was a wrapping row of chips under the tabs; the page has room to say what each preference
	 * DOES, and a row never did.
	 */
	settingRow: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: "12px",
		padding: "8px 0",
		borderBottom: "0.5px solid var(--dsw-alias-border-l2)"
	},
	/** The text half of a preference line. */
	settingText: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
	settingLabel: { margin: 0, font: FONT, fontSize: "12px", color: "var(--dsw-alias-label-primary)" },
	settingHint: { margin: 0, font: FONT, fontSize: "11px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" },
	/**
	 * A two-state preference: a track and a knob.
	 *
	 * The chip this replaces put its state in its own label ("收代码术语" / "不收代码术语"), so the
	 * row's NAME changed as you used it. A switch says the same thing without moving any text,
	 * which is what lets a settings row keep one name and one explanation.
	 */
	toggleTrack: {
		appearance: "none",
		position: "relative",
		flex: "0 0 auto",
		width: "34px",
		height: "18px",
		padding: 0,
		border: "0.5px solid var(--dsw-alias-border-l2)",
		borderRadius: "999px",
		background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-base))",
		cursor: "pointer",
		transition: "background-color 120ms ease, border-color 120ms ease"
	},
	toggleTrackOn: {
		background: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))",
		borderColor: "transparent"
	},
	toggleKnob: {
		position: "absolute",
		top: "50%",
		left: "2px",
		width: "12px",
		height: "12px",
		marginTop: "-6px",
		borderRadius: "999px",
		background: "var(--dsw-alias-label-secondary)",
		transition: "left 120ms ease, background-color 120ms ease"
	},
	toggleKnobOn: { left: "18px", background: "var(--dsw-alias-label-primary-inverted)" },
	/**
	 * Three or more values: an option bar.
	 *
	 * Every value is visible at once and the chosen one is marked, so the control answers "what
	 * are my choices" as well as "what is it now". The cycling chip it replaces did neither
	 * without clicking: to learn the options you had to click until they came round again, and to
	 * reach one you clicked past the others.
	 */
	optionBar: {
		display: "inline-flex",
		flex: "0 0 auto",
		gap: "2px",
		padding: "2px",
		border: "0.5px solid var(--dsw-alias-border-l2)",
		borderRadius: "8px"
	},
	optionItem: {
		appearance: "none",
		border: "none",
		background: "transparent",
		font: FONT,
		fontSize: "11px",
		lineHeight: 1.6,
		padding: "2px 8px",
		borderRadius: "6px",
		color: "var(--dsw-alias-label-secondary)",
		cursor: "pointer",
		whiteSpace: "nowrap"
	},
	optionItemActive: {
		background: "var(--dsw-alias-interactive-bg-hover)",
		color: "var(--dsw-alias-label-primary)"
	},
	/**
	 * A delay: a slider plus a box for the exact number.
	 *
	 * One control in two shapes because the job is two jobs — sweeping to find a feel, and typing a
	 * value already in mind. The box is deliberately narrow: it holds three digits.
	 */
	delayField: { display: "inline-flex", flex: "0 0 auto", alignItems: "center", gap: "6px" },
	delaySlider: { width: "110px", accentColor: "var(--dsw-alias-brand-primary, #4d6bfe)" },
	delayBox: {
		width: "52px",
		font: FONT,
		fontSize: "11px",
		padding: "2px 4px",
		textAlign: "right",
		color: "var(--dsw-alias-label-primary)",
		background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-base))",
		border: "0.5px solid var(--dsw-alias-border-l2)",
		borderRadius: "6px"
	},
	delayUnit: { font: FONT, fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
	/** The bar that appears while rows can be picked. */
	selectBar: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		flexWrap: "wrap",
		margin: "0 20px 8px",
		padding: "6px 10px",
		fontSize: "12px",
		color: "var(--dsw-alias-label-secondary)",
		background: "var(--dsw-alias-bg-layer-2, transparent)",
		border: "0.5px solid var(--dsw-alias-border-l3)",
		borderRadius: "var(--dsw-radius-sm, 6px)"
	},
	/** A row that is being picked rather than read. */
	rowPicking: {
		...surface,
		display: "flex",
		alignItems: "center",
		gap: "8px",
		padding: "8px 10px",
		cursor: "pointer"
	},
	checkbox: {
		width: "15px",
		height: "15px",
		flex: "none",
		margin: 0,
		// The host styles its own radios and checkboxes with exactly this property.
		accentColor: "var(--dsw-alias-brand-primary)"
	},
	//#endregion

	//#region the import/export page, and the deleted view
	/** A row of controls on the transfer page: an option bar, or the download/copy pair. */
	transferRow: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "2px 0 8px" },
	/** The category checklist. */
	transferList: { display: "flex", flexDirection: "column", gap: "2px", padding: "0 0 8px" },
	/**
	 * One selectable category.
	 *
	 * A `<label>`, so the whole line is the hit target rather than the 15px box: the checkbox is the
	 * control, and next to it the count is what decides which categories are worth exporting.
	 */
	transferItem: { display: "flex", alignItems: "center", gap: "8px", padding: "3px 0", fontSize: "12px", color: "var(--dsw-alias-label-primary)", cursor: "pointer" },
	transferName: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
	transferCount: { flex: "none", fontSize: "11px", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))" },
	/** The file picker. Chrome renders it; it only needs to sit with the rest of the page. */
	transferFile: { font: FONT, fontSize: "12px", color: "var(--dsw-alias-label-secondary)", padding: "2px 0 6px" },
	/**
	 * The name of an entry the user deleted.
	 *
	 * Struck through, because the row is the record of a decision rather than a term to read — and
	 * the row is the only place the two states are ever side by side.
	 */
	deletedTerm: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)", textDecoration: "line-through" },
	/**
	 * The deleted view's own column.
	 *
	 * The panel's list is a column too, but its `gap` only reaches its DIRECT children — and this view
	 * is one child holding the hint and every row, so without a column of its own the cards would sit
	 * flush against each other.
	 */
	deletedList: { display: "flex", flexDirection: "column", gap: "8px" },
	//#endregion

	editorBody: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 20px 16px", display: "flex", flexDirection: "column", gap: "12px" },
	field: { display: "flex", flexDirection: "column", gap: "4px" },
	fieldLabel: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" },
	input,
	searchInput: SEARCH_INPUT_STYLE,
	actions: { display: "flex", gap: "8px", flexWrap: "wrap", paddingTop: "4px" },
	button: {
		appearance: "none",
		font: FONT,
		fontSize: "13px",
		color: "var(--dsw-alias-label-primary)",
		background: "var(--dsw-alias-bg-base)",
		border: "0.5px solid var(--dsw-alias-border-l3)",
		borderRadius: "var(--dsw-radius-sm, 6px)",
		padding: "5px 12px",
		cursor: "pointer"
	},
	primaryButton: {
		appearance: "none",
		font: FONT,
		fontSize: "13px",
		fontWeight: 600,
		// The host's own primary-button pair.
		//
		// This used to be `var(--dsw-alias-brand-primary)` with
		// `var(--dsw-alias-label-inverse, #fff)`. Neither name is real: the design
		// platform has no `--dsw-alias-label-inverse`, so the label fell back to white,
		// and in the DARK theme `--dsw-alias-brand-primary` is
		// `--dsw-static-neutral-bluish-50` — near-white, the same value the theme gives
		// `--dsw-alias-label-primary`. The label and the fill were therefore both white
		// and the Save button rendered as an empty rectangle.
		//
		// The values below are the ones the platform defines for exactly this job:
		// `button-primary-fill` is the brand fill and `label-primary-inverted` is the
		// text that sits on it — white-on-near-black in the light theme, dark-on-
		// near-white in the dark one. Measured from the shipped theme CSS, not assumed.
		color: "var(--dsw-alias-label-primary-inverted)",
		background: "var(--dsw-alias-button-primary-fill)",
		border: "0.5px solid transparent",
		borderRadius: "var(--dsw-radius-sm, 6px)",
		padding: "5px 12px",
		cursor: "pointer"
	},

	//#region popup
	popup: {
		...surface,
		position: "fixed",
		zIndex: 2147483000,
		width: "min(360px, calc(100vw - 24px))",
		maxHeight: "min(60vh, 420px)",
		overflowY: "auto",
		boxShadow: "0 8px 28px rgba(0, 0, 0, 0.18)",
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: "6px",
		font: FONT,
		color: "var(--dsw-alias-label-primary)"
	},
	popupHead: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
	popupTerm: { margin: 0, fontSize: "15px", fontWeight: 600, lineHeight: 1.3 },
	popupZh: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
	popupGloss: { margin: 0, fontSize: "13px", lineHeight: 1.7, color: "var(--dsw-alias-label-secondary)", whiteSpace: "pre-wrap" },
	popupUsage: {
		margin: 0,
		fontSize: "12px",
		lineHeight: 1.6,
		color: "var(--dsw-alias-label-tertiary)",
		paddingLeft: "8px",
		borderLeft: "2px solid var(--dsw-alias-border-l2)",
		whiteSpace: "pre-wrap"
	},
	popupMeta: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: "11px", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))" },
	popupActions: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", paddingTop: "2px" },
	popupContext: {
		margin: 0,
		fontSize: "12px",
		lineHeight: 1.6,
		color: "var(--dsw-alias-label-tertiary)",
		overflowWrap: "anywhere"
	},
	//#endregion

	//#region hover hint
	//
	// REMOVED with the hover gesture (2026-10-09). The pointer layer belongs to
	// dsh-plugin-term-wikilink, which brings its own card styles; keeping this region would
	// keep a second, unreachable definition of "what a hover card looks like" — and the two
	// would drift the moment the inline styles change, which is precisely the confusion the
	// merge is meant to end.
	//#endregion


	//#region selection affordance
	selectionButton: {
		...surface,
		position: "fixed",
		zIndex: 2147483001,
		display: "inline-flex",
		alignItems: "center",
		gap: "6px",
		padding: "5px 10px",
		font: FONT,
		fontSize: "12px",
		color: "var(--dsw-alias-label-primary)",
		boxShadow: "0 4px 14px rgba(0, 0, 0, 0.16)",
		cursor: "pointer"
	},
	toast: {
		...surface,
		position: "fixed",
		left: "50%",
		bottom: "28px",
		transform: "translateX(-50%)",
		zIndex: 2147483002,
		display: "flex",
		alignItems: "center",
		gap: "12px",
		padding: "8px 14px",
		font: FONT,
		fontSize: "13px",
		color: "var(--dsw-alias-label-primary)",
		boxShadow: "0 6px 20px rgba(0, 0, 0, 0.18)",
		// A NOTICE MUST NOT EAT INPUT.
		//
		// This sits at the bottom centre with the highest z-index in the plugin — which is exactly
		// where the composer is. Without this line it swallowed every click in its rectangle for the
		// six seconds it lived, so deleting an entry, importing, exporting or clearing the dictionary
		// left the input box unusable until the notice timed out. The interactive parts opt back in
		// (see the toast's own buttons), so undo and close still work.
		pointerEvents: "none"
	}
	//#endregion
};

module.exports = { applyStyles, SEARCH_INPUT_STYLE, surface, input, FONT };
