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
 * The "explain" button that stands beside the host's own text bar.
 *
 * The host renders one keyed entry per gesture, so a second plugin cannot join its
 * bar through the registry: the bar's single slot is already taken by the quotes
 * plugin. What it CAN do is stand next to it, in the same pill, at the same height —
 * and that is what the user asked for: select a phrase and see 「引用文本」「解释」 side
 * by side. The button is placed against the host bar's measured box on every frame it
 * is visible, so the two keep reading as one row while the bar moves with the page.
 *
 * @param props - `selection` (`{ term, rect }`), `t`, `onExplain`.
 * @returns the button element.
 */
function SelectionExplain(props) {
	const { selection, t } = props;
	const ref = React.useRef(null);
	const [position, setPosition] = React.useState(null);

	React.useLayoutEffect(() => {
		const element = ref.current;
		if (element === null) return;
		const place = () => {
			const own = element.getBoundingClientRect();
			const viewportWidth = globalThis.innerWidth ?? 0;
			const viewportHeight = globalThis.innerHeight ?? 0;
			let left;
			let top;
			// The host's bar is a fixed-position surface; its first element child is the pill
			// the quotes plugin renders. Standing against that box is what makes the two read
			// as one row. There can be more than one surface in the document (an embedded chat
			// body mounts its own), and querySelector would pick the first one even when the
			// selection lives in another, which put this button on a second row — so every
			// visible surface is measured and the one nearest the selection wins.
			const surfaces = typeof document === "undefined" || typeof document.querySelectorAll !== "function" ? [] : Array.from(document.querySelectorAll("[data-text-interaction-surface]"));
			const anchor = selection?.rect;
			let nearest = null;
			let nearestDistance = Infinity;
			for (const surface of surfaces) {
				if (surface.getAttribute?.("aria-hidden") === "true") continue;
				const candidate = surface.firstElementChild ?? surface;
				let rect = candidate.getBoundingClientRect();
				// A wrapper that measures to nothing still has a positioned surface behind it.
				if (rect.width <= 0 || rect.height <= 0) rect = surface.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) continue;
				const distance = anchor === undefined || anchor === null ? 0 : Math.abs(rect.left - anchor.left) + Math.abs(rect.top - anchor.top);
				if (distance < nearestDistance) {
					nearest = rect;
					nearestDistance = distance;
				}
			}
			if (nearest !== null) {
				left = nearest.right + 6;
				top = nearest.top + (nearest.height - own.height) / 2;
				if (viewportWidth > 0 && left + own.width > viewportWidth - EDGE_GAP) left = nearest.left - own.width - 6;
			}
			if (left === undefined) {
				if (anchor === undefined || anchor === null) return;
				// Same side the host's own bar prefers: above the selection, below only when
				// there is no room above.
				left = anchor.left;
				top = anchor.top - own.height - 6;
				if (top < EDGE_GAP) top = anchor.bottom + 6;
			}
			if (viewportHeight > 0 && top + own.height > viewportHeight - EDGE_GAP) top = Math.max(EDGE_GAP, top - own.height - 12);
			if (viewportWidth > 0) left = Math.min(left, Math.max(EDGE_GAP, viewportWidth - own.width - EDGE_GAP));
			left = Math.max(EDGE_GAP, left);
			top = Math.max(EDGE_GAP, top);
			setPosition((previous) =>
				previous !== null && previous.left === Math.round(left) && previous.top === Math.round(top) ? previous : { left: Math.round(left), top: Math.round(top) }
			);
		};
		place();
		const raf = globalThis.requestAnimationFrame;
		if (typeof raf !== "function") return;
		let frame = raf(() => {
			place();
			frame = raf(place);
		});
		return () => globalThis.cancelAnimationFrame?.(frame);
	}, [selection?.term, selection?.rect?.top, selection?.rect?.bottom, selection?.rect?.left]);

	return h(
		"button",
		{
			ref,
			type: "button",
			title: t("textExplainTitle", { term: selection?.term ?? "" }),
			"aria-label": t("textExplain"),
			"data-term-dictionary": "selection-explain",
			style: { ...applyStyles.textAction, position: "fixed", zIndex: 2147483000, ...(position === null ? { left: "-9999px", top: "-9999px" } : { left: `${position.left}px`, top: `${position.top}px` }) },
			// A pointerdown inside the bar would collapse the selection and (with it) the
			// host's bar before the press lands, so the selection is preserved.
			onPointerDown: (event) => event.preventDefault(),
			onClick: (event) => {
				event.preventDefault();
				props.onExplain();
			}
		},
		t("textExplain")
	);
}

