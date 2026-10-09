"use strict";

/**
 * The overlay surface: the explanation popup, the "add to dictionary"
 * affordance that follows a selection, and the transient notice.
 *
 * All three are fixed-position elements owned by the plugin rather than by the
 * conversation tree, which is why they live in one component: they are one layer
 * over the page and they must not be clipped by the transcript's scroll
 * container. The popup is placed against the pointer and then corrected inward
 * after it has been measured, so it never opens off-screen.
 */

const React = require("react");
const { applyStyles } = require("./styles.js");
const { formatStamp } = require("./core.js");
const { HIGHLIGHT_CSS } = require("./highlight.js");

const h = React.createElement;

/** Gap between the pointer and the popup's corner. */
const POINTER_GAP = 10;

/** Minimum distance from a viewport edge. */
const EDGE_GAP = 8;

/**
 * The stylesheet the annotation layer needs.
 *
 * A `::highlight()` rule only exists in a stylesheet, so it cannot be an inline
 * style like the rest of this file. Rendering it as an element means React removes
 * it with the overlay, so an unloaded plugin leaves neither a rule nor a registry
 * entry behind.
 *
 * @returns the style element.
 */
function HighlighterStyle() {
	return h("style", { "data-term-dictionary": "highlight-style" }, HIGHLIGHT_CSS);
}

/**
 * The brief explanation that appears when the pointer comes to rest on a collected
 * term. (Removed with the hover gesture — the pointer layer is wikilink's job.)
 */

/**
 * The explanation popup, anchored at the pointer.
 *
 * Three states, decided here rather than by the caller: an entry with an
 * explanation, an entry without one (offer to generate), and a term the
 * dictionary has never seen (offer to create).
 *
 * @param props - `term`, `entry`, `context`, `point`, `t`, `pending`, and the
 *   `onCreate` / `onGenerate` / `onClose` callbacks.
 * @returns the popup element.
 */
