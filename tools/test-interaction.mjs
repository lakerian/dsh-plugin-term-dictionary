// Interaction-layer tests for the term dictionary plugin.
//
// These exercise the two behaviours a user actually touches — clicking a term in
// the transcript to see it explained, and selecting a phrase to add it — against a
// hand-built DOM stand-in. The layer reads the render tree through `Range` and
// `caretRangeFromPoint`, so a fake that reports text per block is enough to prove
// the mapping from a pointer position to a term.
//
// Usage: node tools/test-interaction.mjs [--filter <substring>]

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coreDir } from "./paths.mjs";

/**
 * Layers built by {@link makeLayer}, detached before the process exits.
 *
 * Declared before the checks run, not beside `makeLayer`: `makeLayer` pushes into it,
 * and a `const` further down the file is in its temporal dead zone while the
 * synchronous checks execute.
 */
const layers = [];

const here = dirname(fileURLToPath(import.meta.url));
const libDir = coreDir;
const require_ = createRequire(import.meta.url);

const filterArg = process.argv.indexOf("--filter");
const filter = filterArg > 0 ? process.argv[filterArg + 1] : "";

let passed = 0;
let failed = 0;

/** Register and run one named check. */
function test(name, fn) {
	if (filter !== "" && !name.includes(filter)) return;
	try {
		fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Assert a condition. */
function assert(condition, message) {
	if (!condition) throw new Error(message ?? "assertion failed");
}

/** Assert JSON-equal values. */
function assertEqual(actual, expected, message) {
	const left = JSON.stringify(actual);
	const right = JSON.stringify(expected);
	if (left !== right) throw new Error(`${message ?? "values differ"}\n       actual:   ${left}\n       expected: ${right}`);
}

const core = require_(join(libDir, "core.js"));
const { createInteractionLayer, readRegion, readBlock, blockAtPoint, wordAt, hashText, collapse, isComposer, textRuns, offsetFromCaret, MAX_BLOCK_CHARS, MAX_AUTO_PER_MINUTE, SETTLE_MS } = require_(join(libDir, "interact.js"));
const { createTermHighlighter, rangesForBlock, rawOffsetForBody, HIGHLIGHT_NAME, HIGHLIGHT_CSS } = require_(join(libDir, "highlight.js"));
const { TermDetector } = require_(join(libDir, "terms.js"));
const lexiconEn = require_(join(libDir, "lexicon.en.js"));
const lexiconZh = require_(join(libDir, "lexicon.zh.js"));
const stopwordLists = require_(join(libDir, "stopwords.js"));

/**
 * Recompute one element's rendered text from its subtree, the way a browser
 * derives `innerText`: own text first, then each element child on its own line.
 * @param node - the element to refresh.
 * @returns the element.
 */
function refreshText(node) {
	const inner = [];
	const raw = [];
	// Only the child nodes contribute. An element's own text is a text node in
	// `childNodes`, which is what a browser reports and what the layer reads; keeping
	// a second copy on the element would count every character twice.
	for (const child of node.childNodes) {
		// A text node carries its value directly; an element carries a rendered
		// subtree, which may legitimately be empty.
		const text = child.nodeType === 3 ? child.nodeValue : child.innerText;
		if (typeof text === "string" && text !== "") inner.push(text);
		raw.push(child.nodeType === 3 ? child.nodeValue : child.textContent);
	}
	node.innerText = inner.join("\n");
	node.textContent = raw.join("");
	return node;
}

/**
 * Build an element with a real DOM shape: children link both ways, and
 * `innerText`/`textContent` are plain, eagerly computed values. They are plain
 * properties rather than accessors because the interaction layer reads them off
 * detached stand-ins, where an accessor on one node is easy to shadow.
 *
 * @param options - `text` for own text, `children`, `attrs`, `rect`, `tag`.
 * @returns the element.
 */
function element(options = {}) {
	const self = {
		nodeType: 1,
		tagName: options.tag ?? "DIV",
		// The DOM reports both names, and the layer's diagnostic records print `nodeName` — with
		// only `tagName` here every one of them read `undefined`, which is a fixture gap rather
		// than a fact about the page.
		nodeName: (options.tag ?? "DIV").toUpperCase(),
		nodeValue: null,
		parentElement: null,
		parentNode: null,
		children: [],
		childNodes: [],
		innerText: "",
		textContent: "",
		rect: options.rect,
		/**
		 * The element's declared own text, kept so a test can assert it. The rendered
		 * value lives in the text node pushed to `childNodes`, exactly as a browser
		 * reports it.
		 */
		_ownText: options.text ?? "",
		/** Marks an element whose rendered text this fixture computes from children. */
		_autoText: true,
		_attrs: options.attrs ?? {},
		getAttribute(name) {
			return this._attrs[name] ?? null;
		},
		hasAttribute(name) {
			return this._attrs[name] !== undefined;
		},
		contains(other) {
			let at = other;
			while (at !== null && at !== undefined) {
				if (at === this) return true;
				at = at.parentElement;
			}
			return false;
		},
		/**
		 * Walk the ancestor chain and test each one, the way the DOM does.
		 *
		 * This used to answer `null` for everything, which quietly ruled out every code path
		 * built on `closest` — including the one that adopts the conversation body a pointer is
		 * genuinely over. Comma-separated selectors still do not parse below, so a check that
		 * wants one of those keeps overriding `closest` on the node itself.
		 * @param selector - an attribute selector.
		 * @returns the nearest matching ancestor, or null.
		 */
		closest(selector) {
			let at = this;
			while (at !== null && at !== undefined) {
				if (typeof at.matches === "function" && at.matches(selector)) return at;
				at = at.parentElement;
			}
			return null;
		},
		getBoundingClientRect() {
			return this.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
		},
		/**
		 * A minimal attribute selector for the two the layer uses, searched over the
		 * subtree. The layer prefers the host's row contract when a root can query, so a
		 * fixture that wants that path has to offer one; a test may replace it.
		 * @param selector - an attribute selector such as `[data-chat-flow-key]`.
		 * @returns the first match, or null.
		 */
		querySelector(selector) {
			const match = (node) => {
				for (const child of node.children) {
					if (typeof child.matches === "function" && child.matches(selector)) return child;
					const deeper = match(child);
					if (deeper !== null && deeper !== undefined) return deeper;
				}
				return null;
			};
			return match(this);
		},
		querySelectorAll(selector) {
			const out = [];
			const visit = (node) => {
				for (const child of node.children) {
					if (typeof child.matches === "function" && child.matches(selector)) out.push(child);
					visit(child);
				}
			};
			visit(this);
			return out;
		},
		matches(selector) {
			const exact = selector.match(/^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/);
			if (exact === null) return false;
			const value = this._attrs[exact[1]];
			if (value === undefined || value === null) return false;
			return exact[2] === undefined || value === exact[2];
		}
	};
	// Own text becomes a real text node in `childNodes` only: `children` holds
	// elements, which is the distinction the layer's chrome detection and its
	// text-node walk both rely on. An element built with children keeps its text here
	// too, so a row with a preamble is modelled the way the layer detects it.
	if (self._ownText !== "") {
		const node = textNode(self._ownText);
		node.parentElement = self;
		node.parentNode = self;
		self.childNodes.push(node);
	}
	for (const child of options.children ?? []) {
		child.parentElement = self;
		child.parentNode = self;
		self.children.push(child);
		self.childNodes.push(child);
	}
	return refreshText(self);
}

/**
 * Recompute the rendered text of an element and every ancestor.
 * @param node - the attached node.
 * @returns the node.
 */
function refreshUp(node) {
	let at = node;
	while (at !== null && at !== undefined) {
		// Only elements this fixture derives text for. A node built with an explicit
		// `innerText` owns its own value, and a text node has no children at all.
		if (at.nodeType === 1 && at._autoText === true) refreshText(at);
		at = at.parentElement;
	}
	return node;
}

/**
 * Attach a child, keeping every parent link and every ancestor's rendered text
 * consistent.
 * @param parent - the parent element.
 * @param child - the child node.
 * @returns the child.
 */
function append(parent, child) {
	child.parentElement = parent;
	child.parentNode = parent;
	parent.children.push(child);
	parent.childNodes.push(child);
	refreshUp(parent);
	return child;
}

/**
 * Build a message block whose rendered text lives in one text node, with the
 * parent links the layer walks.
 * @param text - the block's text.
 * @param rect - the block's viewport box.
 * @returns the block element.
 */
/**
 * Build a real text node.
 * @param value - the node's text.
 * @returns the text node.
 */
function textNode(value) {
	return { nodeType: 3, nodeValue: value, textContent: value, parentElement: null, parentNode: null, children: [], childNodes: [] };
}

/**
 * Build a message block: one element whose rendered text lives in one text node,
 * so the caret-to-offset walk has something real to map into.
 * @param text - the block's text.
 * @param rect - the block's viewport box.
 * @returns the block element.
 */
function makeBlock(text, rect) {
	const block = element({ rect });
	const node = textNode(text);
	append(block, node);
	return block;
}

/**
 * Build a region element whose children are message blocks.
 * @param blocks - `{ text, top, height }` per block, laid out in 100px tall rows.
 * @returns the region node.
 */
function makeRegion(blocks) {
	// Tagged the way the host tags the live conversation body, so a check that reaches the
	// region through `closest` — which is how a pointer that arrived before the body was
	// mounted now finds it — has something real to match instead of a bare anonymous node.
	const region = element({ attrs: { "data-conversation-region": "chat" } });
	for (const [index, block] of blocks.entries()) {
		const top = block.top ?? index * 100;
		const height = block.height ?? 100;
		append(region, makeBlock(block.text, { left: 0, top, right: 400, bottom: top + height, width: 400, height }));
	}
	return region;
}

/**
 * Build the real transcript shape: one region holding a scroll container, which holds
 * every message.
 *
 * The distinction matters because the plugin's own `regionFor` (and any code that walks
 * up to the region's direct child) lands on the scroll container rather than on a
 * message — which is how a context once became the whole conversation.
 *
 * @param blocks - `{ text, top, height }` per block.
 * @returns the region node.
 */
function wrapRegion(blocks) {
	const region = element();
	const scroll = element({ attrs: { "data-conversation-scroll": "" } });
	append(region, scroll);
	for (const [index, block] of blocks.entries()) {
		const top = block.top ?? index * 100;
		const height = block.height ?? 100;
		append(scroll, makeBlock(block.text, { left: 0, top, right: 400, bottom: top + height, width: 400, height }));
	}
	return region;
}

/**
 * The text node inside a block, which is what a caret range reports.
 * @param block - a block element.
 * @returns its first text node.
 */
function textNodeOf(block) {
	return block.childNodes[0];
}

/**
 * Build a detector over the bundled lexicons.
 * @param entries - dictionary entries to project, so a test can distinguish a
 *   collected term from a glossary one.
 * @returns the detector.
 */
function makeDetector(entries = []) {
	return new TermDetector({ lexicon: { ...lexiconEn, ...lexiconZh }, entries, stopwords: stopwordLists });
}

console.log("term-dictionary interaction tests\n");

//#region text reading

test("readRegion: one entry per message, whitespace collapsed, offsets consistent", () => {
	const region = makeRegion([{ text: "  First   block  " }, { text: "Second block" }]);
	const read = readRegion(region);
	assertEqual(read.blocks.length, 2, "both blocks are read");
	assertEqual(read.blocks[0].text, "First block", "whitespace collapses");
	assertEqual(read.offsets, [0, 12], "the second block starts one separator past the first");
	assertEqual(read.text, "First block Second block", "the joined text");
	assertEqual(read.text.slice(read.offsets[1]), "Second block", "an offset maps back to the start of its block");
	assertEqual(read.blocks[1].start, read.offsets[1], "each block carries its own start offset");
});

test("readRegion: empty blocks are skipped", () => {
	const read = readRegion(makeRegion([{ text: "Real" }, { text: "   " }, { text: "Also" }]));
	assertEqual(read.blocks.map((block) => block.text), ["Real", "Also"], "blank blocks are dropped");
	assertEqual(read.offsets, [0, 5], "offsets stay correct across the skip");
});

test("readRegion: the composer is never read as a message", () => {
	// The real shape, as shipped: the chat region contains a scroll body, which
	// contains the message list AND the composer seat. Reading the region wholesale
	// would fold every message into one block and sweep in the user's unsent draft.
	// The chat region is the BODY; the scroll body and the composer seat are its
	// children, and the messages are nested inside the scroll body.
	const region = element();
	const body = element({ attrs: { "data-conversation-region": "chat" } });
	append(region, body);
	const scroll = element({ attrs: { "data-conversation-scroll": "" } });
	append(body, scroll);
	const views = element();
	append(scroll, views);
	const message = makeBlock("We adopted event sourcing for the ledger.", { left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40 });
	append(views, message);
	const seat = makeBlock("please refactor the idempotency helper", { left: 0, top: 500, right: 400, bottom: 560, width: 400, height: 60 });
	seat._attrs = { "data-composer-seat": "", "data-conversation-region": "composer" };
	append(scroll, seat);
	append(body, element());

	const read = readRegion(region);
	assertEqual(read.blocks.length, 1, `the region must read as one message block, got ${read.blocks.length}`);
	assertEqual(read.text, "We adopted event sourcing for the ledger.", "the block is the message");
	assert(!read.text.includes("idempotency"), `the unsent draft must not be collected, got ${JSON.stringify(read.text)}`);
	assert(!read.text.includes("refactor"), "no part of the draft may appear");
	assertEqual(isComposer(seat), true, "the composer seat is identified");
	assertEqual(isComposer(message), false, "a message is not the composer");
	assertEqual(isComposer(views), false, "an ancestor of neither is not the composer");
});

test("readRegion: nested wrappers are descended into, not read as one block", () => {
	// Two messages behind a wrapper chain must stay two blocks; folding them into
	// one would make the per-message cap and the pointer geometry meaningless.
	const region = element();
	const wrapper = element();
	append(region, wrapper);
	const inner = element();
	append(wrapper, inner);
	append(inner, makeBlock("First message.", { left: 0, top: 0, right: 400, bottom: 20, width: 400, height: 20 }));
	append(inner, makeBlock("Second message.", { left: 0, top: 20, right: 400, bottom: 40, width: 400, height: 40 }));
	const read = readRegion(region);
	assertEqual(read.blocks.map((block) => block.text), ["First message.", "Second message."], "each message is its own block");
	assertEqual(read.offsets.length, 2, "both blocks carry an offset");
});

test("readRegion: a transcript longer than one block still yields blocks", () => {
	// The regression guard for the size cap being tested on the way down: the
	// region's own text is the whole conversation, so rejecting the root because it
	// is large silently disabled both auto-collection and click-to-explain for any
	// long session. One detailed agent reply is enough to cross the cap.
	const long = "x".repeat(Math.ceil(MAX_BLOCK_CHARS / 2) + 100);
	const region = element();
	const body = element({ attrs: { "data-conversation-region": "chat" } });
	append(region, body);
	const scroll = element({ attrs: { "data-conversation-scroll": "" } });
	append(body, scroll);
	const views = element();
	append(scroll, views);
	const first = makeBlock(`${long} idempotent`, { left: 0, top: 0, right: 400, bottom: 4000, width: 400, height: 4000 });
	append(views, first);
	append(views, makeBlock("second message about quorum", { left: 0, top: 4000, right: 400, bottom: 4020, width: 400, height: 20 }));
	const seat = makeBlock("draft text", { left: 0, top: 5000, right: 400, bottom: 5020, width: 400, height: 20 });
	seat._attrs = { "data-composer-seat": "" };
	append(scroll, seat);

	const read = readRegion(region);
	assertEqual(read.blocks.length, 2, `a long transcript must still produce blocks, got ${read.blocks.length}`);
	assert(read.text.includes("idempotent"), "the long message is read");
	assert(read.text.includes("quorum"), "the short one too");
	assert(!read.text.includes("draft"), "and never the draft");
});

test("selection: pressing the add button does not clear the selection first", () => {
	// The regression guard for "选中词汇添加无法真正添加". The layer clears the selection on a
	// document-level `mousedown` bound in the CAPTURE phase, so that listener ran before
	// the button's own handler and unmounted the button before its `click` could fire.
	// A press on the plugin's own affordance must be exempt; a press anywhere else must
	// still abandon the selection. `clearSelectionAffordance` is observable through the
	// `onSelection(null)` it emits, which is what this counts.
	const { log, region, fire } = makeLayer([{ text: "We adopted the WriteAheadLog." }]);
	const clears = () => log.selection.filter((entry) => entry === null).length;

	// The affordance is marked, and the press target is a CHILD of it — which is the
	// case that matters, because the user presses the label, not the button box.
	const affordance = element({ attrs: { "data-term-dictionary": "affordance" } });
	const label = element({ tag: "SPAN", text: "加入词典" });
	append(affordance, label);
	const before = clears();
	fire("mousedown", { button: 0, target: label });
	assertEqual(clears(), before, "a press on the add button must not clear the selection");

	// A press anywhere else does clear it, so the guard is a distinction and not a
	// disabled listener.
	fire("mousedown", { button: 0, target: region });
	assert(clears() > before, "a press elsewhere still clears the selection");
});

test("readRegion: chrome beside prose stays in the same block", () => {
	// The ordinary message row shape: an inline label and the prose in a paragraph.
	// The label is inline text on the row, not a block of its own, so splitting on it
	// would make one message into two blocks and turn the per-message collection cap
	// into a per-fragment cap.
	const region = element();
	const row = element({ text: "DS" });
	append(region, row);
	const prose = element();
	append(row, prose);
	append(prose, element({ tag: "P", text: "We adopted event sourcing for the ledger." }));
	const read = readRegion(region);
	assertEqual(read.blocks.length, 1, `one message must be one block, got ${read.blocks.length}`);
	assertEqual(read.blocks[0].text, "We adopted event sourcing for the ledger.", "and the inline chrome is not part of it");
});

test("readRegion: a wrapper with its own preamble still splits its messages", () => {
	// The unsafe direction: collapsing several messages into one block silently
	// disables the per-message cap. A wrapper that carries a preamble of its own must
	// still hand each message out separately.
	const region = element();
	const turn = element({ text: "Turn 1 — preparing the change" });
	append(region, turn);
	const list = element();
	append(turn, list);
	for (const message of ["first message about quorum", "second message about sidecar", "third message about sharding"]) {
		append(list, element({ tag: "P", text: message }));
	}
	const read = readRegion(region);
	assertEqual(read.blocks.length, 3, `each message must be its own block, got ${read.blocks.length}`);
});

test("readRegion: a control beside the messages is never read as a message", () => {
	// The regression guard for a real defect: the host's scrolling column holds the
	// "加载更早" control beside the message rows, and the structural walk — which had no
	// notion of the host's markup — read that button as a message, so the plugin created a
	// dictionary entry out of a UI label. The row contract is preferred whenever the root
	// can run a selector, and the control carries neither a flow key nor a node slot.
	const region = element();
	const column = append(region, element({ attrs: { "data-chat-flow": "" } }));
	const control = append(column, element({ attrs: { class: "ChatView_module_css_default older" } }));
	append(control, element({ tag: "BUTTON", text: "加载更早" }));

	const addMessage = (key, text, top) => {
		const row = append(column, element({ attrs: { "data-chat-flow-key": key, "data-chat-node-key": key, "data-chat-flow-kind": "assistant" } }));
		const content = append(row, element({ attrs: { "data-slot": "conversation.chat.node" } }));
		append(content, element({ tag: "P", text, rect: { left: 0, top, right: 400, bottom: top + 20, width: 400, height: 20 } }));
		return content;
	};
	addMessage("n1", "We adopted the WriteAheadLog.", 0);
	addMessage("n2", "What does the quorum do?", 40);

	// `querySelectorAll` is what selects the contract path; the fixture provides it.
	const rowsIn = (selector) => {
		const out = [];
		const visit = (node) => {
			for (const child of node.children) {
				if (selector === "[data-chat-flow-key]" && child.getAttribute("data-chat-flow-key") !== null) out.push(child);
				visit(child);
			}
		};
		visit(region);
		return out;
	};
	region.querySelectorAll = rowsIn;
	region.querySelector = (selector) => (selector === '[data-slot="conversation.chat.node"]' ? null : rowsIn(selector)[0] ?? null);
	for (const row of rowsIn("[data-chat-flow-key]")) {
		const content = row.querySelector('[data-slot="conversation.chat.node"]');
		row.querySelector = (selector) => (selector === '[data-slot="conversation.chat.node"]' ? content ?? null : null);
	}

	const read = readRegion(region);
	assertEqual(read.blocks.length, 2, `only the two messages may be read, got ${JSON.stringify(read.blocks.map((b) => b.text))}`);
	assertEqual(read.text.includes("加载更早"), false, "the control's label must never reach the detector");
	assertEqual(read.blocks[0].text, "We adopted the WriteAheadLog.", "the first message is read from its node container");
	assertEqual(read.blocks[1].text, "What does the quorum do?", "and the second likewise");
});

test("readRegion: a missing region reads as empty rather than throwing", () => {
	const read = readRegion(null);
	assertEqual(read.text, "", "no text");
	assertEqual(read.blocks.length, 0, "no blocks");
});

test("readBlock and collapse agree with readRegion", () => {
	assertEqual(collapse(" a \n b "), "a b", "collapse");
	assertEqual(readBlock({ innerText: " a \n b " }), "a b", "readBlock");
});

test("hashText: stable per text and different across texts", () => {
	assertEqual(hashText("same"), hashText("same"), "stable");
	assert(hashText("alpha") !== hashText("beta"), "distinct");
});

//#endregion

//#region geometry

test("blockAtPoint: a point inside a block yields that block and a bounded offset", () => {
	const region = makeRegion([{ text: "First block here", top: 0 }, { text: "Second block here", top: 100 }]);
	const read = readRegion(region);
	const hit = blockAtPoint(read.blocks, 200, 110);
	assert(hit !== null, "the point must land somewhere");
	assertEqual(hit.block.text, "Second block here", "the second block contains the point");
	assert(hit.offset >= 0 && hit.offset <= hit.block.text.length, `offset must be bounded, got ${hit.offset}`);
	assert(hit.offset > 0, "a point at the middle of the block must not resolve to offset 0");
});

test("blockAtPoint: a point in the empty space below the transcript is NOT a hit", () => {
	// The regression guard for "点击解释功能在空白区域点击就会出现". This used to return the
	// nearest block at offset 0, so a click anywhere in the padding under the last
	// message opened an explanation for an unrelated term — and the term it picked was
	// whatever happened to be closest, which is how a click on blank space explained a
	// UI control. A point outside every block must resolve to nothing.
	const region = makeRegion([{ text: "First", top: 0, height: 100 }, { text: "Second", top: 200, height: 100 }]);
	const read = readRegion(region);
	// `assert` rather than `assertEqual`: these fixtures link parents both ways, so
	// stringifying a block to report a failure would throw on the cycle.
	assert(blockAtPoint(read.blocks, 10, 150) === null, "the gap between two blocks is not a hit");
	assert(blockAtPoint(read.blocks, 10, 900) === null, "the space below the last block is not a hit");
	assert(blockAtPoint(read.blocks, 10, -500) === null, "the space above the first block is not a hit");
	// A point beside a line IS on that line — the horizontal extent is not what decides
	// — so the rule is about the vertical position, not about being inside the box.
	assert(blockAtPoint(read.blocks, -200, 20) !== null, "a point on the first line still resolves");
	// And a point genuinely inside a block resolves to that block.
	const inside = blockAtPoint(read.blocks, 10, 250);
	assert(inside !== null, "a point inside the second block still resolves");
	assertEqual(inside.block.text, "Second", "and it is the block it is over");
});

test("blockAtPoint: no blocks means no hit", () => {
	assertEqual(blockAtPoint([], 10, 10), null, "empty input");
});

test("wordAt: expands to the whole word run and stops at separators", () => {
	const text = "call runInTransaction before";
	const at = text.indexOf("InTransaction") + 3;
	const word = wordAt(text, at, core.isWordCharacter);
	assertEqual(text.slice(word.start, word.end), "runInTransaction", "the whole identifier");
	assertEqual(wordAt(text, 0, core.isWordCharacter).start, 0, "a word at the start");
	assertEqual(wordAt("   ", 1, core.isWordCharacter), null, "no word in whitespace");
	// `-` and `_` are word characters for the detector, so a kebab or snake name is one word.
	const kebab = "use event-sourcing here";
	const atKebab = kebab.indexOf("sourcing");
	assertEqual(kebab.slice(...Object.values(wordAt(kebab, atKebab, core.isWordCharacter))).length > 5, true, "a hyphenated name expands");
});

//#endregion

//#region click to explain

/** Layers built by {@link makeLayer}, detached before the process exits. */
void 0;

/**
 * Build a layer over a synthetic region and return the captured callback log.
 *
 * `caretOffset` positions a fake caret inside the first block's text node, which
 * is how the layer learns which character the pointer is over.
 *
 * @param blocks - the region's messages.
 * @param caretOffset - the caret's offset inside the first block's text node.
 * @param options - `entries` for the detector, `region` to supply the tree directly,
 *   `wrap` to build the real region → scroll-container → messages shape, and
 *   `selection` (a value or a thunk) for the window's live selection.
 * @returns `{ layer, log, region, detector }`.
 */
function makeLayer(blocks, caretOffset = 0, options = {}) {
	const region = options.region ?? (options.wrap === true ? wrapRegion(blocks) : makeRegion(blocks));
	const log = { explain: [], activation: [], hover: [], hoverEnd: 0, selection: [], toast: [], sightings: [], collected: [], settled: [] };
	const detector = makeDetector(options.entries ?? []);
	// A minimal store stand-in: the collection pass only reads the entry list and
	// records sightings, so nothing else needs to exist here.
	const entries = [];
	const store = {
		getState: () => ({ entries }),
		noteSighting(sighting) {
			log.sightings.push(sighting.term);
			entries.push({ key: core.normalizeTerm(sighting.term) });
			return { created: true };
		}
	};
	/** Listeners registered on the document, so a check can dispatch a real event. */
	const documentListeners = new Map();
	/** Every registration, with the phase it was registered in. */
	const registrations = [];
	const documentStub = {
		querySelector: (selector) => {
			if (options.regionHiddenFromDoc === true && selector.includes("conversation")) return null;
			// A page that mounts a composer seat as well — which every page does. The seat carries the
			// bare attribute (its value is `composer`) and sits INSIDE the chat body, so a selector that
			// only looks for the attribute matches it first and the layer reads the draft as the
			// transcript. Modelled here so the selector's VALUE is what a check can see.
			if (options.seat !== undefined && selector === "[data-conversation-region]") return options.seat;
			if (selector.includes("scroll")) return options.scroll === false ? null : region;
			return selector.includes("conversation") ? region : null;
		},
		querySelectorAll: (selector) => {
			if (options.regionHiddenFromDoc === true) return [];
			const matches = typeof region.matches === "function" && region.matches(selector);
			return matches ? [region] : [];
		},
		addEventListener: (type, handler, opts) => {
			if (!documentListeners.has(type)) documentListeners.set(type, new Set());
			documentListeners.get(type).add(handler);
			registrations.push({ type, capture: opts === true || opts?.capture === true });
		},
		removeEventListener: (type, handler) => documentListeners.get(type)?.delete(handler),
		caretRangeFromPoint: () => ({ startContainer: options.caretNode ?? textNodeOf(region.children[0]), startOffset: caretOffset }),
		// Only a test that asks for it gets hit testing. The real page always has it, so a
		// fixture that omits it exercises the caret path alone — which is exactly why the
		// guard that used to live there went unnoticed.
		...(typeof options.elementFromPoint === "function" ? { elementFromPoint: options.elementFromPoint } : {})
	};
	/** Dispatch an event to every listener the layer registered for its type. */
	const fire = (type, event) => {
		for (const handler of documentListeners.get(type) ?? []) handler(event);
	};
	const windowStub = {
		getSelection: () => {
			const live = typeof options.selection === "function" ? options.selection() : options.selection;
			return live ?? { isCollapsed: true, rangeCount: 0, toString: () => "" };
		},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		innerWidth: 1200,
		innerHeight: 800
	};
	const layer = createInteractionLayer({
		detector,
		store,
		document: documentStub,
		window: windowStub,
		isWordCharacter: core.isWordCharacter,
		// Permissive on purpose. These checks are about the collector's LOGIC; what the shipped
		// defaults refuse (code-shaped names, terms under four characters) is asserted in the
		// settings checks. Without this, a real regression in collection would be masked by a
		// preference, which is the opposite of a guard.
		collectSettings: () => ({ collectMinLength: 1, collectIdentifiers: true, collectCjk: true }),
		logger: { warn: () => {} },
		onExplain: (hit, point) => log.explain.push({ hit, point }),
		onActivate: (hit, point) => log.activation.push({ hit, point }),
		onHover: (hit, point) => log.hover.push({ hit, point }),
		onHoverEnd: () => {
			log.hoverEnd += 1;
		},
		onCollected: (items) => log.collected.push(...items),
		onSettled: (node) => log.settled.push(node),
		...(typeof options.onPressOutside === "function" ? { onPressOutside: options.onPressOutside } : {}),
		...(typeof options.diagnose === "function" ? { diagnose: options.diagnose } : {}),
		onSelection: (next) => log.selection.push(next),
		onToast: (notice) => log.toast.push(notice)
	});
	layer.attach();
	// `attach` starts a polling interval and a settle timer, which is correct for
	// the page but would keep Node alive after the suite finishes; every layer
	// built here is detached once the checks are done.
	layers.push(layer);
	return { layer, log, region, detector, fire, registrations };
}

test("click: a known glossary term resolves to that term and its phrase", () => {
	const text = "We adopted event sourcing for the ledger.";
	const caret = text.indexOf("event");
	const { layer } = makeLayer([{ text }], caret + 2);
	const hit = layer.termAtPoint(30, 10);
	assert(hit !== null, "the point must resolve");
	assertEqual(hit.term, "event sourcing", "the phrase, not one word of it");
	assertEqual(hit.known, true, "the glossary knows it");
});

test("click: the caret offset decides which term is picked inside one block", () => {
	const text = "First we discuss quorum, and later we discuss sidecar.";
	const { layer } = makeLayer([{ text }], text.indexOf("sidecar") + 1);
	const hit = layer.termAtPoint(30, 10);
	assert(hit !== null, "the point must resolve");
	assertEqual(hit.term, "sidecar", "the term under the caret, not the first term in the block");
});

test("click: an unknown identifier resolves to the bare word", () => {
	const text = "Call runInTransaction before you commit.";
	const { layer } = makeLayer([{ text }], text.indexOf("runInTransaction") + 3);
	const hit = layer.termAtPoint(30, 10);
	assert(hit !== null, "the point must resolve");
	assertEqual(hit.term, "runInTransaction", "the identifier");
	assertEqual(hit.known, false, "no dictionary entry yet");
});

test("click: ordinary prose resolves to nothing", () => {
	const text = "The user said the file is in the folder.";
	const { layer } = makeLayer([{ text }], text.indexOf("folder"));
	assertEqual(layer.termAtPoint(30, 10), null, "everyday words are not terms");
});

test("click: the context handed to the popup is the containing sentence", () => {
	const text = "The quorum decides. A quorum is a majority of voters.";
	const { layer } = makeLayer([{ text }], text.lastIndexOf("quorum") + 1);
	const hit = layer.termAtPoint(200, 10);
	assert(hit !== null, "a term must resolve");
	assertEqual(hit.term, "quorum", "the term containing the caret");
	// The NAME of this check always claimed a sentence while the assertion demanded the
	// whole message, and the whole message is what a long reply turned into an entry's
	// context. Now both agree. The window stops AT the terminator, which is how
	// `contextAround` has always behaved for the detector's own contexts too.
	assertEqual(hit.context, "A quorum is a majority of voters", "the popup receives the containing sentence, not the whole reply");
});

test("click: a long reply hands over a bounded window, not the whole message", () => {
	// The same rule at the scale that broke the editor: a reply of many sentences must
	// not put all of them into a context.
	const sentences = [];
	for (let index = 0; index < 60; index++) sentences.push(`Filler sentence number ${index} about unrelated plumbing.`);
	sentences.push("We adopted the WriteAheadLog for durability.");
	const text = sentences.join(" ");
	const { layer } = makeLayer([{ text }], text.indexOf("WriteAheadLog") + 3);
	const hit = layer.termAtPoint(30, 10);
	assert(hit !== null, "a term must resolve");
	assert(hit.context.includes("WriteAheadLog"), "the context must contain the term");
	assert(hit.context.length <= 240, `the context must stay bounded, got ${hit.context.length} characters`);
	assert(!hit.context.includes("Filler sentence number 0"), "no far-away sentence may be dragged in");
});

test("click: a skipped container (code, links) resolves to nothing", () => {
	const text = "Call runInTransaction now.";
	const { layer, region } = makeLayer([{ text }], 6);
	// A code element is modelled by giving the block (the text node's parent, which
	// is where `closest` is consulted) a closest() that reports one.
	region.children[0].closest = () => ({ tagName: "CODE" });
	assertEqual(layer.termAtPoint(30, 10), null, "a click inside code must not open the popup");
});

test("click: an element drawn over the message does not swallow the click", () => {
	// The real-DOM case the fixture never produced: the host draws hover toolbars, sticky
	// rows and selection layers OVER a message, so the topmost element at the pointer is a
	// SIBLING of the text, not a descendant of the block. The old guard demanded a
	// descendant and therefore returned nothing for every hover and every click in that
	// message; the caret check that follows it answers the real question precisely.
	const text = "We adopted the WriteAheadLog for durability.";
	const caret = text.indexOf("WriteAheadLog") + 3;
	const overlay = element({ tag: "DIV", attrs: { "data-hover-toolbar": "" } });
	const { layer, region } = makeLayer([{ text }], caret, { elementFromPoint: () => overlay });
	// The overlay really is a sibling drawn over the block, not part of it.
	append(region, overlay);
	assertEqual(region.contains(overlay), true, "the overlay is inside the region");
	assertEqual(region.children[0].contains(overlay), false, "and is not inside the message block");
	const hit = layer.termAtPoint(30, 10);
	assert(hit !== null, "a click under an overlay must still resolve");
	assertEqual(hit.term, "WriteAheadLog", "to the term under the pointer");
});

test("click: a block whose innerText differs from the run walk still resolves the caret's term", () => {
	// The other real-DOM case: `innerText` and the run walk legitimately disagree (a hidden
	// child, a nested block, a `<button>`), and the old code responded by discarding the
	// caret's EXACT offset in favour of a GEOMETRIC estimate from the pointer's distance to
	// the block's left edge. On a multi-line paragraph that estimate is systematically
	// wrong, so the click resolved to an unrelated word — or to nothing at all.
	const text = "Filler first sentence. We adopted the WriteAheadLog for durability. Filler last sentence.";
	const caret = text.indexOf("WriteAheadLog") + 3;
	const block = makeBlock(text, { left: 0, top: 0, right: 400, bottom: 60, width: 400, height: 60 });
	// Stop the fixture recomputing this block's rendered text, then disagree with its text
	// nodes deliberately: `innerText` is what the reader takes for `block.text`, while the
	// caret still walks the real text nodes.
	block._autoText = false;
	block.innerText = "a completely different rendering of this block";
	const region = element();
	append(region, block);
	const { layer } = makeLayer([], caret, { region });
	assertEqual(readRegion(region).blocks[0].text, "a completely different rendering of this block", "the reader sees the divergent rendering");
	const hit = layer.termAtPoint(30, 10);
	assert(hit !== null, "the point must still resolve");
	assertEqual(hit.term, "WriteAheadLog", "to the word the caret is actually on");
});

test("diagnose: the probe reports every stage of the pointer pipeline", () => {
	// The instrument that answers "why does nothing happen in a real page". Each field is a
	// stage `termAtPoint` decides on, so a report from a broken page names the failure.
	const text = "We adopted the WriteAheadLog for durability.";
	const caret = text.indexOf("WriteAheadLog") + 3;
	const { layer } = makeLayer([{ text }], caret);
	const record = layer.probe(30, 10);
	assertEqual(typeof record.region, "string", "the region it found is reported");
	assert(record.blocks > 0, `the snapshot has blocks, got ${record.blocks}`);
	assertEqual(record.block === "null", false, "the block the point fell in is reported");
	assertEqual(record.caretInBlock, true, "and the caret is inside it");
	assert(String(record.hit).startsWith("WriteAheadLog|"), `the resolved term is reported, got ${record.hit}`);
});






test("locate: a region with no scroll root still arms the settled pass", () => {
	// The half of "no entry ever appears in a reply" that no pointer gesture can show. The
	// observer used to be created inside the scroll root's own condition and the pass was
	// scheduled from it, so a body mounted without a scroll root ran no pass at all: the
	// snapshot stayed empty, `onSettled` never fired, and the heartbeat recorded hl:0 with
	// blocks:null for a whole generation while its pointer counters looked healthy.
	const { layer, log } = makeLayer([{ text: "We adopted the WriteAheadLog for durability." }], 0, { scroll: false });
	assertEqual(layer.settleScheduled(), true, "the pass is armed even though nothing observes the transcript");
	assertEqual(layer.settleNow(), 1, "running it reads the one message");
	assertEqual(log.settled.length, 1, "and the annotation layer is told which region settled");
});

test("locate: the region selector names the chat value, so the composer seat is never adopted", () => {
	// The host puts `data-conversation-region="composer"` on the composer seat, INSIDE the chat body,
	// and mounts a second body with the same `="chat"` value for an embedded conversation. A selector
	// that merely looks for the attribute therefore matches the seat — and the layer would read the
	// user's unsent draft as the transcript, which is worse than finding nothing: it has text, so
	// nothing complains, and every count downstream is about the wrong node.
	const seat = element({ tag: "DIV", attrs: { "data-composer-seat": "", "data-conversation-region": "composer" } });
	append(seat, textNode("a draft nobody sent"));
	const { layer } = makeLayer([{ text: "We adopted the WriteAheadLog for durability." }], 0, { seat });
	assertEqual(layer.hasRegion(), true, "the layer still finds a body");
	assert(layer.snapshot().text.includes("WriteAheadLog"), "and the body it reads is the transcript");
	assertEqual(layer.snapshot().text.includes("draft"), false, "never the composer seat's unsent text");
});

test("click: the body a click happened in is adopted even when the layer never found it", () => {
	// `querySelector` answers in document order, which is not "the body the user clicked in" once an
	// embedded conversation mounts a second one — and a click resolved against the wrong body is a
	// click that does nothing at all. The adoption is what makes the event's own target win, and it is
	// the click path's only way back from having found the wrong body (or none).
	const text = "Call WriteAheadLog before you commit.";
	const { layer, region, fire } = makeLayer([{ text }], text.indexOf("WriteAheadLog") + 3, {
		regionHiddenFromDoc: true,
		entries: [{ term: "WriteAheadLog", id: "w1" }]
	});
	assertEqual(layer.hasRegion(), false, "the fixture starts with the layer having found no body");

	fire("click", { button: 0, target: region.children[0], clientX: 30, clientY: 10, defaultPrevented: false });
	assertEqual(layer.hasRegion(), true, "the click adopts the body its target lives in");
	assertEqual(layer.stats().regionAdoptions, 1, "and records the adoption");
});

test("pointer: a press outside the plugin's own surfaces dismisses the explanation card", () => {
	// The card is a fixed-position element over the transcript with no other dismissal path.
	// While it stayed open, a pointer landing on it was refused by the very marker that
	// identifies it, and the area it covered stopped answering hovers — "the cursor changed and
	// then nothing showed". A press inside our own UI must still not dismiss it, or the card
	// would close before its own buttons could be used.
	const presses = [];
	const { fire } = makeLayer([{ text: "We adopted the WriteAheadLog." }], 0, { onPressOutside: () => presses.push("out") });
	fire("mousedown", { button: 0, target: element({ tag: "DIV" }) });
	assertEqual(presses.length, 1, "a press on anything that is not ours counts as leaving");
	fire("mousedown", { button: 0, target: element({ tag: "DIV", attrs: { "data-term-dictionary": "popup" } }) });
	assertEqual(presses.length, 1, "a press inside our own card does not");
	fire("mousedown", { button: 0, target: element({ tag: "BUTTON", attrs: { "data-term-dictionary": "affordance" } }) });
	assertEqual(presses.length, 1, "nor does a press on the selection affordance");
});

test("click: a collected term inside inline code is explained, not refused", () => {
	// THE bug behind "有下划线但悬停/点击都没反应": terms are collected and MARKED inside
	// inline code (their block is prose, so the block passes `isProseBlock`), while
	// SKIP_SELECTOR lists `code`, so the hit test refused every hit there. The marked words a
	// reader reaches for in a technical reply — `runInTransaction`, `elementFromPoint` — are
	// precisely the inline-code ones, so underlined words could not be hovered or clicked.
	const text = "Call runInTransaction before commit.";
	const caret = text.indexOf("runInTransaction") + 3;
	const block = element({ tag: "P", rect: { left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40 } });
	append(block, textNode("Call "));
	const code = element({ tag: "CODE" });
	append(block, code);
	const inner = append(code, textNode("runInTransaction before commit."));
	// The fixture's closest() is a stub, so the code container is modelled explicitly.
	code.closest = (selector) => (String(selector).includes("code") ? code : null);
	const region = element();
	append(region, block);
	const { layer } = makeLayer([], caret, { region, caretNode: inner, entries: [{ term: "runInTransaction", id: "e1" }] });
	const hit = layer.termAtPoint(30, 10);
	assert(hit !== null, "a collected term inside inline code must resolve");
	assertEqual(hit.term, "runInTransaction", "to the identifier");
	assertEqual(hit.known, true, "as a term the dictionary already holds");
});

test("click: an uncollected identifier inside inline code never offers to create", () => {
	// The other half: code stays out of the CREATE path. That is what keeps a wall of shell
	// output from turning into dictionary entries — the same rule as before, now applied to
	// the affordance instead of to the whole hit test.
	const text = "Call runInTransaction before commit.";
	const caret = text.indexOf("runInTransaction") + 3;
	const block = element({ tag: "P", rect: { left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40 } });
	append(block, textNode("Call "));
	const code = element({ tag: "CODE" });
	append(block, code);
	const inner = append(code, textNode("runInTransaction before commit."));
	code.closest = (selector) => (String(selector).includes("code") ? code : null);
	const region = element();
	append(region, block);
	const { layer } = makeLayer([], caret, { region, caretNode: inner });
	assertEqual(layer.termAtPoint(30, 10), null, "no create affordance inside code");
});

//#endregion

//#region hover hint





//#endregion

//#region click routing

test("click: the hit-stage tally names the stage a click resolved at", () => {
	// The tally is the only readout that says WHICH exit of the hit test refused a gesture —
	// pointer counters cannot ("the pointer was there and nothing happened"). Its original
	// check drove the hover path and went with it, so the counter would have lost its guard
	// while the click path kept using it.
	const text = "Call WriteAheadLog before you commit.";
	const { layer, region, fire } = makeLayer([{ text }], text.indexOf("WriteAheadLog") + 3, {
		entries: [{ term: "WriteAheadLog", id: "w1" }]
	});
	const before = { ...layer.stats().hitStages };
	fire("click", { button: 0, target: region.children[0], clientX: 30, clientY: 10, defaultPrevented: false });
	const after = layer.stats().hitStages;
	assertEqual(after.ok - before.ok, 1, "a click on a known term is counted as resolved");
	const refusals = Object.entries(after)
		.filter(([name]) => name !== "ok")
		.reduce((sum, [name, count]) => sum + (count - (before[name] ?? 0)), 0);
	assertEqual(refusals, 0, "and nothing is counted as refused for the same click");
});

test("click: a refusal is counted under the stage that produced it", () => {
	// The other half of the tally, and the half that is actually diagnostic: "the pointer was there and
	// nothing happened" becomes actionable only when the tally says WHICH exit said no. A refusal that
	// is not counted leaves the beacon's `trace` reading as a clean run, which is the report that
	// started this whole investigation.
	const text = "The meeting is at noon today.";
	const { layer, region, fire } = makeLayer([{ text }], 0);
	const before = { ...layer.stats().hitStages };
	fire("click", { button: 0, target: region.children[0], clientX: 30, clientY: 10, defaultPrevented: false });
	const after = layer.stats().hitStages;

	const spent = Object.entries(after)
		.filter(([name]) => name !== "ok")
		.map(([name, count]) => [name, count - (before[name] ?? 0)])
		.filter(([, delta]) => delta > 0);
	assertEqual(spent.length, 1, `a refused click is counted under exactly one stage, saw ${JSON.stringify(spent)}`);
	assertEqual(spent[0][1], 1, "and counted once");
	assertEqual(after.ok - (before.ok ?? 0), 0, "while the accept counter stays where it was");
});

test("click: a collected term activates its entry instead of explaining it", () => {
	const text = "We adopted event sourcing for the ledger.";
	const { log, region, fire } = makeLayer([{ text }], text.indexOf("event") + 2, {
		entries: [{ term: "event sourcing", id: "e1" }]
	});
	fire("click", { button: 0, target: region.children[0], clientX: 30, clientY: 10, defaultPrevented: false });
	assertEqual(log.activation.length, 1, "a collected term routes to activation");
	assertEqual(log.activation[0].hit.key, "event sourcing", "the activated term");
	assertEqual(log.explain.length, 0, "and must not also open the popup");
});

test("click: a term with no entry still opens the popup", () => {
	const text = "Call runInTransaction before you commit.";
	const { log, region, fire } = makeLayer([{ text }], text.indexOf("runInTransaction") + 3);
	fire("click", { button: 0, target: region.children[0], clientX: 30, clientY: 10, defaultPrevented: false });
	assertEqual(log.explain.length, 1, "an uncollected term offers to create the entry");
	assertEqual(log.explain[0].hit.term, "runInTransaction", "the clicked identifier");
	assertEqual(log.activation.length, 0, "nothing is activated");
});

test("click: a collected term and a glossary term carry different detector sources", () => {
	// This is the signal behind the routing: a dictionary hit has a row the panel can
	// reveal, a glossary hit has only the popup. The layer's own hit exposes the key,
	// and the shell resolves the entry from the store with it.
	const text = "We adopted event sourcing but the quorum decides.";
	const detector = makeDetector([{ term: "event sourcing", id: "e1" }]);
	const found = detector.scan(text, { includeCandidates: true });
	assertEqual(found.find((occurrence) => occurrence.key === "event sourcing").source, "dictionary", "a collected term reports the dictionary as its source");
	assertEqual(found.find((occurrence) => occurrence.key === "quorum").source, "glossary", "a built-in term stays a glossary hit");
	const { layer } = makeLayer([{ text }], text.indexOf("event") + 2, { entries: [{ term: "event sourcing", id: "e1" }] });
	assertEqual(layer.termAtPoint(30, 10).key, "event sourcing", "the hit carries the key the shell looks the entry up by");
});

//#endregion

//#region annotation

test("highlight: only a collected term is marked, and its range is exact", () => {
	const detector = makeDetector([{ term: "event sourcing", id: "e1" }]);
	const region = makeRegion([{ text: "We adopted event sourcing, and the quorum decides." }]);
	// The production path: the block objects `readRegion` hands the collector.
	const marked = rangesForBlock(readRegion(region).blocks[0], detector);
	assertEqual(marked.length, 1, `exactly the collected term is marked, got ${JSON.stringify(marked.map((segment) => segment.term))}`);
	assertEqual(marked[0].term, "event sourcing", "the collected term");
	assertEqual(marked[0].key, "event sourcing", "its key");
	assertEqual([marked[0].start, marked[0].end], [11, 25], "the range covers exactly the matched characters");
});

test("highlight: a term split across inline elements is marked in both", () => {
	const detector = makeDetector([{ term: "event sourcing", id: "e1" }]);
	const block = element();
	append(block, textNode("We adopted event "));
	const strong = element({ tag: "STRONG" });
	append(block, strong);
	const inner = append(strong, textNode("sourcing"));
	append(block, textNode(" for the ledger."));
	const marked = rangesForBlock(block, detector);
	assertEqual(marked.length, 2, "one range per text node the term covers");
	assertEqual(marked.map((segment) => segment.end - segment.start), [5, 8], "‘event’ in the first node, ‘sourcing’ in the second");
	// Identity, not assertEqual: the stand-in nodes are circular, so serializing them
	// to build a failure message would throw instead of reporting.
	assert(marked[1].node === inner, "the second range lives in the nested text node");
});

test("highlight: run offsets map back through collapsed whitespace", () => {
	const raw = "  quorum   decides  ";
	assertEqual(rawOffsetForBody(raw, 0), 2, "leading whitespace is skipped");
	assertEqual(rawOffsetForBody(raw, 6), 8, "the collapsed space is the run's own whitespace");
	assertEqual(rawOffsetForBody(raw, 14), 18, "the end stops before trailing whitespace");
	assertEqual(rawOffsetForBody(raw, 99), raw.length, "an offset past the body clamps to the node's end");
});

test("highlight: a runtime without the API marks nothing and does not throw", () => {
	// Node has no CSS.highlights or Highlight, which is exactly the older-runtime case.
	const region = makeRegion([{ text: "We adopted event sourcing." }]);
	const highlighter = createTermHighlighter({ document: { createRange: () => ({}) }, detector: makeDetector([{ term: "event sourcing", id: "e1" }]) });
	assertEqual(highlighter.supported, false, "the API must be probed, never assumed");
	assertEqual(highlighter.refresh(region), 0, "refresh is a no-op without the API");
	highlighter.clear();
});

test("highlight: the supported path paints the collected terms and clears", () => {
	const registry = new Map();
	const previousCss = globalThis.CSS;
	const previousHighlight = globalThis.Highlight;
	globalThis.CSS = {
		highlights: {
			set(name, value) {
				registry.set(name, value);
			},
			delete(name) {
				registry.delete(name);
			}
		}
	};
	globalThis.Highlight = class {
		constructor(...items) {
			this.items = items;
		}
	};
	try {
		const region = makeRegion([{ text: "We adopted event sourcing." }]);
		const documentStub = {
			createRange: () => ({
				start: null,
				end: null,
				setStart(node, at) {
					this.start = [node, at];
				},
				setEnd(node, at) {
					this.end = [node, at];
				}
			})
		};
		const highlighter = createTermHighlighter({ document: documentStub, detector: makeDetector([{ term: "event sourcing", id: "e1" }]) });
		assertEqual(highlighter.supported, true, "the injected API must be picked up");
		assertEqual(highlighter.refresh(region), 1, "one range for the one collected term");
		assert(registry.has(HIGHLIGHT_NAME), "the registry must hold the highlight");
		assertEqual(registry.get(HIGHLIGHT_NAME).items.length, 1, "one range in the highlight");
		assertEqual(highlighter.count(), 1, "the layer reports what it painted");
		highlighter.clear();
		assertEqual(registry.has(HIGHLIGHT_NAME), false, "clearing removes the registry entry");
	} finally {
		if (previousCss === undefined) delete globalThis.CSS;
		else globalThis.CSS = previousCss;
		if (previousHighlight === undefined) delete globalThis.Highlight;
		else globalThis.Highlight = previousHighlight;
	}
});

test("highlight: the rule names the registered highlight and uses theme tokens", () => {
	assert(HIGHLIGHT_CSS.includes(`::highlight(${HIGHLIGHT_NAME})`), "the rule must target the registered name");
	assert(HIGHLIGHT_CSS.includes("--dsw-alias-"), "colors must come from theme tokens");
});

//#endregion

//#region auto-collection

/**
 * Queue an awaited check. The synchronous runner cannot await, and an un-awaited
 * async check reports success without asserting anything — a mistake this suite has
 * already made once.
 * @param name - the check's name.
 * @param fn - the async body.
 */
function asyncTest(name, fn) {
	if (filter !== "" && !name.includes(filter)) return;
	asyncChecks.push({ name, fn });
}

/** Checks run after the synchronous ones. */
const asyncChecks = [];

// Declared below `asyncChecks` rather than beside the other pointer checks: `asyncTest` pushes
// into that array, and the `const` is in its temporal dead zone until this line runs.
asyncTest("locate: the poll keeps re-arming the settled pass without an observer", async () => {
	// The other half of the same finding. The observer is what normally re-schedules a pass when
	// the transcript changes, and it only exists with a scroll root — so a body mounted without
	// one had its text read exactly once, at attach, and a reply that streamed in afterwards was
	// never seen. A check on the pass armed by `bind` cannot tell the two drivers apart, so this
	// one waits for the poll to run on its own clock.
	const { log } = makeLayer([{ text: "We adopted the WriteAheadLog for durability." }], 0, { scroll: false });
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 100));
	assertEqual(log.settled.length, 1, "the pass armed at attach has run, once");
	// The window is the pass itself rather than the flag: a poll that armed a pass which then ran
	// would have cleared its own timer by the time a check on `settleScheduled` looked.
	await new Promise((resolve) => setTimeout(resolve, 2200));
	assertEqual(log.settled.length, 2, "the poll armed a second one, so a reply that arrives later is still read");
});

