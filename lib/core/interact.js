"use strict";

/**
 * Everything the plugin does inside the conversation, kept in one place because
 * both jobs share the same read of the transcript:
 *
 *  - **auto-collection**: watch the rendered transcript, and when a message stops
 *    changing, collect the terminology in it;
 *  - **selection to create**: a selection inside a reply grows a small
 *    "add to dictionary" affordance next to it.
 *
 * It also owns the transcript region the annotation layer paints on, and the settled
 * pass that tells that layer when the transcript changed.
 *
 * It never mutates the transcript: no wrapping spans, no injected nodes, no
 * React interference. Selection geometry is read from the render tree with `Range`,
 * which is what makes this safe to run over the host's virtualized message list.
 *
 * There is deliberately no pointer hit test here. Resolving "which term is under this
 * coordinate" means a cached box per message plus an offset mapping for the assembled
 * text, and both go wrong in a real page rather than in a fixture: the transcript
 * remounts, the cached elements detach, every `getBoundingClientRect()` reads 0, and
 * every gesture is refused. Hover and click now belong to `dsh-plugin-term-wikilink`,
 * which indexes `(text node, offset)` pairs and asks the event which region it happened
 * in, so it holds nothing that can go stale.
 */

const core = require("./core.js");

const {
	normalizeTerm,
	termId,
	contextAround,
	isTermShaped,
	looksLikeIdentifier,
	isAcronym,
	hasTechnicalMorphology,
	tokenize
} = core;

/**
 * Message root inside the conversation region.
 *
 * The chat region is the conversation BODY, and the composer is a seat *inside*
 * it (`data-composer-seat`, itself tagged `data-conversation-region="composer"`).
 * The region therefore is not the same thing as "the messages": reading it
 * wholesale would fold every message into one block and sweep in the user's
 * unsent draft. {@link readRegion} cuts the composer out, and every reader here
 * goes through it.
 *
 * The value `chat` is part of the selector on purpose. The host tags BOTH nodes with
 * the same attribute name — the body with `="chat"` and the seat nested inside it with
 * `="composer"` — so the bare attribute would make every pointer test here ambiguous
 * about which of the two it had adopted, and the composer would be a legal answer.
 */
const REGION_SELECTOR = '[data-conversation-region="chat"]';

/** The composer seat, which is inside the region and must never be read as a message. */
const COMPOSER_SELECTOR = "[data-composer-seat], [data-conversation-region='composer']";

/** The scrolling element whose mutations drive auto-collection. */
const SCROLL_SELECTOR = "[data-conversation-scroll]";

/** Containers whose text is data rather than prose. */
const SKIP_SELECTOR = "pre, code, a, [data-lexical-editor], [contenteditable=true], [data-term-dictionary]";

/**
 * Code and tool output.
 *
 * A hit here may still be EXPLAINED — an identifier the dictionary already holds is worth
 * reading wherever it appears — but it may never offer to CREATE an entry, because a code
 * identifier is data, not prose the user is reading.
 */
const DATA_SELECTOR = "pre, code";

/**
 * Containers that never resolve a term at all.
 *
 * `SKIP_SELECTOR` minus code, plus the composer. This is the gate that used to be
 * `SKIP_SELECTOR`, and that is what made the feature look broken: terms are collected and
 * MARKED inside inline code (the surrounding block is prose, so the block passes
 * `isProseBlock`), while the hit test refused every hit inside `code`. The marked words the
 * user actually reaches for — `runInTransaction`, `elementFromPoint`, the identifiers — are
 * exactly the inline-code ones, so underlined words could not be hovered or clicked at all.
 *
 * The marking and the interaction have to agree about what is interactive; either both
 * include code or neither does. Both include it now, except for the create affordance.
 */
const BLOCKED_SELECTOR = "a, [data-lexical-editor], [contenteditable=true], [data-term-dictionary]";

/** Tags whose text starts a new line, so the caret-to-offset walk can join text nodes correctly. */
const BLOCK_TAGS = new Set([
	"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
	"FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
	"NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"
]);

/**
 * Whether an element lays its content out as its own block.
 *
 * This is what separates a message from a chip. A message's prose lives inside a
 * paragraph, a list item or a container; an avatar label, a timestamp and the Copy
 * and Retry buttons are inline, so they are chrome rather than blocks.
 *
 * @param element - the element to test.
 * @returns true when the element establishes its own block.
 */
function isBlockLevel(element) {
	return element?.nodeType === 1 && BLOCK_TAGS.has(element.tagName);
}

/** How long the transcript must be quiet before a message is treated as settled. */
const SETTLE_MS = 700;

/** How long a selection must be stable before the affordance appears. */
const SELECTION_DEBOUNCE_MS = 140;

// The hover rest-delay used to live here as `HOVER_DELAY_MS = 130`. It is gone, and so is the
// behaviour it timed: after the two plugins were merged, waiting for the pointer to come to rest is
// `hover.js`'s job (`HOVER_DELAY_MS`, now the configurable `hoverInMs` preference, default 110). Both
// constants were named the same and disagreed, so the dead one read as the live one — which is how the
// README spent a while advertising a 130 ms rest delay that no code had used since the merge.

/** Most entries one message may add, so a wall of jargon cannot flood the panel. */
const MAX_AUTO_PER_MESSAGE = 3;

/**
 * Most entries automatic collection may add per minute, across all messages.
 *
 * The per-message cap alone bounds a burst but not a session: a long conversation where
 * every reply carries one new identifier still adds one entry per reply, forever, which
 * is what "收录过程太频繁" describes. This is the session-level budget.
 */
const MAX_AUTO_PER_MINUTE = 8;

/** The window the per-minute budget is measured over. */
const AUTO_BUDGET_WINDOW_MS = 60_000;

/** Remembered message fingerprints, so a re-render does not re-collect. */
const MAX_SEEN_FINGERPRINTS = 400;

/** Longest selection the plugin will offer to add. */
const MAX_SELECTION_CHARS = 80;

/**
 * Hard ceiling on a stored context window.
 *
 * The panel renders a context under the editor's title, so an unbounded context is not
 * a cosmetic problem: it is what made the editor unusable.
 */
const MAX_CONTEXT_CHARS = 240;