function TermPopup(props) {
	const { term, entry, context, point, t, pending } = props;
	const ref = React.useRef(null);
	const [placement, setPlacement] = React.useState(null);

	// Measure after paint and pull the box back inside the viewport. Doing this in
	// a layout effect keeps the first painted frame in the right place.
	React.useLayoutEffect(() => {
		const element = ref.current;
		if (element === null || point === null || point === undefined) return;
		const rect = element.getBoundingClientRect();
		const viewportWidth = globalThis.innerWidth ?? 0;
		const viewportHeight = globalThis.innerHeight ?? 0;
		let left = point.x + POINTER_GAP;
		let top = point.y + POINTER_GAP;
		if (viewportWidth > 0 && left + rect.width > viewportWidth - EDGE_GAP) left = Math.max(EDGE_GAP, point.x - POINTER_GAP - rect.width);
		if (viewportHeight > 0 && top + rect.height > viewportHeight - EDGE_GAP) top = Math.max(EDGE_GAP, point.y - POINTER_GAP - rect.height);
		setPlacement({ left: Math.round(left), top: Math.round(top) });
	}, [point?.x, point?.y, entry?.id, pending?.phase]);

	// Dismiss on Escape and on a click outside, which is what every other surface
	// in the page does.
	React.useEffect(() => {
		const onKeyDown = (event) => {
			if (event.key === "Escape") props.onClose();
		};
		const onPointerDown = (event) => {
			const element = ref.current;
			if (element !== null && !element.contains(event.target)) props.onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [props.onClose]);

	const gloss = entry?.definition?.gloss ?? "";
	const style = {
		...applyStyles.popup,
		...(placement === null ? { left: "-9999px", top: "-9999px" } : { left: `${placement.left}px`, top: `${placement.top}px` })
	};

	return h(
		"div",
		{ ref, style, role: "dialog", "aria-label": term, "data-term-dictionary": "popup" },
		h(
			"div",
			{ style: applyStyles.popupHead },
			h("p", { style: applyStyles.popupTerm }, term),
			entry !== null && entry.definition.zh !== "" ? h("span", { style: applyStyles.popupZh }, entry.definition.zh) : null
		),
		gloss !== ""
			? h("p", { style: applyStyles.popupGloss }, gloss)
			: entry !== null
				? h("p", { style: applyStyles.popupGloss }, t("noDefinition"))
				: h("p", { style: applyStyles.popupGloss }, t("popupUnknown")),
		entry !== null && entry.definition.usage !== "" ? h("p", { style: applyStyles.popupUsage }, entry.definition.usage) : null,
		entry === null && context !== "" ? h("p", { style: applyStyles.popupContext }, context) : null,
		pending?.phase === "running" ? h("p", { style: applyStyles.popupMeta }, t("popupGenerating")) : null,
		pending?.phase === "failed" ? h("p", { style: applyStyles.error }, t("generateFailed", { message: pending.message })) : null,
		h(
			"div",
			{ style: applyStyles.popupActions },
			gloss === ""
				? h(
					"button",
					{
						type: "button",
						style: applyStyles.primaryButton,
						disabled: pending?.phase === "running",
						onClick: props.onGenerate
					},
					pending?.phase === "running" ? t("generating") : t("generate")
				)
				: null,
			h(
				"button",
				{ type: "button", style: applyStyles.button, onClick: props.onCreate },
				entry === null ? t("popupCreate") : t("edit")
			),
			h("span", { style: applyStyles.spacer }),
			entry !== null
				? h(
					"span",
					{ style: applyStyles.popupMeta },
					[sourceLabel(entry.source, t), entry.domain, entry.seen > 0 ? t("seenTimes", { count: entry.seen }) : ""].filter((part) => part !== "").join(" · ")
				)
				: null
		)
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

/**
 * The small button that appears beside a selection inside a reply.
 *
 * @param props - `selection` (`{ term, rect }`), `label`, `title`, `onAdd`, `onClose`.
 * @returns the affordance element.
 */
function SelectionAffordance(props) {
	const { selection, label, title } = props;
	const ref = React.useRef(null);
	const [position, setPosition] = React.useState(null);

	React.useLayoutEffect(() => {
		const element = ref.current;
		if (element === null || selection?.rect === undefined) return;
		const rect = element.getBoundingClientRect();
		const viewportWidth = globalThis.innerWidth ?? 0;
		const viewportHeight = globalThis.innerHeight ?? 0;
		const anchor = selection.rect;
		// Prefer below the selection, above it when the page bottom is close.
		let top = anchor.bottom + 6;
		if (viewportHeight > 0 && top + rect.height > viewportHeight - EDGE_GAP) top = Math.max(EDGE_GAP, anchor.top - rect.height - 6);
		let left = anchor.left;
		if (viewportWidth > 0 && left + rect.width > viewportWidth - EDGE_GAP) left = Math.max(EDGE_GAP, viewportWidth - rect.width - EDGE_GAP);
		setPosition({ left: Math.round(left), top: Math.round(top) });
	}, [selection?.term, selection?.rect?.top, selection?.rect?.bottom, selection?.rect?.left]);

	return h(
		"button",
		{
			ref,
			type: "button",
			title,
			// The marker lets the transcript's document-level `mousedown` listener tell a
			// press on this button from a press that abandons the selection. Without it the
			// button was unmounted before its own `click` could run.
			"data-term-dictionary": "affordance",
			style: { ...applyStyles.selectionButton, ...(position === null ? { left: "-9999px", top: "-9999px" } : { left: `${position.left}px`, top: `${position.top}px` }) },
			// A pointerdown inside the affordance would collapse the selection before
			// the click lands, so the selection is preserved deliberately.
			onMouseDown: (event) => event.preventDefault(),
			onClick: props.onAdd
		},
		h("span", { "aria-hidden": "true" }, "＋"),
		h("span", null, label)
	);
}

/**
 * The transient notice shown after an automatic collection.
 *
 * The notice itself is `pointer-events: none` (its style) so that it cannot swallow clicks meant for
 * whatever it happens to be covering — and it covers the composer, being bottom-centre with the
 * highest z-index. Its buttons opt back IN, because they are the only part that is meant to be
 * pressed.
 *
 * @param props - `text`, optional `actionLabel` and `onAction`, `onClose`.
 * @returns the notice element.
 */
function Toast(props) {
	/** The interactive parts of a notice that otherwise lets pointers through. */
	const buttonStyle = { ...applyStyles.linkButton, pointerEvents: "auto" };
	return h(
		"div",
		{ style: applyStyles.toast, role: "status", "data-term-dictionary": "toast" },
		h("span", null, props.text),
		props.actionLabel !== null && props.actionLabel !== undefined && typeof props.onAction === "function"
			? h("button", { type: "button", style: buttonStyle, onClick: props.onAction }, props.actionLabel)
			: null,
		h("button", { type: "button", style: buttonStyle, onClick: props.onClose, "aria-label": "close" }, "✕")
	);
}

module.exports = { TermPopup, SelectionAffordance, Toast, HighlighterStyle, sourceLabel };
