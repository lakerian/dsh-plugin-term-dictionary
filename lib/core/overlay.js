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
// The host's text bar is a plain container that other plugins' items are rendered into
// through React, so a portal is the only way to put this plugin's item INSIDE the same
// bar. react-dom is a platform module for client bundles; an environment that has no
// react-dom (a test harness, or a host without it) falls back to the plugin's own
// fixed-position button instead of failing to load.
let createPortal = null;
try {
	({ createPortal } = require("react-dom"));
} catch {
	createPortal = null;
}
const { applyStyles } = require("./styles.js");
const { formatStamp } = require("./core.js");
const { HIGHLIGHT_CSS } = require("./highlight.js");

const h = React.createElement;

/** Gap between the pointer and the popup's corner. */
const POINTER_GAP = 10;

/** Minimum distance from a viewport edge. */
const EDGE_GAP = 8;

/**
 * How long the selection button waits for the host's bar before standing on its own.
 *
 * The bar mounts a few frames after the selection does (the host opens it when the
 * gesture ends), so the button must not conclude "there is no bar" from the first
 * frame. A third of a second is long enough for that mount and short enough that a
 * session without the bar still gets the button promptly.
 */
const FALLBACK_FRAMES = 18;

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
 * The "explain" item that joins the host's own text bar.
 *
 * The host renders one keyed entry per gesture, so a second plugin cannot register a
 * second item through the registry: the bar's single slot is already taken by the
 * quotes plugin. But the bar is a plain positioned container that the host mounts
 * itself, and a React portal can render this button inside that container. The two
 * items then share the bar's own chrome and layout, so a selection shows ONE menu with
 * 「引用文本」「解释」 on it — rather than two floating pills that have to be aligned by
 * hand and, measured at the wrong moment, overlap.
 *
 * When no visible surface exists (no text-interaction service, or a session the quotes
 * plugin refuses to open on), the same button falls back to standing above the
 * selection on its own: there is no bar in that case, so there is nothing to overlap.
 *
 * @param props - `selection` (`{ term, rect }`), `t`, `onExplain`.
 * @returns the button, portalled into the host's bar when one is visible.
 */
