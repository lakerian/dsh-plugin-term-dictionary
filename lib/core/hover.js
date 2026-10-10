"use strict";

/**
 * The pointer layer: the hover card, the pointer cursor, and the click that opens an entry.
 *
 * This is `dsh-plugin-term-wikilink`'s pointer layer, moved in and made smaller by the move.
 *
 * What the move removed
 * --------------------
 * As a separate plugin this layer had to FETCH the terms (`/dsh-term-dictionary/state`, with a
 * `localStorage` fallback), walk the transcript a second time, and carry its own matcher — so two
 * independent pieces of code decided what counts as a marked term, and they disagreed: the marking
 * painted inline-code words that the hit test then refused, which is what "underlined but nothing
 * happens" was. It also had to find the dictionary's row by DOM marker (`data-term-entry`) to
 * reveal an entry, because the panel belonged to another plugin.
 *
 * Inside the dictionary all three disappear:
 *
 *  - the terms are here, and the ANNOTATION already computes every occurrence as a
 *    `(node, start, end)` triple, filtered to the entries a reader would want explained
 *    (`highlight.js`). A caret is the same kind of coordinate, so the hit test is a lookup in
 *    that list — one text walk in the whole plugin, one matching rule;
 *  - revealing an entry is a call to the panel this plugin already owns.
 *
 * The three behaviours worth naming, all of them learned the hard way:
 *
 *  - **the region comes from the event's own target**, every time. The host can mount more than
 *    one conversation body, and `querySelector` returns the document-order first, which may be
 *    the hidden one;
 *  - **listeners are registered in the CAPTURE phase.** React 17+ delegates to the root container
 *    below `document`, so any `stopPropagation()` in the tree silences a bubble-phase listener —
 *    indistinguishable from "the page produced no event";
 *  - **the delay governs APPEARING only.** Leaving closes at once: a card that waits out a timer
 *    after the pointer has gone reads as lag, not as composure.
 */

/** The conversation BODY. The bare attribute also matches the composer seat inside it. */
const CHAT_SELECTOR = '[data-conversation-region="chat"]';

/** How long the pointer must rest on a term before the card appears. */
const HOVER_DELAY_MS = 110;

/**
 * The highlight registry key for the term the pointer is on. Distinct from the annotation's own
 * name, and given a higher priority so the hovered word reads as the live one.
 */
const ACTIVE_HIGHLIGHT = "term-dictionary-active";

/** The class put on the conversation body while the pointer is on a term, for the cursor rule. */
const HOT_CLASS = "term-dictionary-hot";

const { selectionActive } = require("./selection.js");

/**
 * Turn a caret into a text node plus an offset inside it.
 *
 * A caret may land on an element (between two children) rather than on a character; that is
 * resolved to the start of the following text, or to the end of the preceding one.
 *
 * @param caret - `{ startContainer, startOffset }`.
 * @param document - the document to build a walker with.
 * @returns `{ node, offset }`, or null when no text can be found.
 */
function resolveCaret(caret, document) {
	const container = caret?.startContainer;
	if (container === null || container === undefined) return null;
	if (container.nodeType === 3) {
		const length = container.nodeValue?.length ?? 0;
		return { node: container, offset: Math.max(0, Math.min(caret.startOffset ?? 0, length)) };
	}
	if (container.nodeType !== 1) return null;
	const children = Array.from(container.childNodes ?? []);
	const following = children[caret.startOffset ?? 0];
	if (following !== undefined) {
		if (following.nodeType === 3) return { node: following, offset: 0 };
		const inner = firstTextNode(following);
		if (inner !== null) return { node: inner, offset: 0 };
	}
	const last = lastTextNode(container);
	return last === null ? null : { node: last, offset: last.nodeValue?.length ?? 0 };
}

/**
 * The first text node inside a subtree.
 * @param root - the subtree root.
 * @returns the node, or null.
 */
function firstTextNode(root) {
	for (const child of Array.from(root.childNodes ?? [])) {
		if (child.nodeType === 3 && (child.nodeValue ?? "") !== "") return child;
		if (child.nodeType === 1) {
			const found = firstTextNode(child);
			if (found !== null) return found;
		}
	}
	return null;
}

/**
 * The last text node inside a subtree.
 * @param root - the subtree root.
 * @returns the node, or null.
 */
function lastTextNode(root) {
	const children = Array.from(root.childNodes ?? []);
	for (let at = children.length - 1; at >= 0; at--) {
		const child = children[at];
		if (child.nodeType === 3 && (child.nodeValue ?? "") !== "") return child;
		if (child.nodeType === 1) {
			const found = lastTextNode(child);
			if (found !== null) return found;
		}
	}
	return null;
}