/**
 * The bubble that writes an explanation out a few characters at a time.
 *
 * It is not a stream: the host answers with one finished JSON definition, so the reveal
 * is what makes the card read as "being written" without pretending to a per-token
 * protocol that does not exist. It sits at the point the gesture opened at and is
 * clamped inside the viewport exactly like the popup, and it is dismissed the same way
 * every other surface here is: Escape, or a press anywhere but its own box. It is never
 * dismissed by itself — the explanation is meant to be read, and collected only when
 * the reader says so.
 *
 * @param props - `view` (`{ term, phase, text, saved, failed, point }`), `t`, `onAdd`, `onClose`.
 * @returns the bubble element.
 */
function ExplainBubble(props) {
	const { view, t } = props;
	const ref = React.useRef(null);
	const [placement, setPlacement] = React.useState(null);

	React.useLayoutEffect(() => {
		const element = ref.current;
		if (element === null || view.point === null || view.point === undefined) return;
		const rect = element.getBoundingClientRect();
		const viewportWidth = globalThis.innerWidth ?? 0;
		const viewportHeight = globalThis.innerHeight ?? 0;
		let left = view.point.x + POINTER_GAP;
		let top = view.point.y + POINTER_GAP;
		if (viewportWidth > 0 && left + rect.width > viewportWidth - EDGE_GAP) left = Math.max(EDGE_GAP, view.point.x - POINTER_GAP - rect.width);
		if (viewportHeight > 0 && top + rect.height > viewportHeight - EDGE_GAP) top = Math.max(EDGE_GAP, view.point.y - POINTER_GAP - rect.height);
		const nextLeft = Math.round(left);
		const nextTop = Math.round(top);
		// Compared before it is written: the effect below re-runs on every reveal tick, and a
		// fresh object on every run would schedule another render, which would schedule another
		// run. The bubble must not install a render loop of its own while writing.
		setPlacement((previous) =>
			previous !== null && previous.left === nextLeft && previous.top === nextTop ? previous : { left: nextLeft, top: nextTop }
		);
	}, [view.term, view.phase, view.text, view.saved, view.point?.x, view.point?.y]);

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

	return h(
		"div",
		{
			ref,
			role: "status",
			"aria-live": "polite",
			"data-term-dictionary": "explain-bubble",
			style: {
				...applyStyles.popup,
				width: "min(320px, calc(100vw - 24px))",
				maxHeight: "min(40vh, 260px)",
				...(placement === null ? { left: "-9999px", top: "-9999px" } : { left: `${placement.left}px`, top: `${placement.top}px` })
			}
		},
		h("div", { style: applyStyles.popupHead }, h("p", { style: applyStyles.popupTerm }, view.term)),
		view.phase === "failed"
			? h("p", { style: applyStyles.error }, t("generateFailed", { message: view.failed }))
			: h("p", { style: applyStyles.popupGloss }, view.phase === "waiting" ? t("popupGenerating") : view.text),
		view.saved ? h("p", { style: applyStyles.popupMeta }, t("explainBubbleSaved")) : null,
		h(
			"div",
			{ style: applyStyles.popupActions },
			view.saved !== true && view.phase !== "waiting" && view.phase !== "failed"
				? h("button", { type: "button", style: applyStyles.primaryButton, onClick: props.onAdd, "data-term-dictionary": "explain-add" }, t("explainAdd"))
				: null,
			h("span", { style: applyStyles.spacer }),
			h("button", { type: "button", style: applyStyles.linkButton, onClick: props.onClose, "aria-label": "close" }, "✕")
		)
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

module.exports = { TermPopup, SelectionAffordance, SelectionExplain, ExplainBubble, Toast, HighlighterStyle, sourceLabel };
