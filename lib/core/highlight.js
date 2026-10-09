"use strict";

/**
 * The annotation layer: marks the terms the dictionary has really collected
 * wherever they appear in the transcript.
 *
 * Why this is a CSS Custom Highlight and not wrapped text
 * ------------------------------------------------------
 * Marking terms by wrapping them in spans means writing into the host's message
 * tree. React owns that tree: the next re-render discards the wrappers, a
 * streaming reply re-renders constantly, and inserting nodes into a virtualized
 * list fights its measurement. The Custom Highlight API paints `Range` objects
 * through the style layer instead, so the DOM the renderer owns is never touched
 * and nothing is left behind when the plugin unloads.
 *
 * What it marks, and what it deliberately does not
 * ------------------------------------------------
 * Only a term backed by one of the user's own entries (`source === "dictionary"`)
 * is marked. A built-in glossary term is still hoverable and clickable, but it has
 * no entry to open, and underlining every word the bundled lexicon can define
 * would mark most of a technical reply — the same "do not make the dictionary
 * bulky" rule the collector follows, applied to the page.
 *
 * The whole module degrades to a no-op where the API is missing: `supported` is
 * false, `refresh` marks nothing, and hover and click keep working.
 */

const { textRuns, readRegion, isProseBlock } = require("./interact.js");

/** The highlight registry key. One page-level layer, one name. */
const HIGHLIGHT_NAME = "term-dictionary-entry";

/**
 * The rule that paints the highlight.
 *
 * Rendered as a component-owned `<style>` element rather than applied inline,
 * because a `::highlight()` rule only exists in a stylesheet. Only theme tokens
 * appear as colors, so light and dark follow without a second rule.
 *
 * The underline is `label-secondary`, not `brand-primary`. In the DARK theme the
 * platform resolves `brand-primary` to `--dsw-static-neutral-bluish-50`, which is the
 * very same value it gives `label-primary` — so a brand-coloured underline under
 * brand-coloured text is invisible, and the marking the feature promises would simply
 * not be there. `label-secondary` is measurably dimmer than the body text in both
 * themes (bluish-700 on light, bluish-300 on dark), which is what makes a marked word
 * readable as marked. The wash behind it comes from the platform's own hover tint,
 * a translucent value in both themes (`#2631480f` light, `#ffffff14` dark).
 */
const HIGHLIGHT_CSS =
	`::highlight(${HIGHLIGHT_NAME}) {` +
	" text-decoration: underline dotted var(--dsw-alias-label-secondary);" +
	" text-decoration-thickness: 1px;" +
	" text-underline-offset: 2px;" +
	" background-color: var(--dsw-alias-interactive-bg-hover, transparent);" +
	" }";

/**
 * Map an offset in a run's collapsed body back to an offset in its text node.
 *
 * `textRuns` builds a run's body by skipping leading whitespace, collapsing every
 * whitespace run to one space and dropping trailing whitespace. This walks the raw
 * text with the same rules, so a range built from run offsets lands on the
 * characters the detector actually matched instead of drifting by the width of the
 * whitespace it removed.
 *
 * @param raw - the text node's value.
 * @param bodyOffset - an offset into the run's `body`, from 0 to `body.length`.
 * @returns the corresponding offset into `raw`.
 */
function rawOffsetForBody(raw, bodyOffset) {
	if (typeof raw !== "string" || raw === "") return 0;
	const target = Math.max(0, Math.floor(bodyOffset));
	let bodyIndex = 0;
	let at = 0;
	// Leading whitespace is trimmed off the body, so offset 0 is the first survivor.
	while (at < raw.length && /\s/.test(raw[at])) at++;
	if (target === 0) return at;
	while (at < raw.length) {
		if (/\s/.test(raw[at])) {
			// The whole run stands for the single space the body carries.
			if (bodyIndex === target) return at;
			bodyIndex++;
			while (at < raw.length && /\s/.test(raw[at])) at++;
			if (bodyIndex === target) return at;
			continue;
		}
		if (bodyIndex === target) return at;
		bodyIndex++;
		at++;
	}
	return raw.length;
}

/**
 * Turn one detected span into DOM ranges, one per run it covers.
 *
 * A phrase can straddle inline elements — `event <strong>sourcing</strong>` is one
 * dictionary term across two text nodes — and a highlight range cannot cross
 * nodes, so such a term yields one range per run. They paint as one continuous
 * marking.
 *
 * @param runs - runs from {@link textRuns}.
 * @param start - the span's start offset in the runs' shared text.
 * @param end - the span's end offset (exclusive).
 * @returns `[{ node, start, end }]`, possibly empty.
 */
function rangesAcrossRuns(runs, start, end) {
	const segments = [];
	for (const run of runs) {
		if (run.end <= start) continue;
		if (run.start >= end) break;
		const from = Math.max(start, run.start) - run.start;
		const to = Math.min(end, run.end) - run.start;
		if (to <= from) continue;
		const raw = run.node?.nodeValue ?? "";
		const nodeStart = rawOffsetForBody(raw, from);
		const nodeEnd = rawOffsetForBody(raw, to);
		if (nodeEnd > nodeStart) segments.push({ node: run.node, start: nodeStart, end: nodeEnd });
	}
	return segments;
}