asyncTest("collect: a code block contributes no terms", async () => {
	// The regression guard for the dictionary filling with junk. `collect()` scanned every
	// block `readRegion` produced, and a transcript's code blocks and tool output are
	// blocks too — one session of shell commands collected `Invoke-WebRequest`,
	// `StatusCode`, `StartTime` and more, none of which anyone wanted a gloss for.
	const region = element();
	append(region, makeBlock("We adopted event sourcing for the ledger.", { left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40 }));
	const pre = element({ tag: "PRE" });
	append(region, pre);
	const code = element({ tag: "CODE" });
	append(pre, code);
	append(code, textNode("Get-Process | Select-Object FullName, StartTime"));
	// The fixture's `closest` is a stub that always reports null, so the code container is
	// modelled explicitly — the same technique the click test uses for a skipped container.
	const nearest = (selector) => (String(selector).includes("code") ? code : null);
	pre.closest = nearest;
	code.closest = nearest;
	const { layer, log } = makeLayer([], 0, { region });
	const created = await layer.scanNow();
	assertEqual(created, 0, "identifiers inside a code block must not become entries");
	assertEqual(log.sightings.length, 0, "and no sighting is recorded for them");
});

asyncTest("collect: prose that merely contains inline code is still collected", async () => {
	// The other half of the rule: the gate is "is this block code", not "does this block
	// mention code". A technical reply routinely carries an inline code span, and it must
	// keep working.
	const region = element();
	const paragraph = element({ tag: "P" });
	append(region, paragraph);
	append(paragraph, textNode("Call "));
	const inline = element({ tag: "CODE" });
	append(paragraph, inline);
	append(inline, textNode("runInTransaction"));
	append(paragraph, textNode(" before the WriteAheadLog flushes."));
	const { layer } = makeLayer([], 0, { region });
	const created = await layer.scanNow();
	assert(created > 0, `a prose block with an inline code span must still collect, got ${created}`);
});