/**
 * Build the pointer layer.
 *
 * @param options - `document`, `segments` (a thunk returning the marked occurrences), `delays`
 *   (a thunk returning `{ inMs, outMs }`), `onOpen`, `onActivate`, `onClose`, `logger`.
 * @returns `{ attach, detach, close, matchAt, stats, view }`.
 */
function createHoverLayer(options) {
	const doc = options.document ?? globalThis.document;
	const logger = options.logger ?? null;
	const readSegments = typeof options.segments === "function" ? options.segments : () => [];
	const readDelays = typeof options.delays === "function" ? options.delays : () => null;
	const onOpen = typeof options.onOpen === "function" ? options.onOpen : null;
	const onActivate = typeof options.onActivate === "function" ? options.onActivate : null;
	const onClose = typeof options.onClose === "function" ? options.onClose : null;

	/**
	 * The two delays, read fresh for every gesture.
	 *
	 * A thunk rather than two numbers copied at attach time: the settings page is a few centimetres
	 * away from the transcript, and a knob that only takes effect after a reload is a knob nobody
	 * trusts. Defaults match the constants so the layer is usable on its own — in a test, or before
	 * the settings store has hydrated.
	 *
	 * @returns `{ inMs, outMs }`, both whole milliseconds.
	 */
	function delays() {
		const raw = readDelays() ?? {};
		const inMs = Number.isFinite(raw.inMs) ? Math.max(0, Math.round(raw.inMs)) : HOVER_DELAY_MS;
		const outMs = Number.isFinite(raw.outMs) ? Math.max(0, Math.round(raw.outMs)) : 0;
		return { inMs, outMs };
	}

	/** The card's state, kept outside React so the listeners can drive it. */
	let view = { kind: "closed" };
	const viewListeners = new Set();
	const setView = (next) => {
		view = next;
		for (const listener of [...viewListeners]) listener();
	};

	let hoverTimer = null;
	/** The pending exit, when the user has asked for a grace period. */
	let closeTimer = null;
	let hoverPoint = null;
	let hotRegion = null;
	/** The conversation body the pointer was last inside, for the cursor class. */
	let activeRegion = null;
	let attached = false;

	const stats = { moves: 0, inRegion: 0, lookups: 0, hits: 0, clicks: 0, opens: 0, closes: 0 };

	/** Report a caught failure without breaking the page. */
	function warn(message, error) {
		logger?.warn?.(`term-dictionary: ${message}: ${error instanceof Error ? error.message : String(error)}`);
	}

	/**
	 * The conversation body an event happened in, or null when it is not in a transcript.
	 * @param target - the event target.
	 * @returns the region element, or null.
	 */
	function regionFromTarget(target) {
		if (target === null || target === undefined || typeof target.closest !== "function") return null;
		return target.closest(CHAT_SELECTOR);
	}

	/** Resolve the caret under a point through either browser API. */
	function caretAt(x, y) {
		if (typeof doc?.caretRangeFromPoint === "function") {
			const range = doc.caretRangeFromPoint(x, y);
			if (range !== null && range !== undefined) return range;
		}
		if (typeof doc?.caretPositionFromPoint === "function") {
			const position = doc.caretPositionFromPoint(x, y);
			if (position !== null && position !== undefined && position.offsetNode != null) {
				const range = doc.createRange();
				range.setStart(position.offsetNode, position.offset);
				range.collapse(true);
				return range;
			}
		}
		return null;
	}

	/**
	 * How far left of the caret a pointer may still count as being on the text.
	 *
	 * The space before a word is enough: landing in it resolves the caret to the word's own start, and a
	 * reader aiming at the first letter often lands there. A paragraph's left margin is tens of pixels, which
	 * is what this has to reject.
	 */
	const LEFT_TOLERANCE_PX = 8;

	/**
	 * Whether the caret a point resolved to actually sits at that point.
	 *
	 * `caretRangeFromPoint` CLAMPS horizontally: a point in the left margin of a line resolves to the line's
	 * start, offset 0. When a term begins that line, offset 0 IS that term — so every point from the panel's
	 * left edge to the first character read as "on the term", and the card opened from anywhere in the margin,
	 * with a click to match. That is how this was reported.
	 *
	 * The caret's own rectangle is the live proof of where the text is: it is measured from the document at
	 * this instant, so unlike a block snapshot it cannot go stale. One measurement per event, and only once a
	 * caret has been found at all.
	 *
	 * @param x - viewport x of the pointer.
	 * @param caret - the Range the point resolved to.
	 * @returns true when the caret is at the pointer rather than clamped to the start of a line.
	 */
	function caretIsAt(x, caret) {
		let rect = null;
		try {
			rect = typeof caret?.getBoundingClientRect === "function" ? caret.getBoundingClientRect() : null;
		} catch (error) {
			rect = null;
		}
		// A browser (or a fixture) that cannot answer is trusted: refusing every hover because one optional
		// measurement is missing would be a worse failure than the one being fixed. An all-zero rectangle says
		// the same thing in another shape — a detached or not-yet-laid-out range.
		if (rect === null || (rect.left === 0 && rect.top === 0 && rect.width === 0 && rect.height === 0)) return true;
		return rect.left <= x + LEFT_TOLERANCE_PX;
	}

	/**
	 * The marked occurrence under a point.
	 *
	 * A caret on a boundary belongs to both neighbours; the narrower span wins, and among equal
	 * spans the one that starts AT the caret does — a caret on the first character means that
	 * word, not the one ending there.
	 *
	 * @param x - viewport x.
	 * @param y - viewport y.
	 * @returns the segment, or null.
	 */
	function matchAt(x, y) {
		const caret = caretAt(x, y);
		if (caret === null) return null;
		if (!caretIsAt(x, caret)) return null;
		const at = resolveCaret(caret, doc);
		if (at === null) return null;
		let best = null;
		for (const segment of readSegments()) {
			if (segment.node !== at.node) continue;
			if (at.offset < segment.start || at.offset > segment.end) continue;
			if (best === null) {
				best = segment;
				continue;
			}
			const span = segment.end - segment.start;
			const bestSpan = best.end - best.start;
			if (span < bestSpan || (span === bestSpan && segment.start > best.start)) best = segment;
		}
		return best;
	}

	/** A DOM Range over one segment, for its box and for the emphasis. */
	function rangeOf(segment) {
		if (typeof doc?.createRange !== "function") return null;
		try {
			const range = doc.createRange();
			range.setStart(segment.node, segment.start);
			range.setEnd(segment.node, segment.end);
			return range;
		} catch (error) {
			return null;
		}
	}

	/** Mark one occurrence as the live link: an emphasis, and a pointer cursor. */
	function setActive(segment, region) {
		clearActive();
		const range = rangeOf(segment);
		if (range === null) return;
		try {
			const registry = globalThis.CSS?.highlights ?? null;
			const HighlightConstructor = globalThis.Highlight ?? null;
			if (registry !== null && typeof registry.set === "function" && typeof HighlightConstructor === "function") {
				const highlight = new HighlightConstructor(range);
				try {
					highlight.priority = 1;
				} catch (error) {
					void error;
				}
				registry.set(ACTIVE_HIGHLIGHT, highlight);
			}
		} catch (error) {
			warn("marking the hovered term failed", error);
		}
		try {
			if (typeof region?.classList?.add === "function") {
				region.classList.add(HOT_CLASS);
				hotRegion = region;
			}
		} catch (error) {
			void error;
		}
	}

	/** Drop the emphasis and the pointer cursor. */
	function clearActive() {
		try {
			const registry = globalThis.CSS?.highlights ?? null;
			if (registry !== null && typeof registry.delete === "function") registry.delete(ACTIVE_HIGHLIGHT);
		} catch (error) {
			void error;
		}
		try {
			if (hotRegion !== null && typeof hotRegion.classList?.remove === "function") hotRegion.classList.remove(HOT_CLASS);
		} catch (error) {
			void error;
		}
		hotRegion = null;
	}

	/** Hide the card, dropping the emphasis with it. */
	function close() {
		cancelClose();
		clearActive();
		if (view.kind !== "closed") {
			stats.closes++;
			setView({ kind: "closed" });
			if (onClose !== null) onClose();
		}
	}

	/** Drop a pending exit, because the pointer came back to a term. */
	function cancelClose() {
		if (closeTimer !== null) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
	}

	/**
	 * Leave the term: at once by default, or after the configured grace period.
	 *
	 * The grace period has to be CANCELLABLE, which is the whole reason it is a timer and not a
	 * sleep: without that, moving from one marked term to the next would schedule a close on leaving
	 * the first and then close the second one's card from under the pointer.
	 */
	function leaveTerm() {
		const { outMs } = delays();
		if (outMs <= 0) {
			close();
			return;
		}
		if (closeTimer !== null) clearTimeout(closeTimer);
		closeTimer = setTimeout(() => {
			closeTimer = null;
			close();
		}, outMs);
	}

	/** The card's anchor: the term's own box, never the pointer. */
	function anchorOf(segment) {
		const range = rangeOf(segment);
		if (range === null) return null;
		try {
			const box = range.getBoundingClientRect();
			if (box === null || box === undefined) return null;
			if (box.width === 0 && box.height === 0) return null;
			return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
		} catch (error) {
			return null;
		}
	}

	/** Resolve the resting pointer to a card, or close the card. */
	function resolveHover() {
		hoverTimer = null;
		const point = hoverPoint;
		if (point === null) return;
		stats.lookups++;
		const segment = matchAt(point.x, point.y);
		if (segment === null) {
			leaveTerm();
			return;
		}
		// A term is under the pointer, so any pending exit is void.
		cancelClose();
		if (view.kind === "open" && view.segment.key === segment.key) return;
		stats.hits++;
		setActive(segment, activeRegion);
		const anchor = anchorOf(segment);
		setView({ kind: "open", segment, anchor });
		if (onOpen !== null) onOpen(segment, anchor);
	}

	/**
	 * React to pointer movement.
	 * @param event - the pointer event.
	 */
	function onPointerMove(event) {
		stats.moves++;
		const region = regionFromTarget(event.target);
		activeRegion = region;
		if (region === null) {
			hoverPoint = null;
			if (hoverTimer !== null) {
				clearTimeout(hoverTimer);
				hoverTimer = null;
			}
			close();
			return;
		}
		stats.inRegion++;
		hoverPoint = { x: event.clientX, y: event.clientY };
		// A card that is DISAPPEARING must not wait for the ENTRY delay. That delay exists so a card
		// does not flash while the pointer crosses a word on its way somewhere else — an argument
		// about appearing, not about leaving. Leaving has its own delay, and it defaults to zero.
		if (view.kind === "open") {
			const segment = matchAt(hoverPoint.x, hoverPoint.y);
			if (segment !== null && segment.key === view.segment.key) {
				cancelClose();
				return;
			}
			leaveTerm();
			return;
		}
		if (hoverTimer !== null) clearTimeout(hoverTimer);
		hoverTimer = setTimeout(resolveHover, delays().inMs);
	}

	/**
	 * React to a click: open the entry of the term under the pointer.
	 * @param event - the click event.
	 */
	function onClick(event) {
		if (event.button !== 0 || event.altKey === true || event.metaKey === true) return;
		stats.clicks++;
		if (regionFromTarget(event.target) === null) return;
		// A click that ENDS a selection is a selection gesture, not a choice.
		//
		// This layer handles the words the dictionary already knows — which are exactly the words a
		// person selects while copying a sentence out of a reply. Dragging across one and releasing on
		// it used to switch the whole main region to the dictionary, so the sentence being copied was
		// replaced by an entry page. `interact.js` has guarded its own click path for as long as it has
		// had one; this path was added later and never got the guard, and the two now share one answer
		// (`selection.js`) so they cannot drift apart again.
		if (selectionActive(doc)) return;
		const segment = matchAt(event.clientX, event.clientY);
		if (segment === null) return;
		stats.opens++;
		close();
		if (onActivate !== null) onActivate(segment);
	}

	/** Bind every listener. */
	function attach() {
		if (attached) return;
		attached = true;
		const onKeyDown = (event) => {
			if (event.key === "Escape") close();
		};
		const onScroll = () => close();
		// Capture on all four: see the note at the top of this file.
		doc.addEventListener("pointermove", onPointerMove, true);
		doc.addEventListener("click", onClick, true);
		doc.addEventListener("keydown", onKeyDown, true);
		globalThis.addEventListener?.("scroll", onScroll, true);
		options.disposers.push(() => doc.removeEventListener("pointermove", onPointerMove, true));
		options.disposers.push(() => doc.removeEventListener("click", onClick, true));
		options.disposers.push(() => doc.removeEventListener("keydown", onKeyDown, true));
		options.disposers.push(() => globalThis.removeEventListener?.("scroll", onScroll, true));
	}

	/** Remove every listener and timer. */
	function detach() {
		attached = false;
		if (hoverTimer !== null) clearTimeout(hoverTimer);
		hoverTimer = null;
		cancelClose();
		hoverPoint = null;
		close();
	}

	return {
		attach,
		detach,
		close,
		matchAt,
		stats,
		view: {
			getSnapshot: () => view,
			subscribe: (listener) => {
				viewListeners.add(listener);
				return () => viewListeners.delete(listener);
			}
		}
	};
}

module.exports = { createHoverLayer, resolveCaret, ACTIVE_HIGHLIGHT, HOT_CLASS, HOVER_DELAY_MS };