/**
 * Collect the ranges to paint for one message block.
 *
 * @param block - a block from {@link readRegion}, or any element.
 * @param detector - the current detector generation.
 * @returns `[{ node, start, end, term, key, id }]`.
 */
function rangesForBlock(block, detector) {
	const element = block?.element ?? block;
	if (element === null || element === undefined || detector === null || detector === undefined) return [];
	const { runs, text } = textRuns(element);
	if (text === "" || runs.length === 0) return [];
	// `includeCandidates: false` keeps the weak evidence out: only a term backed by a
	// dictionary or glossary entry is reported, which is exactly the set worth marking.
	const found = detector.scan(text, { includeCandidates: false });
	const collected = [];
	for (const occurrence of found) {
		if (occurrence.known !== true || occurrence.source !== "dictionary") continue;
		for (const segment of rangesAcrossRuns(runs, occurrence.start, occurrence.end)) {
			collected.push({ ...segment, term: occurrence.term, key: occurrence.key, id: occurrence.id });
		}
	}
	return collected;
}

/**
 * Build the page's annotation layer.
 *
 * @param options - `document`, `detector`, and an optional `logger`.
 * @returns `{ supported, setDetector, refresh, clear, count }`.
 */
function createTermHighlighter(options) {
	const doc = options.document ?? globalThis.document;
	const logger = options.logger;
	const registry = globalThis.CSS?.highlights ?? null;
	const HighlightConstructor = globalThis.Highlight ?? null;

	/**
	 * Whether this page can paint a highlight at all. Probed rather than assumed:
	 * an older runtime must lose the marking, not the panel.
	 */
	const supported =
		registry !== null &&
		typeof registry.set === "function" &&
		typeof registry.delete === "function" &&
		typeof HighlightConstructor === "function" &&
		typeof doc?.createRange === "function";

	let detector = options.detector ?? null;
	let painted = 0;

	/** Report a caught failure without breaking the page. */
	function warn(message, error) {
		logger?.warn?.(`term-dictionary: ${message}: ${error instanceof Error ? error.message : String(error)}`);
	}

	/**
	 * The segments behind the current paint.
	 *
	 * KEPT, not discarded, because they are the answer to a second question: "which term is the
	 * pointer on?" The marking already knows every occurrence as a `(node, start, end)` triple,
	 * and a caret is the same kind of coordinate — so the hit test is a lookup in this list rather
	 * than a second text walk with its own matching rules.
	 *
	 * That duplication is what the two-plugin split used to cost: the pointer layer had to fetch
	 * the terms over a route, walk the transcript again, and keep its own matcher, so the two
	 * could disagree about what counts as a marked term — and they did.
	 */
	let segments = [];

	/** Replace every painted range with the given segments. */
	function paint(next) {
		segments = next;
		const built = [];
		for (const segment of next) {
			try {
				const range = doc.createRange();
				range.setStart(segment.node, segment.start);
				range.setEnd(segment.node, segment.end);
				built.push(range);
			} catch (error) {
				// The node was replaced between the read and the paint, which is normal
				// while a reply streams: skip that segment and keep the rest.
				warn("mapping a highlight range failed", error);
			}
		}
		painted = built.length;
		if (built.length === 0) {
			registry.delete(HIGHLIGHT_NAME);
			return 0;
		}
		registry.set(HIGHLIGHT_NAME, new HighlightConstructor(...built));
		return built.length;
	}

	return {
		supported,
		/**
		 * The occurrences currently marked, as `{ node, start, end, term, key, id }`.
		 *
		 * The pointer layer reads this instead of walking the transcript itself.
		 * @returns the segments behind the last paint.
		 */
		segments() {
			return segments;
		},
		/**
		 * Swap in the detector built against the current dictionary.
		 * @param next - the replacement detector.
		 */
		setDetector(next) {
			detector = next ?? null;
		},
		/**
		 * Re-read the transcript and repaint the collected terms in it.
		 * @param region - the conversation region element, or null.
		 * @returns how many ranges are painted.
		 */
		refresh(region) {
			if (!supported) return 0;
			try {
				if (region === null || region === undefined) return paint([]);
				const segments = [];
				for (const block of readRegion(region).blocks) {
					// Code and tool output are not prose, so a term that merely appears in a
					// shell snippet is not marked as if it were part of the reply.
					if (!isProseBlock(block)) continue;
					for (const segment of rangesForBlock(block, detector)) segments.push(segment);
				}
				return paint(segments);
			} catch (error) {
				warn("refreshing the highlight failed", error);
				return painted;
			}
		},
		/** Remove the marking without touching the DOM. */
		clear() {
			if (!supported) return;
			try {
				registry.delete(HIGHLIGHT_NAME);
			} catch (error) {
				warn("clearing the highlight failed", error);
			}
			painted = 0;
		},
		/** How many ranges the last paint produced. */
		count() {
			return painted;
		}
	};
}

module.exports = {
	createTermHighlighter,
	rangesForBlock,
	rangesAcrossRuns,
	rawOffsetForBody,
	HIGHLIGHT_NAME,
	HIGHLIGHT_CSS
};