asyncTest("selection: the context is one sentence, never the whole transcript", async () => {
	// The regression guard for the editor flooding itself with the session.
	//
	// The selection path used `readBlock(regionFor(node))`, and `regionFor` returns the
	// region's DIRECT CHILD — with the real DOM shape that is the scroll container that
	// holds every message. The context was therefore the entire conversation, including
	// tool-chip labels, and the editor renders its context directly under the title: the
	// panel filled with the whole session and the fields and Save button went off-screen.
	const messages = [];
	for (let index = 0; index < 40; index++) messages.push({ text: `Filler message ${index} about unrelated plumbing and other words.` });
	messages.push({ text: "We adopted the WriteAheadLog for durability." });
	/** The window's selection, filled in once the region exists. */
	let live = null;
	const { region, log, fire } = makeLayer(messages, 0, { wrap: true, selection: () => live });
	const scroll = region.children[0];
	const last = scroll.children[scroll.children.length - 1];
	const node = textNodeOf(last);
	const at = last.textContent.indexOf("WriteAheadLog");
	live = {
		isCollapsed: false,
		rangeCount: 1,
		toString: () => "WriteAheadLog",
		getRangeAt: () => ({
			commonAncestorContainer: node,
			startContainer: node,
			endContainer: node,
			startOffset: at,
			getBoundingClientRect: () => last.rect
		})
	};
	fire("selectionchange", {});
	// The layer debounces a settled selection before it reports one.
	await new Promise((resolve) => setTimeout(resolve, 300));
	const reported = log.selection.filter((entry) => entry !== null).pop();
	assert(reported !== undefined, "the selection must be reported");
	assertEqual(reported.text, "WriteAheadLog", "the selected phrase");
	assert(reported.context.includes("WriteAheadLog"), "the context must contain the selection");
	assert(reported.context.length <= 240, `the context must stay bounded, got ${reported.context.length} characters`);
	assert(!reported.context.includes("Filler message 0"), "the context must not be the whole transcript");
});