/** FNV-1a over a string, used only to recognize a message the plugin already read. */
function hashText(text) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/** Collapse every run of whitespace to one space, the same way the detector sees text. */
function collapse(text) {
	return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/**
 * The blocks of a container, in document order, each with its own text.
 *
 * The boundary list is the render tree's own granularity: the children of the
 * scrolling region are messages, so every block in the returned list is one
 * message. Within a block, offset 0 of the text is the block's first character.
 *
 * @param root - the region element.
 * @returns `{ blocks: Array<{ element, text }>, text, offsets }`, where `offsets`
 *   maps every block back to its start in the joined `text`.
 */
function readRegion(root) {
	if (root === null || root === undefined) return { blocks: [], text: "", offsets: [] };
	const blocks = [];
	const offsets = [];
	let text = "";
	for (const element of findMessageElements(root)) {
		const blockText = collapse(readBlock(element));
		if (blockText === "") continue;
		const separator = text === "" ? "" : " ";
		const start = text.length + separator.length;
		text += separator + blockText;
		offsets.push(start);
		blocks.push({ element, text: blockText, start });
	}
	return { blocks, text, offsets };
}

/** Longest text a single message block may hold before it stops being one block. */
const MAX_BLOCK_CHARS = 20000;

/**
 * Whether an element holds its text directly rather than in child elements.
 *
 * A paragraph of prose is a run of text nodes and inline elements; a message
 * container has element children that are themselves blocks. `childNodes` is what
 * separates them, because `children` only counts elements.
 *
 * @param element - the element to test.
 * @returns true when the element carries no element children.
 */
function isTextOnly(element) {
	const nodes = Array.from(element.childNodes ?? []);
	if (nodes.length === 0) return true;
	return nodes.every((node) => node.nodeType !== 1);
}

/**
 * The attribute every conversation row carries, whatever it renders.
 *
 * Found in the shipped chat bundle (`ChatView_module_css_default.flowItem`): each row
 * is a `div` with `data-chat-flow-key`, `data-chat-node-key` and
 * `data-chat-flow-kind`, and the row's own message content lives in a child marked
 * `data-slot="conversation.chat.node"`.
 */
const FLOW_ROW_SELECTOR = "[data-chat-flow-key]";

/** The child of a flow row that holds that row's rendered message. */
const FLOW_NODE_SELECTOR = '[data-slot="conversation.chat.node"]';

/**
 * Row kinds that are grouping furniture rather than message text.
 *
 * A turn or a step is a container: its row carries `data-step-process` or
 * `data-turn-process-member`, and its text is the sum of the rows nested inside it.
 * Reading it as a message would duplicate every word it contains, so those rows are
 * skipped and the leaves underneath are read instead.
 *
 * The leave-one-out filter below then drops any row that merely encloses another row,
 * which covers grouping the kinds do not name.
 */
const FLOW_GROUP_MARKER = "[data-step-process], [data-turn-process-member]";

/**
 * Classes that mark UI chrome rather than message text.
 *
 * This exists because of a real defect: the "加载更早" control sits inside the
 * scrolling column next to the messages, and a structural walk with no notion of the
 * host's markup read it as a message and created a dictionary entry from a button.
 * `data-slot` is the general answer, but a control that is not wrapped in one still
 * has to be excluded, and the host names its controls in these classes.
 */
const CHROME_CLASS_PATTERN = /(?:^|_)(?:older|hint|openError|actions|endInfo|timeStart|timeEnd|toolbar|footer|triggerMenu|queueDock)(?:_|$)/;

/**
 * Whether an element is a UI control rather than part of a message.
 * @param element - the element to test.
 * @returns true when the element carries a chrome class.
 */
function isChrome(element) {
	const className = typeof element?.getAttribute === "function" ? element.getAttribute("class") ?? "" : element?.className ?? "";
	if (typeof className !== "string" || className === "") return false;
	return className.split(/\s+/).some((token) => CHROME_CLASS_PATTERN.test(token));
}

/**
 * Child elements of one parent, or an empty list when the host offers no `children`.
 *
 * Everything here goes through this rather than touching `.children` directly, so a
 * stand-in without it degrades to "no children" instead of throwing.
 *
 * @param element - the parent.
 * @returns the element children.
 */
function childElements(element) {
	return element === null || element === undefined ? [] : Array.from(element.children ?? []);
}

/**
 * The elements that each hold one message's rendered text.
 *
 * The row contract is the host's own (`{@link FLOW_ROW_SELECTOR}`), and it is used in
 * preference to any structural guess: the shipped column also contains controls and
 * grouping rows, and inferring "this is a message" from text shape read a button as a
 * message. When the contract is unavailable — a stripped build, or a stand-in used by
 * a test — the structural walk below is the fallback.
 *
 * @param root - the region element.
 * @returns message elements in document order.
 */
function findMessageElements(root) {
	if (root === null || root === undefined) return [];
	if (typeof root.querySelectorAll === "function") {
		const rows = flowRows(root);
		// No rows means the contract is not present in this subtree — a stripped build, a
		// stand-in without the attributes, or a transcript with no messages yet. The
		// structural walk is then the only way to find text, and it cannot run on a real
		// page whose rows were found.
		if (rows.length > 0) return rows;
	}
	return structuralBlocks(root);
}

/**
 * The message text containers, taken from the host's flow-row contract.
 * @param root - the region element.
 * @returns message elements in document order.
 */
function flowRows(root) {
	const rows = Array.from(root.querySelectorAll(FLOW_ROW_SELECTOR));
	const claimed = new Set();
	const textOf = (element) => collapse(element?.innerText ?? element?.textContent ?? "");
	const included = [];
	for (const row of rows) {
		// A grouped row's text is its descendants' text; reading both duplicates it.
		if (typeof row.matches === "function" && row.matches(FLOW_GROUP_MARKER)) continue;
		// Leave-one-out: a row that encloses another row is a container, not a message.
		if (rows.some((other) => other !== row && typeof row.contains === "function" && row.contains(other))) continue;
		const content = typeof row.querySelector === "function" ? row.querySelector(FLOW_NODE_SELECTOR) ?? row : row;
		if (isChrome(content) || isChrome(row)) continue;
		const text = textOf(content);
		if (text === "" || text.length > MAX_BLOCK_CHARS) continue;
		included.push(content);
		claimed.add(content);
	}
	// A message must not be read twice: the content container and the row can both be
	// candidates when the host changes shape.
	return included.filter((element) => !included.some((other) => other !== element && typeof other.contains === "function" && other.contains(element)));
	void claimed;
}

/**
 * The fallback split, used only when the host's row contract is unavailable.
 *
 *  - an element whose text sits in its own text nodes is a block;
 *  - a container with several prose children is descended into;
 *  - a single-wrapper chain is followed through;
 *  - the composer and anything at or beyond it is never entered, so the user's
 *    unsent draft is not read as a message.
 *
 * @param root - the region element.
 * @returns message elements in document order.
 */
function structuralBlocks(root) {
	const found = [];
	/**
	 * Walk one element, collecting messages.
	 * @param element - the element to inspect.
	 * @param depth - current recursion depth.
	 */
	const walk = (element, depth) => {
		if (element === null || element === undefined) return;
		// Only elements can be message blocks: a text node has no box and no
		// `getBoundingClientRect`, so the pointer path could not use it.
		if (element.nodeType !== 1) return;
		if (isComposer(element) || isChrome(element)) return;
		const children = childElements(element);
		const text = collapse(element.innerText ?? element.textContent ?? "");
		if (text === "") return;
		if (children.length === 0 || isTextOnly(element)) {
			// Text in the element's own text nodes: this is one block.
			if (text.length <= MAX_BLOCK_CHARS) found.push(element);
			return;
		}
		// A child counts as meaningful only when it holds something the reader could
		// see. `textContent` is the structural test: `innerText` is already collapsed
		// by the host and reports an empty string for an element that still holds
		// whitespace and markup.
		const meaningful = children.filter((child) => collapse(child.textContent ?? "") !== "" && !isComposer(child) && !isChrome(child));
		if (meaningful.length === 0) return;

		const containers = meaningful.filter((child) => isBlockLevel(child) || childElements(child).some((grandchild) => isBlockLevel(grandchild)));

		if (depth >= 8) {
			if (text.length <= MAX_BLOCK_CHARS) found.push(element);
			return;
		}
		if (containers.length > 1) {
			// Several prose children and nothing of its own: this is the list.
			for (const child of containers) walk(child, depth + 1);
			return;
		}
		if (containers.length === 1 && meaningful.length === 1) {
			// A single-wrapper chain: the block boundary is inside it.
			walk(containers[0], depth + 1);
			return;
		}
		// No prose child at all, or prose beside chrome with nothing of its own: read
		// this subtree as one block rather than descending forever.
		const blockText = children.some((child) => isComposer(child))
			? collapse(meaningful.map((child) => child.innerText ?? child.textContent ?? "").join(" "))
			: text;
		if (blockText !== "" && blockText.length <= MAX_BLOCK_CHARS) found.push(element);
	};
	walk(root, 0);
	return found;
}

/**
 * Whether an element holds text of its own, beside its child elements.
 *
 * A list container has only element children. A message row has text nodes next to
 * its children — a preamble, or the whitespace the layout leaves between them — and
 * that is the difference between "descend into the messages" and "this row is one
 * message".
 *
 * @param element - the element to test.
 * @returns true when the element has a non-blank text node child.
 */
function hasOwnTextNodes(element) {
	for (const node of Array.from(element.childNodes ?? [])) {
		if (node.nodeType === 3 && collapse(node.nodeValue ?? "") !== "") return true;
	}
	return false;
}

/**
 * Whether one node is the other or lives inside it.
 *
 * Written as a parent walk rather than `contains`, because a caller may hold a
 * detached stand-in where `contains` is absent, and an element does not contain a
 * text node through `contains` on every implementation.
 *
 * @param ancestor - the element to test against.
 * @param node - the candidate descendant.
 * @returns true when `node` is inside `ancestor`.
 */
function containsNode(ancestor, node) {
	let at = node;
	while (at !== null && at !== undefined) {
		if (at === ancestor) return true;
		at = at.parentElement ?? at.parentNode;
	}
	return false;
}

/**
 * The plugin-owned marker on a node or its ancestors, if any.
 *
 * The marker is an attribute rather than a class name because the host is free to
 * restyle the plugin's own surfaces while the marker is what the pointer logic needs.
 *
 * @param node - the event target.
 * @returns the marker value (`affordance`, `popup`, `panel`, …) or null.
 */
function ownMarker(node) {
	let at = node;
	while (at !== null && at !== undefined) {
		if (at.nodeType === 1 && typeof at.getAttribute === "function") {
			const marker = at.getAttribute("data-term-dictionary");
			if (typeof marker === "string" && marker !== "") return marker;
		}
		at = at.parentElement ?? at.parentNode;
	}
	return null;
}

/**
 * Whether a node is (or is inside) the plugin's own selection affordance.
 *
 * The affordance lives in the overlay layer rather than in the transcript, so it is
 * outside the region; and a press on it must be distinguished from a press anywhere
 * else on the page, because only the latter means "the selection is being abandoned".
 *
 * @param node - the event target.
 * @returns true when the node belongs to the affordance.
 */
function isOwnAffordance(node) {
	return ownMarker(node) === "affordance";
}

/**
 * Whether a node belongs to any surface the plugin owns and paints.
 *
 * This is what a press outside the plugin's own UI is measured against. The explanation
 * popup is one of these surfaces, and it has no path that closes when the user presses
 * anywhere else — so it stayed open over the transcript, and every pointer that landed
 * on it was then blocked by {@link BLOCKED_SELECTOR}, which lists the same marker.
 *
 * @param node - the event target.
 * @returns true when the node is the plugin's own.
 */
function isOwnSurface(node) {
	return ownMarker(node) !== null;
}

/**
 * Whether an element is the composer seat or lives inside it.
 *
 * A structural walk rather than `closest`, because the seat is identified by an
 * attribute and a caller may hold a detached stand-in (a test fixture) where
 * `closest` does not exist.
 *
 * @param element - a node.
 * @returns true when the node belongs to the input area.
 */
function isComposer(element) {
	let at = element;
	while (at !== null && at !== undefined) {
		if (at.nodeType === 1) {
			if (typeof at.hasAttribute === "function" && at.hasAttribute("data-composer-seat")) return true;
			if (typeof at.getAttribute === "function" && at.getAttribute("data-conversation-region") === "composer") return true;
		}
		at = at.parentElement ?? at.parentNode;
	}
	return false;
}

/**
 * The text of one block, whitespace-collapsed exactly like {@link readRegion}.
 * @param element - a block element.
 * @returns its collapsed text.
 */
function readBlock(element) {
	return collapse(element?.innerText ?? element?.textContent ?? "");
}

/**
 * Which block a viewport point falls in, by hit-testing each block's box.
 *
 * Text offsets are deliberately not derived from `Range` lengths: collapsing
 * whitespace makes a range length disagree with the text the detector scans, and
 * a geometry test cannot drift. The offset is then the clamped difference between
 * the pointer and the block's left edge, which only has to be good enough to pick
 * the word under the pointer.
 *
 * @param blocks - blocks from {@link readRegion}.
 * @param x - viewport x.
 * @param y - viewport y.
 * @returns `{ block, offset }`, or null when the point is outside every block.
 */
function blockAtPoint(blocks, x, y) {
	let nearest = null;
	for (const block of blocks) {
		const rect = block.element.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		if (y >= rect.top && y <= rect.bottom) {
			const offset = clampOffset(block.text, x - rect.left, rect);
			return { block, offset };
		}
		const distance = y < rect.top ? rect.top - y : y - rect.bottom;
		if (nearest === null || distance < nearest.distance) nearest = { block, distance };
	}
	// A point that is not inside any block resolves to NOTHING.
	//
	// This used to return the nearest block at offset 0, and that is what made a click
	// on empty space below the transcript open an explanation for some unrelated term:
	// the gap between two messages, the padding around them, and the blank area under
	// the last one all resolved to "the closest message, first character". A click is
	// only about a term when it lands on one.
	void nearest;
	return null;
}

/**
 * Approximate a character offset from a horizontal distance into a block.
 * Only the fallback: a block laid out with a proportional font does not map
 * distance to character count linearly, so the caret-derived offset is preferred
 * whenever the browser offers one.
 * @param text - the block's collapsed text.
 * @param dx - distance from the block's left edge.
 * @param rect - the block's box.
 * @returns a clamped character offset.
 */
function clampOffset(text, dx, rect) {
	const width = rect.width <= 0 ? 1 : rect.width;
	const ratio = Math.max(0, Math.min(1, dx / width));
	return Math.max(0, Math.min(text.length, Math.round(ratio * text.length)));
}

/**
 * Whether a node must not be treated as transcript prose: a code block, a link, an
 * editor, or anything inside the composer.
 *
 * Module-level rather than closure-local so {@link isProseBlock} can share it, and so
 * the annotation layer asks the same question the collector does.
 *
 * @param node - a node.
 * @returns true when the node is off limits.
 */
function isSkippedNode(node) {
	const element = node?.nodeType === 1 ? node : node?.parentElement;
	if (element === null || element === undefined) return false;
	if (isComposer(element)) return true;
	return typeof element.closest === "function" && element.closest(SKIP_SELECTOR) !== null;
}

/**
 * Whether a node must not resolve a term at all: the composer, a link, an editor, or the
 * plugin's own UI. Code is deliberately NOT here — see {@link BLOCKED_SELECTOR}.
 * @param node - a node.
 * @returns true when the node is off limits for the pointer gestures.
 */
function isBlockedNode(node) {
	const element = node?.nodeType === 1 ? node : node?.parentElement;
	if (element === null || element === undefined) return false;
	if (isComposer(element)) return true;
	return typeof element.closest === "function" && element.closest(BLOCKED_SELECTOR) !== null;
}

/**
 * Whether a node's text is code or tool output.
 * @param node - a node.
 * @returns true when the node sits inside `pre` or `code`.
 */
function isDataNode(node) {
	const element = node?.nodeType === 1 ? node : node?.parentElement;
	if (element === null || element === undefined) return false;
	return typeof element.closest === "function" && element.closest(DATA_SELECTOR) !== null;
}

/**
 * Whether a block is prose rather than code, a link or chrome.
 *
 * This is the gate the collector was missing, and the reason the dictionary filled up
 * with junk: `collect()` scanned EVERY block `readRegion` produced, and a transcript's
 * code blocks and tool output are blocks too. One session of shell commands therefore
 * collected `Invoke-WebRequest`, `StatusCode`, `StartTime` and fourteen more
 * identifiers, none of which anyone wanted a gloss for — exactly the "do not let the
 * dictionary get bulky" failure this plugin is supposed to avoid.
 *
 * A block is prose when at least one of its text runs sits outside a skipped
 * container. That keeps a paragraph that merely CONTAINS an inline code span (the
 * common case in a technical reply) while dropping a block that is entirely code.
 *
 * @param block - a block from {@link readRegion}, or any element.
 * @returns true when the block carries prose.
 */
function isProseBlock(block) {
	const element = block?.element ?? block;
	if (element === null || element === undefined || element.nodeType !== 1) return false;
	if (isSkippedNode(element)) return false;
	const runs = textRuns(element).runs;
	if (runs.length === 0) return false;
	return runs.some((run) => !isSkippedNode(run.node));
}

/**
 * Hard-clamp a context string, for the paths where no block could be located.
 * @param text - the raw text.
 * @returns one bounded, single-lined window.
 */
function clampContext(text) {
	if (typeof text !== "string") return "";
	const single = text.replace(/\s+/g, " ").trim();
	return single.length <= MAX_CONTEXT_CHARS ? single : `${single.slice(0, MAX_CONTEXT_CHARS)}…`;
}

/** Whether an element starts a new line of text. */
function isBlockElement(element) {
	return element !== null && element !== undefined && element.nodeType === 1 && BLOCK_TAGS.has(element.tagName);
}

/**
 * Split a block's rendered text into runs, joining them exactly the way
 * {@link readRegion} joins blocks: one space between lines and between inline
 * pieces whose source text contained whitespace, nothing between adjacent pieces.
 * Concatenating the runs reproduces the block's collapsed text, and each run
 * remembers which DOM text node it came from, so a caret can be mapped back to an
 * offset.
 *
 * @param block - the block element.
 * @returns `{ runs, text }` where each run is `{ node, start, end }`.
 */
function textRuns(block) {
	const runs = [];
	let text = "";
	let pendingSpace = false;

	/**
	 * Append one text node's contribution.
	 * @param node - a text node.
	 */
	const visit = (node) => {
		const raw = typeof node.nodeValue === "string" ? node.nodeValue : "";
		if (raw === "") return;
		if (raw.trim() === "") {
			pendingSpace = text !== "";
			return;
		}
		const leading = /^\s/.test(raw);
		const trailing = /\s$/.test(raw);
		const body = raw.replace(/\s+/g, " ").trim();
		if ((pendingSpace || leading) && text !== "" && !text.endsWith(" ")) text += " ";
		pendingSpace = false;
		const start = text.length;
		text += body;
		runs.push({ node, start, end: text.length, body, leading: leading ? 1 : 0 });
		if (trailing) pendingSpace = true;
	};

	/**
	 * Walk the block's descendants in document order.
	 * @param element - the element to walk.
	 */
	const walk = (element) => {
		for (const child of Array.from(element.childNodes ?? [])) {
			if (child.nodeType === 3) {
				visit(child);
				continue;
			}
			if (child.nodeType !== 1) continue;
			if (isBlockElement(child)) pendingSpace = text !== "";
			walk(child);
		}
	};
	walk(block);
	return { runs, text };
}

/**
 * Map a caret inside a block to an offset in the block's collapsed text.
 *
 * The walk mirrors {@link textRuns} exactly, so the offset is a real index into
 * the block's `text` rather than a guess. When the caret lands on an element
 * rather than a character, the offset is the start of the run that follows.
 *
 * @param block - the block element.
 * @param container - the caret's container node.
 * @param caret - the caret's offset inside that container.
 * @param runs - the runs from {@link textRuns}.
 * @returns the collapsed-text offset, or null when the caret is outside the block.
 */
function offsetFromCaret(block, container, caret, runs) {
	if (container === null || container === undefined) return null;
	/** The run produced by one node, if it produced one. */
	const runOf = (node) => runs.find((candidate) => candidate.node === node);
	/** The first run at or after one element in document order. */
	const firstRunIn = (node) => {
		if (node === null || node === undefined) return undefined;
		return runs.find((candidate) => node === candidate.node || (typeof node.contains === "function" && node.contains(candidate.node)));
	};
	if (container.nodeType === 3) {
		const run = runOf(container);
		if (run === undefined) return null;
		// Count this node's collapsed characters before the caret: the same
		// whitespace collapsing the run applied, so the count lands on a real index.
		const raw = container.nodeValue ?? "";
		const before = raw.slice(0, Math.max(0, Math.min(caret, raw.length)));
		let counted = 0;
		let inSpace = false;
		for (let at = 0; at < before.length; at++) {
			const character = before[at];
			if (/\s/.test(character)) {
				if (!inSpace) {
					inSpace = true;
					counted++;
				}
				continue;
			}
			inSpace = false;
			counted++;
		}
		return Math.max(run.start, Math.min(run.end, run.start + counted));
	}
	if (container.nodeType === 1) {
		const children = Array.from(container.childNodes ?? []);
		const following = children[caret];
		if (following === undefined) {
			// Past the last child: the previous run's end is the closest real offset.
			const containing = runs.filter((candidate) => typeof container.contains === "function" && container.contains(candidate.node));
			const last = containing[containing.length - 1];
			return last === undefined ? null : last.end;
		}
		const run = firstRunIn(following);
		return run === undefined ? null : run.start;
	}
	return null;
}

/**
 * The word around one offset, extended to the word runs the detector uses.
 * @param text - the containing text.
 * @param offset - a character offset.
 * @param isWordCharacter - character classifier from the core module.
 * @returns `{ start, end }` covering the word, or null when there is none.
 */
function wordAt(text, offset, isWordCharacter) {
	if (typeof text !== "string" || text.length === 0) return null;
	let at = Math.max(0, Math.min(offset, text.length - 1));
	if (!isWordCharacter(text[at]) && at > 0 && isWordCharacter(text[at - 1])) at -= 1;
	if (!isWordCharacter(text[at])) return null;
	let start = at;
	while (start > 0 && isWordCharacter(text[start - 1])) start--;
	let end = at + 1;
	while (end < text.length && isWordCharacter(text[end])) end++;
	return { start, end };
}

/**
 * Build the interaction layer for one page.
 *
 * @param options - `detector`, `store`, `onExplain`, `onActivate`,
 *   `onPressOutside`, `onToast`, `onSettled`, `now`, `logger`, `diagnose`.
 *   `onExplain(hit, point)` opens the popup for a term the dictionary has never
 *   collected; `onActivate(hit, point)` is the click on a term the detector already
 *   knows, which the shell turns into "open that entry";
 *   `onPressOutside()` reports a press on something that is neither
 *   the transcript nor one of the plugin's own surfaces; `onSettled(region)` fires after
 *   each settled-transcript pass so the annotation layer can refresh against the same DOM
 *   the layer just read; `diagnose(kind, record)` receives `click` and
 *   `rejected` records, each drawn from its own budget.
 * @returns the layer's lifecycle.
 */
function createInteractionLayer(options) {
	const detector = options.detector;
	const store = options.store;
	const onExplain = typeof options.onExplain === "function" ? options.onExplain : () => {};
	const onActivate = typeof options.onActivate === "function" ? options.onActivate : onExplain;
	const onPressOutside = typeof options.onPressOutside === "function" ? options.onPressOutside : null;
	const onSettled = typeof options.onSettled === "function" ? options.onSettled : () => {};
	const onToast = typeof options.onToast === "function" ? options.onToast : () => {};
	const logger = options.logger;
	const doc = options.document ?? globalThis.document;
	const win = options.window ?? globalThis.window;

	let region = null;
	let scrollRoot = null;
	let observer = null;
	let settleTimer = null;
	let selectionTimer = null;
	/**
	 * Whether automatic collection runs at all.
	 *
	 * A live flag rather than a construction option: the panel's switch flips while the
	 * layer is attached, and re-creating the layer to change a preference would drop the
	 * transcript fingerprints and re-collect the entire conversation.
	 */
	let autoCollectEnabled = true;
	/** Creation timestamps inside {@link AUTO_BUDGET_WINDOW_MS}, oldest first. */
	const recentCreations = [];
	/**
	 * How many diagnostic probes may still be reported, per gesture kind.
	 *
	 * Per-kind budgets rather than one shared counter: a single budget of 3 was spent by
	 * the first three clicks, so a page whose other gestures were already dead had also
	 * used up the only channel that could say so — and the rejection path printed nothing
	 * at all, because it returned before the report. Silence is the thing this layer has
	 * to make speakable.
	 */
	let clickBudget = 5;
	let rejectBudget = 3;
	/** How many times the layer adopted a conversation body from a gesture target. */
	let regionAdoptions = 0;
	/**
	 * Why each point-to-term resolution failed, by stage.
	 *
	 * Painting the marking uses the text runs and answers nothing about geometry, so `hl` can be
	 * healthy at the same moment every hit is refused. This is the one readout that names the
	 * refusing stage, and it costs a counter increment per refusal.
	 */
	const hitStages = {
		"no-caret": 0,
		"blocked-caret": 0,
		"no-block": 0,
		"no-over": 0,
		"over-outside": 0,
		"caret-outside": 0,
		"code-unknown": 0,
		"no-word": 0,
		"not-candidate": 0,
		ok: 0
	};

	/** Count a hit-test refusal by stage, and return null so the call site can `return` it. */
	function refuse(reason) {
		hitStages[reason] = (hitStages[reason] ?? 0) + 1;
		return null;
	}

	/** Count a resolved hit, so a stage tally is readable as a fraction rather than a list. */
	function accept(hit) {
		hitStages.ok++;
		return hit;
	}
	let clickSeen = 0;
	let attached = false;
	let pendingSelection = null;
	let snapshot = { blocks: [], text: "", offsets: [] };
	const seen = new Map();
	const disposers = [];

	/** The detector generation, replaced when the dictionary changes. */
	let activeDetector = detector;

	/** Test seam: when set, every sighting reports this answer instead of the store's. */
	let forcedSightingAnswer = null;

	/**
	 * Test seam: overrides the "is this word rare enough to record by itself?" decision.
	 * It narrows a policy that is otherwise fixed, and it cannot make the layer record a
	 * term the glossary already explains — the checks above still run first.
	 */
	let autoCreateFilter = null;

	/** Ask the store to record one sighting, honouring the test seam. */
	function noteSighting(sighting) {
		if (forcedSightingAnswer !== null) return Promise.resolve(forcedSightingAnswer);
		return Promise.resolve(store?.noteSighting?.(sighting) ?? null);
	}

	/**
	 * Swap in a detector built against the current dictionary. Called after every
	 * dictionary change, so highlighting picks up a newly created entry.
	 * @param next - the replacement detector.
	 */
	function setDetector(next) {
		activeDetector = next;
	}

	/** Report a caught failure without breaking the page. */
	function warn(message, error) {
		logger?.warn?.(`term-dictionary: ${message}: ${error instanceof Error ? error.message : String(error)}`);
	}

	/** Add a document listener and remember its removal. */
	function listen(target, type, handler, opts) {
		if (target === null || target === undefined) return;
		target.addEventListener(type, handler, opts);
		disposers.push(() => target.removeEventListener(type, handler, opts));
	}

	/**
	 * Whether a node must not be treated as transcript prose: a code block, a
	 * link, an editor, or anything inside the composer.
	 * @param node - a node.
	 * @returns true when the node is off limits.
	 */
	function isSkipped(node) {
		return isSkippedNode(node);
	}

	/** Resolve the caret under a point through either browser API. */
	function caretAtPoint(x, y) {
		if (typeof doc?.caretRangeFromPoint === "function") {
			const range = doc.caretRangeFromPoint(x, y);
			if (range !== null && range !== undefined) return range;
		}
		if (typeof doc?.caretPositionFromPoint === "function") {
			const position = doc.caretPositionFromPoint(x, y);
			if (position !== null && position !== undefined && position.offsetNode !== null) {
				const range = doc.createRange();
				range.setStart(position.offsetNode, position.offset);
				range.collapse(true);
				return range;
			}
		}
		return null;
	}

	/**
	 * Resolve a pointer position to a term occurrence in the transcript.
	 * @param x - viewport x.
	 * @param y - viewport y.
	 * @returns `{ term, key, context, known }`, or null.
	 */
	function termAtPoint(x, y) {
		const caret = caretAtPoint(x, y);
		if (caret === null) return refuse("no-caret");
		if (isBlockedNode(caret.startContainer)) return refuse("blocked-caret");
		// A hit inside code may be explained, never created. See BLOCKED_SELECTOR.
		const inData = isDataNode(caret.startContainer);
		// The snapshot is refreshed on demand so the very first click works: `attach`
		// binds the region but the settle pass that fills the snapshot runs on a timer.
		if (snapshot.blocks.length === 0) refreshSnapshot();
		const hit = blockAtPoint(snapshot.blocks, x, y);
		if (hit === null) return refuse("no-block");
		// The point must be over the transcript — not over something floating above it, such
		// as the plugin's own popup or another panel.
		//
		// This used to demand that the element under the pointer be a DESCENDANT of the
		// block, which is a different and far stricter question. Any sibling element the
		// host draws over a message — a hover toolbar, a selection layer, a sticky row —
		// made the element under the pointer a non-descendant, and this returned null for
		// every hover and every click in that message. The check below is the one that
		// answers the real question precisely, because it asks about the CARET's node.
		if (typeof doc?.elementFromPoint === "function") {
			const over = doc.elementFromPoint(x, y);
			if (over === null || over === undefined) return refuse("no-over");
			if (region !== null && !containsNode(region, over) && !containsNode(hit.block.element, over)) return refuse("over-outside");
		}
		// And the caret's own node must be inside that block, which catches a hit whose
		// box overlaps a neighbouring message's text — and a point in the padding beside a
		// message, where the caret API reports the nearest text position instead.
		if (!containsNode(hit.block.element, caret.startContainer)) return refuse("caret-outside");
		// The caret gives the exact character the pointer is over; the block's box cannot,
		// because a proportional font does not map distance to character count.
		//
		// The caret offset and the scanned text must come from the SAME walk. This used to
		// scan `hit.block.text` (the block's `innerText`, whitespace-collapsed) while the
		// offset came from `textRuns`, and it kept the exact offset only when the two
		// strings happened to be equal. They are always equal for a single text node — and
		// therefore always equal in the tests — but a real reply has nested elements and
		// hidden children, where `innerText` and the run walk legitimately differ. In that
		// case the code threw the caret offset away and used `hit.offset`, a GEOMETRIC
		// estimate from the pointer's distance to the block's left edge. On a paragraph of
		// more than one line that estimate is not approximate but systematically wrong: a
		// point at 20% of the width on the fifth line of twelve is about 40% of the way
		// through the text, not 20%. The resolved offset landed on unrelated words, so over
		// a real multi-line reply hovering found no term and clicking either did nothing or
		// offered to create a word that was already in the dictionary.
		//
		// Scanning the run text and using the run offset removes the disagreement rather
		// than papering over it. `block.text` stays as the fallback for the one case the
		// caret API genuinely cannot help with: no run for the caret's node.
		const runs = textRuns(hit.block.element);
		const exact = offsetFromCaret(hit.block.element, caret.startContainer, caret.startOffset, runs.runs);
		const scanText = exact === null ? hit.block.text : runs.text;
		const offset = exact === null ? hit.offset : Math.max(0, Math.min(scanText.length, exact));
		const found = activeDetector.scan(scanText, { includeCandidates: true });
		// Prefer the occurrence containing the caret's offset; among overlapping
		// candidates the longest match wins, which is the phrase rather than a word
		// inside it.
		let best = null;
		for (const occurrence of found) {
			if (offset < occurrence.start || offset > occurrence.end) continue;
			if (best === null || occurrence.end - occurrence.start > best.end - best.start) best = occurrence;
		}
		// Inside code, only a term the dictionary already holds resolves. An unknown one is
		// never offered there: an identifier in a code span is data, and offering to define it
		// is the bulk-import behaviour to avoid.
		if (inData && (best === null || best.known !== true)) return refuse("code-unknown");
		if (best === null) {
			// Only a word that could plausibly be terminology gets the create-entry
			// affordance; otherwise a click on ordinary prose would offer to define it.
			const word = wordAt(scanText, offset, options.isWordCharacter);
			if (word === null) return refuse("no-word");
			const term = scanText.slice(word.start, word.end);
			if (term.trim() === "" || term.length > MAX_SELECTION_CHARS) return refuse("no-word");
			if (typeof activeDetector.isCandidateWord === "function" && !activeDetector.isCandidateWord(term)) return refuse("not-candidate");
			return accept({ term, key: normalizeTerm(term), context: contextAround(scanText, word.start, word.end), known: false });
		}
		return accept({ term: best.term, key: best.key, context: contextAround(scanText, best.start, best.end), known: best.known });
	}

	/**
	 * Explain what the pointer pipeline sees at one point.
	 *
	 * A DIAGNOSTIC, not part of the feature. It reports every stage `termAtPoint` decides
	 * on, so a page that resolves nothing can say why — which is the one thing the test
	 * fixtures cannot tell us, because they have no real layout, no `elementFromPoint`, and
	 * single-text-node blocks.
	 *
	 * @param x - viewport x.
	 * @param y - viewport y.
	 * @returns a compact record of each stage.
	 */
	function probe(x, y) {
		const record = { at: [Math.round(x), Math.round(y)] };
		try {
			record.region = region === null ? "null" : `${region.nodeName}[${(typeof region.getAttribute === "function" ? region.getAttribute("data-conversation-region") : "") ?? "?"}]`;
			record.scroll = scrollRoot === null ? "null" : scrollRoot.nodeName;
			record.caretApi =
				typeof doc?.caretRangeFromPoint === "function" ? "caretRangeFromPoint" : typeof doc?.caretPositionFromPoint === "function" ? "caretPositionFromPoint" : "none";
			const caret = caretAtPoint(x, y);
			if (caret === null) {
				record.caret = "null";
			} else {
				const container = caret.startContainer;
				record.caret = container?.nodeType === 3 ? `text@${caret.startOffset}/${container.nodeValue?.length ?? -1}` : `el:${container?.nodeName}`;
				record.caretSkipped = isSkipped(container);
			}
			record.blocks = snapshot.blocks.length;
			const hit = blockAtPoint(snapshot.blocks, x, y);
			if (hit === null) {
				record.block = "null";
			} else {
				const rect = hit.block.element.getBoundingClientRect();
				record.block = `${snapshot.blocks.indexOf(hit.block)}:${hit.block.element.nodeName}:top=${Math.round(rect.top)}:h=${Math.round(rect.height)}:w=${Math.round(rect.width)}:chars=${hit.block.text.length}`;
				const runs = textRuns(hit.block.element);
				record.runs = `${runs.runs.length} runs/${runs.text.length} chars`;
			}
			const over = typeof doc?.elementFromPoint === "function" ? doc.elementFromPoint(x, y) : null;
			record.over = over === null || over === undefined ? "none" : `${over.nodeName}.${String(over.className ?? "").slice(0, 20)}`;
			if (over !== null && over !== undefined) {
				record.overInRegion = containsNode(region, over);
				record.overInBlock = hit !== null && containsNode(hit.block.element, over);
			}
			if (hit !== null && caret !== null) record.caretInBlock = containsNode(hit.block.element, caret.startContainer);
			const resolved = termAtPoint(x, y);
			record.hit = resolved === null ? "null" : `${resolved.term}|${resolved.key}|${resolved.known === true ? "known" : "unknown"}`;
		} catch (error) {
			record.error = `${error instanceof Error ? error.message : String(error)}`.slice(0, 160);
		}
		return record;
	}

	/**
	 * How many conversation bodies the document mounts right now.
	 *
	 * One copy of this count, because the rejection record and the heartbeat report have to
	 * be comparable — two readings of two selectors would be two different facts about the
	 * same page. Returns `null` rather than a guess when there is no document to ask.
	 *
	 * @returns the number of chat bodies, or null.
	 */
	function chatCount() {
		if (typeof doc?.querySelectorAll !== "function") return null;
		try {
			return doc.querySelectorAll(REGION_SELECTOR).length;
		} catch (error) {
			void error;
			return null;
		}
	}

	/**
	 * Report one diagnostic record, bounded per gesture.
	 *
	 * The record is built by a factory so a spent budget costs nothing.
	 *
	 * @param kind - `click` or `rejected`, which selects the budget.
	 * @param makeRecord - builds the record only if there is budget left.
	 */
	function report(kind, makeRecord) {
		if (typeof options.diagnose !== "function") return;
		if (kind === "click") {
			if (clickBudget <= 0) return;
			clickBudget--;
		} else {
			if (rejectBudget <= 0) return;
			rejectBudget--;
		}
		try {
			options.diagnose(kind, makeRecord());
		} catch (error) {
			warn("the diagnostic failed", error);
		}
	}

	/**
	 * The conversation body a pointer target belongs to, adopting it if that is a change.
	 *
	 * `locate()` asks the document, and the document answers in document order. That is
	 * not the same question as "the body the user is pointing at" once more than one is
	 * mounted — the host tags an embedded conversation body with the same attribute — and
	 * a pointer resting in a body the layer never adopted was indistinguishable from a
	 * pointer that receives no events: hundreds of moves counted, none of them in region.
	 *
	 * @param target - the event target.
	 * @returns the region the target lives in, or null when it lives in none.
	 */
	function regionForPointer(target) {
		if (region !== null && containsNode(region, target)) return region;
		const element = target?.nodeType === 1 ? target : target?.parentElement;
		const chat = typeof element?.closest === "function" ? element.closest(REGION_SELECTOR) : null;
		if (chat === null || chat === undefined) return null;
		if (bind(chat, doc?.querySelector?.(SCROLL_SELECTOR) ?? null)) regionAdoptions++;
		return region;
	}

	/** Recompute the cached transcript snapshot, tolerating an unmounted region. */
	function refreshSnapshot() {
		snapshot = region === null || region === undefined ? { blocks: [], text: "", offsets: [] } : readRegion(region);
		return snapshot;
	}

	/** Hide the selection affordance. */
	function clearSelectionAffordance() {
		pendingSelection = null;
		if (typeof options.onSelection === "function") options.onSelection(null);
	}

	/** React to a settled text selection inside a reply. */
	function onSelectionChange() {
		if (selectionTimer !== null) clearTimeout(selectionTimer);
		selectionTimer = setTimeout(() => {
			selectionTimer = null;
			try {
				const selection = win?.getSelection?.();
				if (selection === null || selection === undefined || selection.isCollapsed === true || selection.rangeCount === 0) {
					clearSelectionAffordance();
					return;
				}
				const text = collapse(selection.toString());
				if (text === "" || text.length > MAX_SELECTION_CHARS) {
					clearSelectionAffordance();
					return;
				}
				const range = selection.getRangeAt(0);
				if (!isInsideRegion(range.commonAncestorContainer)) {
					clearSelectionAffordance();
					return;
				}
				if (isSkipped(range.startContainer) || isSkipped(range.endContainer)) {
					clearSelectionAffordance();
					return;
				}
				const rect = range.getBoundingClientRect();
				const context = contextForSelection(range, rect);
				pendingSelection = {
					text,
					context,
					rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
				};
				if (typeof options.onSelection === "function") options.onSelection(pendingSelection);
			} catch (error) {
				warn("reading the selection failed", error);
			}
		}, SELECTION_DEBOUNCE_MS);
	}

	/** Whether a node belongs to the conversation region. */
	function isInsideRegion(node) {
		if (region === null || node === null || node === undefined) return false;
		const element = node.nodeType === 1 ? node : node.parentElement;
		return element !== null && element !== undefined && (element === region || region.contains(element));
	}

	/**
	 * The sentence around a selection, never the whole transcript.
	 *
	 * This used to be `readBlock(regionFor(node))`, and that is what flooded the editor:
	 * {@link regionFor} returns the region's DIRECT CHILD, which in the real layout is
	 * the scroll container holding every message. So `context` was the entire
	 * conversation — every turn, every tool-chip label, because `innerText` of that
	 * container includes them. The panel renders the context directly under the editor's
	 * title, so adding one term filled the panel with the whole session and pushed the
	 * fields and the Save button off-screen: the editor became unusable.
	 *
	 * The selection's own centre point identifies the block the user actually selected
	 * in (the same tested lookup a click uses), and {@link contextAround} then clamps the
	 * result to one bounded window around the selection.
	 *
	 * @param range - the selection's range.
	 * @param rect - the range's viewport box.
	 * @returns the context sentence, bounded.
	 */
	function contextForSelection(range, rect) {
		const selected = collapse(range.toString());
		if (snapshot.blocks.length === 0) refreshSnapshot();
		const centreX = (rect.left + rect.right) / 2;
		const centreY = (rect.top + rect.bottom) / 2;
		const hit = blockAtPoint(snapshot.blocks, centreX, centreY);
		if (hit === null) return clampContext(selected);
		let offset = hit.offset;
		try {
			const runs = textRuns(hit.block.element);
			const exact = offsetFromCaret(hit.block.element, range.startContainer, range.startOffset, runs.runs);
			if (exact !== null) offset = exact;
		} catch (error) {
			// The geometric offset stays: it only has to be close enough for the window.
			void error;
		}
		return contextAround(hit.block.text, offset, offset + selected.length);
	}

	/** Handle a click on the transcript. */
	function onClick(event) {
		clickSeen++;
		if (event.defaultPrevented === true || event.button !== 0) return;
		if (event.altKey === true || event.metaKey === true) return;
		// A click that ends a drag-select must not also open the popup.
		const selection = win?.getSelection?.();
		if (selection !== null && selection !== undefined && selection.isCollapsed !== true && selection.toString().trim() !== "") return;
		const target = event.target;
		if (isBlockedNode(target)) return;
		// The same adoption the hover path gets: a click has to resolve against the body it
		// happened in, not against whichever body `querySelector` reached first.
		regionForPointer(target);
		// Diagnostic: the same report for a click, which is the gesture that "does nothing".
		report("click", () => probe(event.clientX, event.clientY));
		let hit = null;
		try {
			hit = termAtPoint(event.clientX, event.clientY);
		} catch (error) {
			warn("resolving the clicked term failed", error);
			return;
		}
		if (hit === null) return;
		// A click on a term the detector knows is a navigation, not an explanation:
		// the explanation was already offered as the hint the pointer was resting on.
		// The hint is dropped first, because selecting a panel unmounts the transcript
		// and an overlay left behind would outlive the term it describes.
		try {
			if (hit.known === true) {
				onActivate(hit, { x: event.clientX, y: event.clientY });
			} else {
				onExplain(hit, { x: event.clientX, y: event.clientY });
			}
		} catch (error) {
			warn("opening the explanation failed", error);
		}
	}

	/** Run one settled-transcript pass: snapshot, then collect new terminology. */
	function settle() {
		settleTimer = null;
		try {
			const current = refreshSnapshot();
			if (region !== null) onSettled(region);
			if (current.text === "") return;
			collect(current);
		} catch (error) {
			warn("scanning the transcript failed", error);
		}
	}

	/**
	 * Whether the plugin should create an entry for this occurrence on its own.
	 *
	 * The point of the feature is the RARE word in the conversation, not a dictionary
	 * of everything the agent says. Three things are therefore required:
	 *
	 *  - The term must be genuinely term-like: an acronym or an identifier. The detector
	 *    already refuses ordinary prose, so this keeps the bar where it was rather than
	 *    lowering it.
	 *  - The built-in glossary must NOT already explain it. Hauling a term the plugin can
	 *    already define into the user's personal dictionary is the bulk-import behaviour
	 *    to avoid: it fills the panel with words the user never asked about and buries the
	 *    ones they did. A glossary term is still clickable and still explainable — it is
	 *    read from the built-in lexicon — and the user can add it deliberately by
	 *    selecting it.
	 *  - The user must not have DELETED it. Deletion is a deliberate act, and a deleted
	 *    term is not an unknown one: reviving it belongs to the manual path (selecting
	 *    the word, or typing in the editor), never to the collector noticing it again.
	 *    Without this, a later agent reply that happens to carry a definition for the term
	 *    would revive it on its own, and the user's deletion would quietly undo itself.
	 *
	 * @param occurrence - one detected occurrence.
	 * @param detector - the detector that produced it.
	 * @param deletedKeys - the terms the user has deleted.
	 * @returns true when the entry should be created automatically.
	 */
	function shouldAutoCreate(occurrence, detector, deletedKeys) {
		if (occurrence.known) return false;
		if (deletedKeys !== undefined && deletedKeys.has(occurrence.key)) return false;
		if (typeof detector?.glossaryOf === "function" && detector.glossaryOf(occurrence.key) !== undefined) return false;
		if (autoCreateFilter !== null) return autoCreateFilter(occurrence, detector) === true;
		return isAcronym(occurrence.term) || looksLikeIdentifier(occurrence.term);
	}

	/**
	 * The terms the user has deleted, as a lookup set.
	 *
	 * Read from the store rather than tracked here, because deletion can happen in another
	 * window and arrive through a merge.
	 *
	 * @returns the deleted term keys.
	 */
	function deletedTermKeys() {
		const raw = typeof store?.getState === "function" ? store.getState() : undefined;
		// `getState()` is the document; `getSnapshot()` is the render projection, which
		// carries the same document under `state`. Both are accepted so the collector does
		// not silently lose the tombstones when it is handed one rather than the other.
		const state = raw?.state ?? raw;
		const keys = new Set();
		for (const key of state?.deletedKeys ?? []) {
			if (typeof key === "string") keys.add(normalizeTerm(key));
		}
		for (const record of state?.backing ?? []) {
			if (record === null || record === undefined || (record.deletedAt ?? 0) <= 0) continue;
			keys.add(record.key ?? normalizeTerm(record.term ?? ""));
		}
		return keys;
	}

	/**
	 * Collect the terminology of the messages the plugin has not read yet.
	 *
	 * The store is the authority on what happened: a sighting of a term the user
	 * deleted is refused, so the count of new entries comes from the store's answers
	 * rather than from this loop's own guesses. Guessing is what produced a
	 * "collected N terms" notice for terms that were not collected at all.
	 *
	 * @param current - the transcript snapshot.
	 * @returns a promise resolving to the number of entries actually created.
	 */
	/**
	 * The user's automatic-collection preferences, read fresh per pass.
	 *
	 * The layer owns collection, the shell owns the settings store, so they are handed over
	 * as a thunk rather than copied at attach time: flipping a switch must take effect on the
	 * next settled message, not on the next page load.
	 *
	 * @returns `{ minLength, identifiers, cjk }`.
	 */
	function collectPreferences() {
		const raw = typeof options.collectSettings === "function" ? options.collectSettings() : null;
		return {
			minLength: typeof raw?.collectMinLength === "number" && raw.collectMinLength > 0 ? raw.collectMinLength : 4,
			identifiers: raw?.collectIdentifiers === true,
			cjk: raw?.collectCjk !== false
		};
	}

	/**
	 * Whether a term is shaped like code rather than like a word.
	 *
	 * The dictionary filled up with `data-conversation-region`, `getBoundingClientRect`,
	 * `term-wikilink-card`, `Set-Content` and `12-0D` — code, none of it terminology a reader
	 * wants explained. The test is deliberately blunt so it can be explained in one line: a
	 * hyphen or underscore, or a capital inside a word (camelCase / PascalCase). A single
	 * leading capital (`Quorum`) is ordinary prose and passes.
	 *
	 * @param term - the candidate.
	 * @returns true when the term looks like an identifier.
	 */
	function codeShaped(term) {
		return /[_-]/.test(term) || /[a-z][A-Z]/.test(term);
	}

	/**
	 * The names this plugin's own diagnostics use.
	 *
	 * Never terminology, and never subject to a user's preference: `zz-*` is what the
	 * heartbeat and the pointer probes are called, and one of them was collected from a
	 * message that merely MENTIONED it.
	 */
	const DIAGNOSTIC_NAME = /^zz-/i;

	/**
	 * Whether the collection preferences allow one candidate.
	 *
	 * @param term - the candidate term.
	 * @param preferences - from {@link collectPreferences}.
	 * @returns true when it may be collected.
	 */
	function allowedByPreferences(term, preferences) {
		const text = typeof term === "string" ? term.trim() : "";
		if (text === "") return false;
		if (DIAGNOSTIC_NAME.test(text)) return false;
		if (text.length < preferences.minLength) return false;
		if (!preferences.cjk && /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)) return false;
		if (!preferences.identifiers && codeShaped(text)) return false;
		return true;
	}

	function collect(current) {
		// The switch first: with auto-collection off, a settled message must cost nothing
		// and must not even mark itself as read, so that turning the switch back on still
		// sees the conversation.
		if (!autoCollectEnabled) return Promise.resolve(0);
		// Measure the budget from now: timestamps older than the window have expired, and
		// without this the list could only ever grow and collection would stop for good
		// once the budget was first reached.
		const startedAt = Date.now();
		const cutoff = startedAt - AUTO_BUDGET_WINDOW_MS;
		while (recentCreations.length > 0 && recentCreations[0] <= cutoff) recentCreations.shift();
		let created = 0;
		/** The sightings that stuck, so the shell can ask for their explanations. */
		const stuck = [];
		const pending = [];
		const knownEntries = () => (typeof store?.getState === "function" ? store.getState().entries : []);
		const deletedKeys = deletedTermKeys();
		// One snapshot per pass, so a switch flipped mid-conversation cannot make two blocks of
		// the same pass disagree about what is allowed.
		const preferences = collectPreferences();
		for (const block of current.blocks) {
			// Code blocks and tool output are blocks too. Collecting from them is how the
			// dictionary filled with shell-script identifiers nobody asked about.
			if (!isProseBlock(block)) continue;
			const fingerprint = hashText(block.text);
			if (seen.has(fingerprint)) continue;
			remember(fingerprint);
			const occurrences = activeDetector.scan(block.text, { includeCandidates: true });
			if (occurrences.length === 0) continue;
			// Counted per BLOCK. `created` used to be the guard here, but it is the total for
			// the whole pass — so the constant named "per message" really capped a settle
			// pass at three, and a five-message pass silently dropped two messages' worth of
			// terminology. The session bound is the per-minute budget below; this one is the
			// per-message bound its name promises.
			let createdInBlock = 0;
			for (const occurrence of occurrences) {
				if (createdInBlock >= MAX_AUTO_PER_MESSAGE) break;
				// A burst of jargon must not fill the panel in one message, and a long
				// session must not fill it one message at a time: the per-minute budget is
				// what makes "收录过程太频繁" stop being true even when every message
				// carries something new.
				if (recentCreations.length >= MAX_AUTO_PER_MINUTE) break;
				if (!shouldAutoCreate(occurrence, activeDetector, deletedKeys)) continue;
				if (!allowedByPreferences(occurrence.term, preferences)) continue;
				const isNew = knownEntries().every((entry) => entry.key !== occurrence.key);
				if (!isNew) continue;
				const context = blockText(block, occurrence);
				const glossary = activeDetector.glossaryOf(occurrence.key);
				const item = { term: occurrence.term, key: occurrence.key, context };
				const answer = noteSighting({
					term: occurrence.term,
					context,
					glossary,
					confidence: occurrence.confidence
				});
				created++;
				createdInBlock++;
				recentCreations.push(Date.now());
				pending.push({ item, answer });
			}
		}
		const announce = (actual, collected) => {
			if (actual > 0) onToast({ kind: "auto", count: actual });
			if (collected.length > 0 && typeof options.onCollected === "function") {
				try {
					options.onCollected(collected);
				} catch (error) {
					warn("reporting the collected terms failed", error);
				}
			}
			return actual;
		};
		if (pending.length === 0) return Promise.resolve(announce(created, []));
		return Promise.all(pending.map((entry) => entry.answer)).then((answers) => {
			const refused = answers.filter((answer) => answer !== null && answer !== undefined && answer.deleted === true).length;
			// The store is the authority: a refused sighting creates nothing, so it must not
			// be reported as collected to whoever asks for explanations.
			const accepted = pending.filter((entry, index) => answers[index]?.deleted !== true).map((entry) => entry.item);
			return announce(Math.max(0, created - refused), accepted);
		});
	}

	/**
	 * The sentence around one occurrence inside a block.
	 *
	 * Delegates to {@link contextAround} so there is one windowing rule in the plugin:
	 * it expands to sentence boundaries where it can and hard-clamps at
	 * {@link MAX_CONTEXT_CHARS}, which is what keeps a long message from becoming an
	 * entry's context.
	 */
	function blockText(block, occurrence) {
		return contextAround(block.text, occurrence.start, occurrence.end);
	}

	/** Remember a message fingerprint, keeping the cache bounded. */
	function remember(fingerprint) {
		seen.set(fingerprint, Date.now());
		if (seen.size <= MAX_SEEN_FINGERPRINTS) return;
		const oldest = [...seen.entries()].sort((left, right) => left[1] - right[1]).slice(0, seen.size - MAX_SEEN_FINGERPRINTS);
		for (const [key] of oldest) seen.delete(key);
	}

	/** Schedule a settled-transcript pass. */
	function scheduleSettle() {
		if (settleTimer !== null) clearTimeout(settleTimer);
		settleTimer = setTimeout(settle, SETTLE_MS);
	}

	/**
	 * Point the layer at a transcript and re-arm the settled pass.
	 *
	 * Region and scroll root move together because every reader below trusts the pair:
	 * {@link refreshSnapshot} walks the region while the observer watches the scroll root.
	 *
	 * The settled pass is scheduled whenever a region exists, not only when a scroll root
	 * does. It used to live inside the observer's own condition, so a page that mounted the
	 * conversation body without the observer ever being created ran no pass at all — the
	 * snapshot stayed empty, {@link onSettled} never fired, and the annotation layer had
	 * nothing to paint. The heartbeat recorded that as `hl:0` and `blocks:null` for an
	 * entire page generation while reporting the pointer counters correctly.
	 *
	 * @param nextRegion - the conversation body, or null.
	 * @param nextScroll - its scrolling element, or null.
	 * @returns true when the pair actually changed.
	 */
	function bind(nextRegion, nextScroll) {
		if (nextRegion === region && nextScroll === scrollRoot) return false;
		if (observer !== null) {
			observer.disconnect();
			observer = null;
		}
		region = nextRegion;
		scrollRoot = nextScroll;
		if (scrollRoot !== null && typeof win?.MutationObserver === "function") {
			observer = new win.MutationObserver(() => scheduleSettle());
			observer.observe(scrollRoot, { childList: true, subtree: true, characterData: true });
		}
		if (region !== null) {
			refreshSnapshot();
			scheduleSettle();
		}
		return true;
	}

	/** Find the live region and scroll root by asking the document. */
	function locate() {
		return bind(doc?.querySelector?.(REGION_SELECTOR) ?? null, doc?.querySelector?.(SCROLL_SELECTOR) ?? null);
	}

	return {
		/** Attach every listener and start observing the transcript. */
		attach() {
			if (attached || doc === null || doc === undefined) return;
			attached = true;
			locate();
			listen(doc, "selectionchange", onSelectionChange);
			listen(doc, "mousedown", (event) => {
				// A press on the plugin's own affordance must NOT clear the selection.
				// This listener is bound on the document in the CAPTURE phase, so it runs
				// before the button's own handler: clearing here unmounted the button
				// before its `click` could fire, and that is why pressing "加入词典" on a
				// selection did nothing at all. The button is identified by its marker
				// rather than by a class name, which the host is free to change.
				if (event.button !== 0) return;
				if (isOwnAffordance(event.target)) return;
				// A press anywhere that is not one of the plugin's own surfaces means the
				// explanation popup has served its purpose. It has no other dismissal path,
				// and it is a real fixed-position card over the transcript: while it stayed
				// open, the pointer landing on it was blocked by the very marker that
				// identifies it, and the area it covered stopped answering hovers and clicks.
				if (onPressOutside !== null && !isOwnSurface(event.target)) onPressOutside();
				clearSelectionAffordance();
			}, true);
			listen(win, "scroll", () => {
				clearSelectionAffordance();
			}, true);
			const watch = setInterval(() => {
				try {
					locate();
					// Without an observer nothing refreshes the transcript, and a reply that
					// streams into a mounted body would be read exactly once, at attach. The
					// poll is what the observer normally does; it runs only in that case.
					if (region !== null && observer === null) scheduleSettle();
				} catch (error) {
					warn("locating the transcript failed", error);
				}
			}, 2000);
			disposers.push(() => clearInterval(watch));
			// Bound on the document in the CAPTURE phase, and filtered by region rather than
			// by target, so it survives the transcript remounting. Capture is not cosmetic:
			// React 17+ delegates its own handlers to the root container, which sits below
			// the document, so a `stopPropagation()` anywhere in the app's tree silences a
			// bubble-phase document listener completely.
			listen(doc, "click", onClick, true);
		},
		/** Remove every listener and timer. */
		detach() {
			attached = false;
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch (error) {
					warn("removing a listener failed", error);
				}
			}
			if (observer !== null) observer.disconnect();
			observer = null;
			if (settleTimer !== null) clearTimeout(settleTimer);
			if (selectionTimer !== null) clearTimeout(selectionTimer);
			settleTimer = null;
			selectionTimer = null;
			region = null;
			scrollRoot = null;
			seen.clear();
		},
		/** Replace the detector after a dictionary change. */
		setDetector,
		/**
		 * Turn automatic collection on or off.
		 * @param enabled - the new state.
		 */
		setAutoCollect(enabled) {
			autoCollectEnabled = enabled !== false;
		},
		/** How many automatic creations the current budget window still allows. @returns the remaining count. */
		remainingBudget() {
			const cutoff = Date.now() - AUTO_BUDGET_WINDOW_MS;
			let live = 0;
			for (const at of recentCreations) if (at > cutoff) live++;
			return Math.max(0, MAX_AUTO_PER_MINUTE - live);
		},
		/**
		 * Force the answer every future sighting reports. Test seam: it lets a test
		 * assert the notice follows the store rather than this layer's own guess.
		 * @param answer - the answer `noteSighting` should resolve to, or null to use
		 *   the store's own.
		 */
		setSightingAnswer(answer) {
			forcedSightingAnswer = answer ?? null;
		},
		/**
		 * Narrow the "rare enough to record by itself?" decision. Test seam: it lets a
		 * check drive the collector's refusal path with a stub detector whose word is not a
		 * real identifier, without loosening the policy for the plugin.
		 * @param filter - a predicate, or null to restore the built-in policy.
		 */
		setAutoCreateFilter(filter) {
			autoCreateFilter = typeof filter === "function" ? filter : null;
		},
		/** Force one collection pass, used by tests. */
		scanNow() {
			refreshSnapshot();
			return collect(snapshot);
		},
		/** The cached transcript snapshot. */
		snapshot() {
			return snapshot;
		},
		/** Resolve a point to a term, used by tests. */
		termAtPoint,
		/** Report what the pointer pipeline sees at a point, used by tests and diagnosis. */
		probe,
		/** Report the layer's own state, for the diagnostic heartbeat. */
		stats() {
			return {
				attached,
				caretApi:
					typeof doc?.caretRangeFromPoint === "function" ? "caretRangeFromPoint" : typeof doc?.caretPositionFromPoint === "function" ? "caretPositionFromPoint" : "none",
				regionAdoptions,
				clickSeen,
				hitStages: { ...hitStages },
				budget: { click: clickBudget, reject: rejectBudget }
			};
		},
		/**
		 * Run the settled-transcript pass now, used by tests.
		 *
		 * The delay is what keeps a streaming reply from being scanned per token, and a test
		 * cannot wait for a wall clock it does not control.
		 * @returns how many blocks the pass read.
		 */
		settleNow() {
			settle();
			return snapshot.blocks.length;
		},
		/**
		 * Whether a settled pass is waiting to run, used by tests.
		 *
		 * This is the only way to see the scheduling half of {@link bind} from outside. The
		 * pass itself was previously reached only through the observer, so a page that mounted
		 * a body without one had nothing pending and nothing said so.
		 *
		 * @returns true when a pass is armed.
		 */
		settleScheduled() {
			return settleTimer !== null;
		},
		/** Whether the layer currently holds a conversation region. */
		hasRegion() {
			return region !== null;
		},
		/** How many conversation bodies the document mounts, read with the layer's own selector. */
		regionCount() {
			return chatCount();
		}
	};
}

module.exports = {
	createInteractionLayer,
	readRegion,
	findMessageElements,
	readBlock,
	blockAtPoint,
	wordAt,
	hashText,
	collapse,
	textRuns,
	offsetFromCaret,
	isBlockElement,
	isBlockLevel,
	hasOwnTextNodes,
	isComposer,
	isSkippedNode,
	isProseBlock,
	clampContext,
	MAX_CONTEXT_CHARS,
	REGION_SELECTOR,
	COMPOSER_SELECTOR,
	SCROLL_SELECTOR,
	SKIP_SELECTOR,
	SETTLE_MS,
	MAX_BLOCK_CHARS,
	MAX_AUTO_PER_MESSAGE,
	MAX_AUTO_PER_MINUTE,
	AUTO_BUDGET_WINDOW_MS,
	MAX_SELECTION_CHARS
};
