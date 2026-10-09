"use strict";

/**
 * The document's text selection, in the one place every gesture layer asks about it.
 *
 * This module exists because "was that click a selection gesture?" is asked in three places — the
 * panel's rows, the annotated-term click in `hover.js`, and the unannotated-word click in
 * `interact.js` — and the answer has to be the same in all three or the bug simply moves:
 *
 *   - the panel opened its editor on the click that ended a selection made to copy a gloss;
 *   - the transcript switched to the dictionary on the click that ended a selection made to copy a
 *     sentence that happened to end on a marked term.
 *
 * Both are the same mistake — treating a click that FINISHES a selection as a click that CHOOSES
 * something — and this is the shared answer to it.
 *
 * The check is deliberately conservative in one direction only: a selection that is whitespace, or
 * collapsed to a caret, is NOT a selection gesture, because dragging across trailing spaces is not a
 * copy anybody is trying to make. Nothing here prevents a gesture; it only declines to act.
 */

/**
 * Read the live selection, preferring the host the caller was given.
 *
 * The preference matters: a layer built against a specific document or window must read THAT one, and
 * a component with no host of its own (the panel) reads the page's. `globalThis` is the fallback
 * rather than the first choice for exactly that reason.
 *
 * @param host - the document or window to ask first, or undefined.
 * @returns the selection, or null when there is none to read.
 */
function readSelection(host) {
	if (host !== null && host !== undefined && typeof host.getSelection === "function") {
		const local = host.getSelection();
		if (local !== null && local !== undefined) return local;
	}
	if (typeof globalThis.getSelection === "function") {
		const fallback = globalThis.getSelection();
		if (fallback !== null && fallback !== undefined) return fallback;
	}
	return null;
}

/**
 * Whether the user has text selected right now.
 *
 * @param host - the document or window to ask first, or undefined.
 * @returns true for a non-empty, non-whitespace selection that is not merely a caret.
 */
function selectionActive(host) {
	const selection = readSelection(host);
	if (selection === null || typeof selection.toString !== "function") return false;
	// `isCollapsed` is the cheap discriminator and `toString()` the decisive one: a collapsed selection
	// has nothing to copy, and a browser that reports the flag wrongly is still caught by the text.
	if (selection.isCollapsed === true) return false;
	return selection.toString().trim() !== "";
}

/**
 * Whether a non-empty selection lies inside one element.
 *
 * Used by the panel, where the question is narrower than "is anything selected": clicking a row right
 * after selecting part of a REPLY is still a click on the row, and only a selection inside that row
 * means the click was finishing a selection of the row's own text.
 *
 * Every read is defensive: `contains` is absent in the test sandbox, and a row with no selection must
 * behave exactly as it did before this guard existed.
 *
 * @param element - the element the click happened in.
 * @param host - the document or window to ask first, or undefined.
 * @returns true when a non-empty selection lies inside it.
 */
function selectionInside(element, host) {
	if (element === null || element === undefined) return false;
	if (selectionActive(host) !== true) return false;
	if (typeof element.contains !== "function") return false;
	const selection = readSelection(host);
	const node = selection?.anchorNode ?? selection?.focusNode ?? null;
	if (node === null || node === undefined) return false;
	return element.contains(node) === true;
}

module.exports = { readSelection, selectionActive, selectionInside };