asyncTest("collect: the auto-collect switch stops collection without costing the message", async () => {
	// The switch ("加上功能开关") has to be honest in both directions: off means nothing is
	// collected AND the message is not marked as read, so turning it back on still sees it.
	const { layer, log } = makeLayer([{ text: "Call runInTransaction before the WriteAheadLog flushes." }]);
	layer.setAutoCollect(false);
	assertEqual(await layer.scanNow(), 0, "nothing is collected while the switch is off");
	assertEqual(log.sightings.length, 0, "and no sighting is recorded");
	layer.setAutoCollect(true);
	assert((await layer.scanNow()) > 0, "turning it back on still sees the message");
});

asyncTest("collect: the per-minute budget bounds a run of messages, and then refills", async () => {
	// The per-message cap bounds a burst but not a session: one new term per reply adds up
	// forever, which is what "收录过程太频繁" describes. The budget is the session bound —
	// and it must EXPIRE, because a budget that never refills would silently end automatic
	// collection for the rest of the session.
	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	try {
		const blocks = [];
		// Each message carries one fresh camelCase identifier, which is the shape the
		// collector accepts on its own (`Widget0Gamma` would not: no case transition).
		for (let index = 0; index < 20; index++) blocks.push({ text: `Note ${index} covers widgetGamma${index} details.` });
		const { layer, region } = makeLayer(blocks);
		const first = await layer.scanNow();
		assertEqual(first, MAX_AUTO_PER_MINUTE, "one pass may not exceed the budget");
		assertEqual(layer.remainingBudget(), 0, "and the budget is then spent");
		// A message that arrives after the window has passed must collect again.
		clock += 61_000;
		append(region, makeBlock("Another mention of snapshotDelta here.", { left: 0, top: 9000, right: 400, bottom: 9020, width: 400, height: 20 }));
		const second = await layer.scanNow();
		assert(second > 0, "collection must resume once the window has passed");
		assertEqual(layer.remainingBudget() > 0, true, "and the budget must have room again");
	} finally {
		Date.now = realNow;
	}
});