function SelectionExplain(props) {
	const { selection, t } = props;
	const ref = React.useRef(null);
	const hostRef = React.useRef(null);
	const misses = React.useRef(0);
	const [host, setHost] = React.useState(null);
	const [position, setPosition] = React.useState(null);

	React.useLayoutEffect(() => {
		misses.current = 0;
		const measure = (element) => {
			if (element === null || element === undefined) return null;
			if (typeof element.getBoundingClientRect !== "function") return null;
			const rect = element.getBoundingClientRect();
			return rect !== null && rect !== undefined && rect.width > 0 && rect.height > 0 ? rect : null;
		};
		const boxOf = (surface) => {
			const own = measure(surface);
			if (own !== null) return own;
			const anchor = measure(surface.firstElementChild);
			if (anchor !== null) return anchor;
			const inner = typeof surface.querySelector === "function" ? surface.querySelector("button") : null;
			return measure(inner);
		};
		const findHost = () => {
			if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
			const surfaces = Array.from(document.querySelectorAll("[data-text-interaction-surface]"));
			const anchor = selection?.rect;
			let best = null;
			let bestDistance = Infinity;
			for (const surface of surfaces) {
				if (surface === null || surface === undefined) continue;
				if (surface.getAttribute?.("aria-hidden") === "true") continue;
				// The slot outlet inside the bar is a `display:contents` anchor: it generates
				// no box of its own, so its rect measures 0 and taking the first child's box
				// would skip every real bar. The surface itself is a positioned, max-content
				// box — measure that first, and only reach into its children when it is empty.
				const rect = boxOf(surface);
				if (rect === null) continue;
				const distance = anchor === undefined || anchor === null ? 0 : Math.abs(rect.left - anchor.left) + Math.abs(rect.top - anchor.top);
				if (distance < bestDistance) {
					best = surface;
					bestDistance = distance;
				}
			}
			return best;
		};
		const place = () => {
			const surface = findHost();
			if (surface !== null) {
				if (hostRef.current !== surface) {
					hostRef.current = surface;
					setHost(surface);
				}
				return;
			}
			// The bar mounts a frame or two after the selection does, and it can also be closed
			// and reopened while the selection stays. The search therefore repeats for as long
			// as the button is mounted: giving up after a couple of frames is what left the
			// button standing on its own above a bar that appeared a moment later — the two
			// exactly on top of each other.
			misses.current += 1;
			// A bar that closes under a still-live selection (a dismiss, or the next gesture
			// taking the surface over) must not keep the button portalled into a hidden
			// container: let go of it, and the fallback below stands the button back up in the
			// page.
			if (hostRef.current !== null) {
				hostRef.current = null;
				setHost(null);
			}
			if (misses.current < FALLBACK_FRAMES) return;
			const element = ref.current;
			if (element === null) return;
			const anchor = selection?.rect;
			if (anchor === undefined || anchor === null) return;
			const own = element.getBoundingClientRect();
			const viewportWidth = globalThis.innerWidth ?? 0;
			const viewportHeight = globalThis.innerHeight ?? 0;
			let left = anchor.left;
			let top = anchor.top - own.height - 6;
			if (top < EDGE_GAP && anchor.bottom !== undefined) top = anchor.bottom + 6;
			if (viewportHeight > 0 && top + own.height > viewportHeight - EDGE_GAP) top = Math.max(EDGE_GAP, top - own.height - 12);
			if (viewportWidth > 0) left = Math.min(left, Math.max(EDGE_GAP, viewportWidth - own.width - EDGE_GAP));
			left = Math.max(EDGE_GAP, left);
			top = Math.max(EDGE_GAP, top);
			setPosition((previous) =>
				previous !== null && previous.left === Math.round(left) && previous.top === Math.round(top) ? previous : { left: Math.round(left), top: Math.round(top) }
			);
		};
		// A repeating frame loop, not a couple of one-shot attempts: `frame = schedule()` lives
		// inside `tick`, so every frame looks again and the next one is always queued. The old
		// shape scheduled the second look directly, and that look never rescheduled — the loop
		// ran twice and stopped, which is why a bar arriving later was never seen.
		let stopped = false;
		let frame = 0;
		const schedule = () => {
			const raf = globalThis.requestAnimationFrame;
			return typeof raf === "function" ? raf(tick) : 0;
		};
		const tick = () => {
			if (stopped) return;
			place();
			frame = schedule();
		};
		tick();
		return () => {
			stopped = true;
			if (frame !== 0) globalThis.cancelAnimationFrame?.(frame);
		};
	}, [selection?.term, selection?.rect?.top, selection?.rect?.bottom, selection?.rect?.left]);

	const button = h(
		"button",
		{
			ref,
			type: "button",
			// No `title`: a native tooltip reading 「解释「term」」 pops over the bar while the
			// reader is aiming at it, and adds nothing the visible label and aria-label do not.
			"aria-label": t("textExplainTitle", { term: selection?.term ?? "" }),
			"data-term-dictionary": "selection-explain",
			style:
				host === null
					? { ...applyStyles.textAction, position: "fixed", zIndex: 2147483000, ...(position === null ? { left: "-9999px", top: "-9999px" } : { left: `${position.left}px`, top: `${position.top}px` }) }
					: // Inside the bar the two items flow side by side; the gap keeps them from
						// merging into one wide pill. The bar has no flex layout, so a margin is
						// what separates them, and `vertical-align` keeps the two pills on one line.
						{ ...applyStyles.textAction, marginLeft: 8, whiteSpace: "nowrap", verticalAlign: "middle" },
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
	if (host !== null && typeof createPortal === "function") return createPortal(button, host);
	return button;
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
			// The offer to keep the term only appears once the explanation has been written
			// out: reading "add to dictionary" over a half-written sentence suggested the
			// definition was already complete when it was still arriving.
			view.saved !== true && view.complete === true
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
