"use strict";

/**
 * The hover card: the brief explanation shown while the pointer rests on a marked term.
 *
 * Moved in from `dsh-plugin-term-wikilink` with one change of substance — the content now comes
 * from this plugin's own store and detector instead of a fetched term list, so there is no
 * "the dictionary is unreachable" state to degrade into.
 *
 * Two properties are deliberate and worth keeping:
 *
 *  - it is a fixed-position overlay, because the transcript belongs to the host renderer and a
 *    plugin must not write into it;
 *  - it carries `pointer-events: none`, because the card is a reading aid and the click that opens
 *    the entry has to reach the text underneath it.
 *
 * `data-term-dictionary="hover-card"` marks it as one of this plugin's own surfaces, which is what
 * keeps the layer from treating the card itself as a term (the marker is in the plugin's blocked
 * set).
 */

const React = require("react");

const h = React.createElement;

/** The registry key and the cursor class, shared with the pointer layer that creates them. */
const { ACTIVE_HIGHLIGHT, HOT_CLASS } = require("./hover.js");

/** Gap between the term's box and the card. */
const ANCHOR_GAP = 10;

/** Minimum distance from a viewport edge. */
const EDGE_GAP = 10;

/** Shared surface recipe, kept to theme tokens the platform actually defines. */
const SURFACE = {
	background: "var(--dsw-alias-bg-overlay)",
	border: "0.5px solid var(--dsw-alias-border-l2)",
	borderRadius: "var(--dsw-radius-lg, 12px)"
};

const STYLES = {
	card: {
		...SURFACE,
		position: "fixed",
		zIndex: 2147482000,
		width: "min(340px, calc(100vw - 24px))",
		maxHeight: "min(52vh, 360px)",
		overflowY: "auto",
		boxShadow: "0 10px 30px rgba(0, 0, 0, 0.22)",
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: "6px",
		font: "inherit",
		color: "var(--dsw-alias-label-primary)",
		// The card must never eat a pointer event: the click belongs to the term underneath.
		pointerEvents: "none"
	},
	head: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
	term: { margin: 0, fontSize: "15px", fontWeight: 600, lineHeight: 1.3 },
	zh: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)" },
	domain: {
		fontSize: "10px",
		lineHeight: 1.7,
		padding: "0 6px",
		borderRadius: "999px",
		color: "var(--dsw-alias-label-secondary)",
		background: "var(--dsw-alias-bg-layer-2, transparent)",
		border: "0.5px solid var(--dsw-alias-border-l2)"
	},
	gloss: { margin: 0, fontSize: "13px", lineHeight: 1.7, color: "var(--dsw-alias-label-secondary)", whiteSpace: "pre-wrap" },
	glossMuted: { margin: 0, fontSize: "13px", fontStyle: "italic", color: "var(--dsw-alias-label-tertiary)" },
	usage: {
		margin: 0,
		fontSize: "12px",
		lineHeight: 1.6,
		color: "var(--dsw-alias-label-tertiary)",
		paddingLeft: "8px",
		borderLeft: "2px solid var(--dsw-alias-border-l2)",
		whiteSpace: "pre-wrap"
	},
	footer: {
		margin: 0,
		paddingTop: "6px",
		borderTop: "0.5px solid var(--dsw-alias-border-l2)",
		fontSize: "11px",
		color: "var(--dsw-alias-brand-primary, var(--dsw-alias-label-secondary))"
	}
};

/**
 * The card itself.
 *
 * @param props - `entry` (`{ term, zh, gloss, usage, domain }`), `anchor`, `t`.
 * @returns the card element.
 */
function HoverCard(props) {
	const { entry, anchor, t } = props;
	const ref = React.useRef(null);
	const [placement, setPlacement] = React.useState(null);

	// Measure after paint, then pull the box back inside the viewport. The anchor is the TERM's
	// box: anchoring to the pointer made the card follow the mouse, which reads as jitter rather
	// than as a tooltip. A card belongs to the word.
	React.useLayoutEffect(() => {
		const element = ref.current;
		if (element === null || anchor === null || anchor === undefined) return;
		const box = element.getBoundingClientRect();
		const width = globalThis.innerWidth ?? 0;
		const height = globalThis.innerHeight ?? 0;
		let left = anchor.left;
		let top = anchor.bottom + ANCHOR_GAP;
		// No room below the word: open above it, the way a tooltip should.
		if (height > 0 && top + box.height > height - EDGE_GAP) top = Math.max(EDGE_GAP, anchor.top - ANCHOR_GAP - box.height);
		if (width > 0 && left + box.width > width - EDGE_GAP) left = Math.max(EDGE_GAP, width - EDGE_GAP - box.width);
		setPlacement({ left: Math.round(left), top: Math.round(top) });
	}, [anchor?.left, anchor?.top, anchor?.bottom, entry?.key, entry?.gloss]);

	const gloss = typeof entry?.gloss === "string" ? entry.gloss : "";
	const style = {
		...STYLES.card,
		...(placement === null ? { left: "-9999px", top: "-9999px" } : { left: `${placement.left}px`, top: `${placement.top}px` })
	};

	return h(
		"div",
		{ ref, style, role: "tooltip", "aria-label": entry?.term ?? "", "data-term-dictionary": "hover-card" },
		h(
			"div",
			{ style: STYLES.head },
			h("p", { style: STYLES.term }, entry?.term ?? ""),
			entry?.zh !== undefined && entry?.zh !== "" ? h("span", { style: STYLES.zh }, entry.zh) : null,
			entry?.domain !== undefined && entry?.domain !== "" ? h("span", { style: STYLES.domain }, entry.domain) : null
		),
		gloss !== "" ? h("p", { style: STYLES.gloss }, gloss) : h("p", { style: STYLES.glossMuted }, t("hoverNoGloss")),
		entry?.usage !== undefined && entry?.usage !== "" ? h("p", { style: STYLES.usage }, entry.usage) : null,
		h("p", { style: STYLES.footer }, t("hoverOpenEntry"))
	);
}

/**
 * The stylesheet the pointer layer needs, rendered as an element so unmounting removes it.
 *
 * Two rules, neither of which can be an inline style:
 *
 *  - `::highlight(term-dictionary-active)` is the hovered term's emphasis. The transcript word has
 *    no element to give a class to — it is painted through the CSS Custom Highlight API — so "this
 *    link is live" can only be expressed as a highlight. It sits above the annotation's own
 *    marking by `priority`.
 *  - `.term-dictionary-hot` is the cursor. `cursor` is NOT one of the properties `::highlight()`
 *    may set, and the browser shows an I-beam over selectable text, which reads as plain text —
 *    the opposite of a link. The class goes on the conversation body for exactly as long as the
 *    pointer is on a term, so the rest of the reply keeps its normal cursor, and `!important` is
 *    needed because the host's own text rules set a text cursor.
 *
 * @returns the style element.
 */
function HoverStyle() {
	return h(
		"style",
		{ "data-term-dictionary": "hover-style" },
		`::highlight(${ACTIVE_HIGHLIGHT}) {` +
			" background-color: var(--dsw-alias-interactive-bg-hover, rgba(77, 107, 254, 0.16));" +
			" text-decoration: underline solid var(--dsw-alias-brand-primary, #4d6bfe);" +
			" text-decoration-thickness: 2px;" +
			" text-underline-offset: 2px;" +
			" }" +
			`.${HOT_CLASS}, .${HOT_CLASS} * { cursor: pointer !important; }`
	);
}

module.exports = { HoverCard, HoverStyle, STYLES };