asyncTest("collect: the created terms are reported so they can be explained", async () => {
	// The shell owns the model API; the layer only collects. Reporting what was created is
	// what lets automatic collection produce explanations instead of bare "待补充" rows.
	const { layer, log } = makeLayer([{ text: "Call runInTransaction before the WriteAheadLog flushes." }]);
	await layer.scanNow();
	assert(log.collected.length > 0, "the shell must be told what was collected");
	assert(log.collected.every((item) => typeof item.term === "string" && item.term !== ""), "each item names its term");
	assert(log.collected.every((item) => typeof item.context === "string" && item.context.length <= 240), "and carries a bounded context");
});

asyncTest("collect: a settled message creates entries for its unknown terminology", async () => {
	const { layer, log } = makeLayer([{ text: "Call runInTransaction before the WriteAheadLog flushes." }]);
	const created = await layer.scanNow();
	assert(created > 0, `at least one entry must be created, got ${created}`);
	assert(log.toast.length > 0, "the user must be told something was collected");
	assert(log.sightings.length > 0, "a sighting must be recorded");
});

asyncTest("collect: re-scanning the same message creates nothing new", async () => {
	const { layer } = makeLayer([{ text: "Call runInTransaction before commit." }]);
	const first = await layer.scanNow();
	const second = await layer.scanNow();
	assert(first > 0, `the first pass must collect, got ${first}`);
	assertEqual(second, 0, "the second pass must recognize the message and stop");
});

asyncTest("collect: a message of known terms adds no new entry", async () => {
	const { layer } = makeLayer([{ text: "The idempotent handler uses a quorum." }]);
	assertEqual(await layer.scanNow(), 0, "terms the glossary already explains are not new entries");
});

asyncTest("collect: ordinary prose creates nothing", async () => {
	const { layer } = makeLayer([{ text: "The user said the file is in the folder and the value is small." }]);
	assertEqual(await layer.scanNow(), 0, "no entry for everyday words");
});

asyncTest("collect: a refused sighting reports nothing collected", async () => {
	// A deleted term still on screen must not be announced as collected. The store
	// refuses the sighting, and the notice follows the store's answer rather than the
	// collection loop's own guess.
	const { layer, log } = makeLayer([{ text: "Call runInTransaction before commit." }]);
	layer.setSightingAnswer({ created: false, deleted: true });
	const created = await layer.scanNow();
	assertEqual(created, 0, "a refused sighting creates nothing");
	assertEqual(log.toast.length, 0, "and no notice claims otherwise");
});

//#endregion

for (const check of asyncChecks) {
	try {
		await check.fn();
		passed++;
		console.log(`  ok   ${check.name}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL ${check.name}\n       ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Released last, because the awaited checks above build layers of their own; a
// layer left attached keeps its polling interval alive and the process never exits.
for (const layer of layers) layer.detach();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
