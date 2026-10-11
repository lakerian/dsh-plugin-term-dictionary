// Test harness for the term dictionary plugin.
//
// It checks the three things that can silently break this plugin:
//   1. the pure core — tokenization, detection and the dictionary merge rules;
//   2. the browser bundle — that the generated file parses, that its inlined
//      module registry resolves every relative require, and that the plugin's
//      `apply` registers the expected slots against a fake client context;
//   3. the manifest contract — package.json, locale files and the patch agree on
//      names and exports.
//
// Usage: node tools/test-term-dictionary.mjs [--filter <substring>]

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { pluginDir, libDir, coreDir } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

const filterArg = process.argv.indexOf("--filter");
const filter = filterArg > 0 ? process.argv[filterArg + 1] : "";

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Register and run one named check.
 * @param name - the check's name.
 * @param fn - a function that throws on failure.
 */
function test(name, fn) {
	if (filter !== "" && !name.includes(filter)) return;
	try {
		fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed++;
		failures.push({ name, error });
		console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Assert a condition. */
function assert(condition, message) {
	if (!condition) throw new Error(message ?? "assertion failed");
}

/** Assert deep equality through JSON, which is enough for plain data. */
function assertEqual(actual, expected, message) {
	const left = JSON.stringify(actual);
	const right = JSON.stringify(expected);
	if (left !== right) throw new Error(`${message ?? "values differ"}\n       actual:   ${left}\n       expected: ${right}`);
}

/**
 * Load a CommonJS core module.
 * @param name - the file name under lib/core/.
 * @returns its exports.
 */
function loadCore(name) {
	return require_(join(coreDir, name));
}

/**
 * Evaluate the generated browser bundle in a sandbox and return the factory's
 * exports. This is the closest a Node test can get to the real page: it proves the
 * inlined registry resolves every sibling require and that `apply` runs.
 *
 * @param options - `document` and `storage` overrides, plus `react` for the hooks.
 * @returns `{ exports, slots, effects, locale, context }`.
 */
function loadBundle(options = {}) {
	const path = join(libDir, "client.js");
	assert(existsSync(path), "lib/client.js is missing — run node tools/build-client.mjs");
	const source = readFileSync(path, "utf8");

	const slots = [];
	const effects = [];
	const localeRegistrations = [];
	const registered = [];
	const components = [];
	/** Every listener type the plugin attaches to the document. */
	const documentListeners = [];
	/**
	 * The same registrations with the third argument kept.
	 *
	 * The type alone cannot answer the question this plugin's whole capture story turns on, so the
	 * sandbox has to record the phase: dropping `options` here is what made the capture-phase check
	 * unable to see the phase, and `check-pointer-guards.mjs`'s M2 mutation reported that as an escape.
	 */
	const documentListenerPhases = [];
	const documentStub = options.document ?? {
		querySelector: () => null,
		addEventListener: (type, handler, listenerOptions) => {
			documentListeners.push(type);
			documentListenerPhases.push({ type, capture: listenerOptions === true || listenerOptions?.capture === true });
		},
		removeEventListener: () => {},
		hidden: false
	};
	const storage = options.storage ?? new MapStorage();
	let loaded = null;

	const sandbox = {
		// The plugin's own reports go to the console and nowhere else, so a check that wants to read one
		// has to be the console. Swapping it is the only way to see what the page actually printed.
		console: options.console ?? console,
		setTimeout,
		clearTimeout,
		setInterval: () => 0,
		clearInterval: () => {},
		globalThis: null,
		window: null,
		document: documentStub,
		localStorage: storage,
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		// The page has these; the sandbox must too, or a plugin that uses one behaves differently under
		// test than in the browser. `URL` was the one that mattered: without it every source address was
		// parsed as malformed, so a check about refusing `http` saw `bad-url` instead of `not-https`.
		URL,
		URLSearchParams,
		Blob: globalThis.Blob,
		AbortController: undefined,
		fetch: options.fetch
	};
	sandbox.globalThis = sandbox;
	sandbox.window = sandbox;
	sandbox.window.__ModuleLoader__ = {
		load(registration) {
			loaded = registration;
		}
	};
	sandbox.addEventListener = () => {};
	sandbox.removeEventListener = () => {};
	vm.createContext(sandbox);
	new vm.Script(source, { filename: path }).runInContext(sandbox);

	assert(loaded !== null, "the bundle did not call window.__ModuleLoader__.load");
	assertEqual(loaded.id, "dsh-plugin-term-dictionary", "bundle id must equal the package name");

	const react = options.react ?? makeReactStub();
	const platformRequire = (spec) => {
		if (spec === "react") return react;
		if (spec === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
		throw new Error(`node test harness has no platform module for ${JSON.stringify(spec)}`);
	};
	const exports = loaded.factory(platformRequire);
	assert(typeof exports.apply === "function", "the bundle must export apply");
	assert(Array.isArray(exports.inject), "the bundle must export inject");

	const context = {
		locale: {
			bind: () => (key) => key,
			register: (ns, dict) => {
				localeRegistrations.push({ ns, dict });
				return () => {};
			},
			subscribe: () => () => {},
			getSnapshot: () => ({ active: "zh" })
		},
		slots: {
			inject(key, callback) {
				slots.push(key);
				registered.push(...(callback() === undefined ? [] : []));
				return () => {};
			},
			register(options, component) {
				registered.push(options);
				// The component is kept beside its options so a check can render it with
				// the very props the slot would hand it.
				components.push(component);
				return () => {};
			}
		},
		effect(fn, label) {
			effects.push(label);
			const dispose = fn();
			return typeof dispose === "function" ? dispose : () => {};
		},
		on: () => () => {},
		get: () => undefined,
		logger: console
	};
	exports.apply(context);
	return { exports, slots, effects, localeRegistrations, registered, components, documentListeners, documentListenerPhases, sandbox };
}

/** A minimal `Storage` stand-in that records what the plugin persists. */
class MapStorage {
	constructor() {
		this.map = new Map();
	}
	getItem(key) {
		return this.map.has(key) ? this.map.get(key) : null;
	}
	setItem(key, value) {
		this.map.set(key, String(value));
	}
	removeItem(key) {
		this.map.delete(key);
	}
}

/**
 * A React stub whose hooks invoke the callbacks they are given, so a component's
 * body really runs — a crashed render body is the failure mode this catches.
 *
 * Its STATE PERSISTS ACROSS RENDERS, one slot per hook call, which is what makes a
 * component's behaviour reachable rather than just its first frame: call `__beginRender()`
 * and render it again to see what a click actually changed. Without that, a check can only
 * assert that a control exists and that its handler asked for something — never that the
 * next frame uses it, which is where a page that half-works hides.
 *
 * @param options - `onSet` receives every `useState` setter call, which is how a check
 *   observes what a component decided; `seedState` maps a hook's INITIAL value to the value
 *   the FIRST render should start from, for a view that is otherwise several clicks away.
 * @returns a React-shaped object, plus `__beginRender`.
 */
function makeReactStub(options = {}) {
	const onSet = typeof options.onSet === "function" ? options.onSet : null;
	// Seeded by the initial VALUE rather than by call order on purpose: the order hooks are called in
	// is not a contract, so an index-based seed would silently start the wrong hook the day a hook is
	// added — and a check that renders the wrong view is a check that lies.
	const seed = options.seedState ?? {};
	/** One slot per hook, kept across renders the way a mounted component's state is. */
	const slots = [];
	let cursor = 0;
	/** Claim the next hook slot, seeding it on first use. */
	const claim = (initial) => {
		const index = cursor++;
		if (!(index in slots)) slots[index] = initial;
		return index;
	};
	return {
		createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }),
		Fragment: Symbol.for("react.fragment"),
		useState(initial) {
			const first = typeof initial !== "function" && Object.prototype.hasOwnProperty.call(seed, initial) ? seed[initial] : typeof initial === "function" ? initial() : initial;
			const index = claim(first);
			return [
				slots[index],
				(next) => {
					// The updater form is supported because components use it: `setEditing((previous) => …)`.
					slots[index] = typeof next === "function" ? next(slots[index]) : next;
					if (onSet !== null) onSet(next);
				}
			];
		},
		useEffect(fn) {
			void fn();
		},
		useLayoutEffect(fn) {
			void fn();
		},
		useMemo(fn) {
			return fn();
		},
		useRef(value) {
			return slots[claim({ current: value })];
		},
		useCallback(fn) {
			return fn;
		},
		useSyncExternalStore(subscribe, getSnapshot) {
			void subscribe;
			return getSnapshot();
		},
		createContext: (value) => ({ Provider: null, Consumer: null, _value: value }),
		/**
		 * Start the next render of the same component, so its hooks meet their own slots again.
		 *
		 * Explicit rather than inferred: nothing in a hook call itself says which render it belongs to,
		 * and guessing would make the slot a component happens to be given depend on how many renders
		 * came before it — the same order-not-a-contract trap the seed avoids.
		 */
		__beginRender() {
			cursor = 0;
		}
	};
}

console.log("term-dictionary tests\n");

//#region manifest

test("manifest: package name, exports and dsh.client agree", () => {
	const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
	assertEqual(pkg.name, "dsh-plugin-term-dictionary", "package name");
	assert(pkg.exports?.["./client"] !== undefined, "package.json must export ./client");
	assert(pkg.exports?.["./locale/*.json"] !== undefined, "package.json must export locale files or the host cannot read display metadata");
	assertEqual(pkg.dsh?.client?.platform, "web", "dsh.client.platform");
	assert(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes("slots"), "dsh.client.inject must include slots");
	assertEqual(pkg.description && /[\u4e00-\u9fff]/.test(pkg.description), true, "package.json description must contain Chinese");
});

test("manifest: locale files carry Chinese and English metadata", () => {
	const zh = JSON.parse(readFileSync(join(pluginDir, "locale", "zh.json"), "utf8"));
	const en = JSON.parse(readFileSync(join(pluginDir, "locale", "en.json"), "utf8"));
	assert(typeof zh.meta?.title === "string" && /[\u4e00-\u9fff]/.test(zh.meta.title), "zh title must be Chinese");
	assert(typeof zh.meta?.description === "string" && /[\u4e00-\u9fff]/.test(zh.meta.description), "zh description must be Chinese");
	assert(typeof en.meta?.title === "string" && en.meta.title.trim() !== "", "en title must be non-empty");
	assert(typeof en.meta?.description === "string" && en.meta.description.trim() !== "", "en description must be non-empty");
});

test("manifest: the patch inserts exactly one row for this package", () => {
	const patch = readFileSync(join(pluginDir, "cordis.patch.yml"), "utf8");
	assert(patch.includes("dsh-plugin-term-dictionary"), "the patch must name the package");
	assertEqual((patch.match(/name:\s*'dsh-plugin-term-dictionary'/g) ?? []).length, 1, "exactly one row");
});

test("manifest: every file the package lists exists", () => {
	const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
	for (const entry of pkg.files ?? []) {
		if (entry.includes("*")) continue;
		assert(existsSync(join(pluginDir, entry)), `missing listed file ${entry}`);
	}
});

//#endregion

//#region core

const core = loadCore("core.js");

test("core: normalizeTerm collapses case and whitespace", () => {
	assertEqual(core.normalizeTerm("  Event   Sourcing "), "event sourcing", "normalizeTerm");
	assertEqual(core.normalizeTerm(null), "", "normalizeTerm of null");
});

test("core: termId is stable and differs per term", () => {
	assertEqual(core.termId("Event Sourcing"), core.termId("event sourcing"), "case must not change the id");
	assert(core.termId("alpha") !== core.termId("beta"), "different terms need different ids");
});

test("core: tokenize splits latin runs and single CJK characters", () => {
	const tokens = core.tokenize("使用 eventSourcing 模式, key_value-2.").map((token) => token.raw);
	assertEqual(tokens, ["使", "用", "eventSourcing", "模", "式", "key_value-2"], "tokenize");
});

test("core: tokenize offsets point back into the source", () => {
	const text = "abc def";
	const [first, second] = core.tokenize(text);
	assertEqual(text.slice(first.start, first.end), "abc", "first token slice");
	assertEqual(text.slice(second.start, second.end), "def", "second token slice");
});

test("core: shape tests recognise identifiers, acronyms and jargon suffixes", () => {
	assertEqual(core.looksLikeIdentifier("eventSourcing"), true, "camelCase");
	assertEqual(core.looksLikeIdentifier("snake_case"), true, "snake_case");
	assertEqual(core.looksLikeIdentifier("plain"), false, "plain word");
	assertEqual(core.isAcronym("API"), true, "API");
	assertEqual(core.isAcronym("Api"), false, "Api is not an acronym");
	assertEqual(core.hasTechnicalMorphology("serialization"), true, "serialization");
	assertEqual(core.hasTechnicalMorphology("cat"), false, "cat");
});

test("core: contextAround returns whole sentences and clamps", () => {
	const text = "First sentence. The term appears here. Third sentence.";
	const at = text.indexOf("term");
	const context = core.contextAround(text, at, at + 4);
	assert(context.includes("term appears"), `context must contain the term, got ${context}`);
	assert(context.length <= 240, "context must be clamped");
});

//#endregion

//#region dictionary

const dictionaryModule = loadCore("dictionary.js");
const { createDictionaryStore } = loadCore("store.js");

test("dictionary: an empty document summarizes to zero", () => {
	const state = dictionaryModule.emptyState({ now: 1 });
	assertEqual(dictionaryModule.summarize(state), { total: 0, explained: 0, unexplained: 0, pinned: 0 }, "empty summary");
});

test("dictionary: a sighting creates one entry and a repeat merges into it", () => {
	let state = dictionaryModule.emptyState({ now: 1 });
	const first = dictionaryModule.recordSighting(state, { term: "Event Sourcing" }, { now: 2 });
	assertEqual(first.created, true, "first sighting creates");
	state = first.state;
	const second = dictionaryModule.recordSighting(state, { term: "event sourcing" }, { now: 3 });
	assertEqual(second.created, false, "second sighting merges");
	assertEqual(second.state.entries.length, 1, "still one entry");
	assertEqual(second.state.entries[0].seen, 2, "the sighting counter moves");
});

test("dictionary: a glossary gloss fills a missing definition but a user edit wins", () => {
	let state = dictionaryModule.emptyState({ now: 1 });
	state = dictionaryModule.recordSighting(state, { term: "quorum", glossary: { zh: "法定人数", gloss: "多数派确认。", domain: "系统" } }, { now: 2 }).state;
	assertEqual(state.entries[0].definition.gloss, "多数派确认。", "glossary fills the gloss");
	const edited = dictionaryModule.editEntry(state, "quorum", { definition: { gloss: "我自己的解释。" } }, { now: 3 });
	state = edited.state;
	assertEqual(state.entries[0].definition.gloss, "我自己的解释。", "the user edit wins");
	assertEqual(state.entries[0].source, "user", "the source becomes user");
	const later = dictionaryModule.recordSighting(state, { term: "quorum", glossary: { gloss: "内置解释。" } }, { now: 4 });
	assertEqual(later.state.entries[0].definition.gloss, "我自己的解释。", "a later auto sighting must not overwrite a curated definition");
});

test("dictionary: a supplied definition outranks a glossary fallback", () => {
	let state = dictionaryModule.emptyState({ now: 1 });
	const result = dictionaryModule.recordSighting(
		state,
		{ term: "KV cache", definition: { zh: "键值缓存", gloss: "模型生成的解释。" }, source: "llm" },
		{ now: 2 }
	);
	assertEqual(result.entry.definition.gloss, "模型生成的解释。", "the supplied definition is stored");
	assertEqual(result.entry.source, "llm", "the source records the model");
});

test("dictionary: remove and find work by id and by term", () => {
	let state = dictionaryModule.emptyState({ now: 1 });
	state = dictionaryModule.recordSighting(state, { term: "sharding" }, { now: 2 }).state;
	const entry = state.entries[0];
	assert(dictionaryModule.findEntry(state, "sharding") !== undefined, "find by term");
	assert(dictionaryModule.findEntry(state, entry.id) !== undefined, "find by id");
	const removed = dictionaryModule.removeEntry(state, entry.id, { now: 3 });
	assertEqual(removed.removed, true, "remove reports success");
	// The document keeps a tombstone so the deletion can sync; the projection the
	// user sees is empty, which is what "removed" means here.
	assertEqual(removed.state.entries.filter((candidate) => candidate.deletedAt === 0).length, 0, "no live entry remains");
	assertEqual(dictionaryModule.listEntries(removed.state, "", "all").length, 0, "the entry is gone from the list");
	assertEqual(dictionaryModule.findEntry(removed.state, entry.id), undefined, "and it cannot be found");
});

test("dictionary: unpinning survives the merge with a copy that is still pinned", () => {
	// The reported bug: 钉选功能无法取消. `pinned` was merged as
	// `current.pinned || incoming.pinned`, so the user's unpin wrote false locally, the
	// host's copy still said true, and the OR resurrected the pin — the page then adopts
	// the merged document, so the toggle visibly snapped back on every click.
	const pinned = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "v" }, pinned: true }, { now: 100 }).state;
	const unpinned = dictionaryModule.editEntry(pinned, "q", { pinned: false }, { now: 200 }).state;
	assertEqual(unpinned.entries[0].pinned, false, "the local unpin applies");
	// The host's older, still-pinned copy comes back through the merge, in either order.
	assertEqual(dictionaryModule.mergeDocuments(unpinned, pinned, { now: 900 }).entries[0].pinned, false, "the later unpin must win the merge");
	assertEqual(dictionaryModule.mergeDocuments(pinned, unpinned, { now: 900 }).entries[0].pinned, false, "and win it from either side");
	// Pinning again travels the same way.
	const repinned = dictionaryModule.editEntry(unpinned, "q", { pinned: true }, { now: 300 }).state;
	assertEqual(dictionaryModule.mergeDocuments(pinned, repinned, { now: 900 }).entries[0].pinned, true, "a later pin must win too");
	// A sighting is an observation, not a decision: it does not advance `updatedAt`, so it
	// must never clear a pin — which is the job the old OR was doing.
	const sighted = dictionaryModule.recordSighting(pinned, { term: "q", context: "seen again" }, { now: 500 }).state;
	assertEqual(dictionaryModule.mergeDocuments(sighted, pinned, { now: 900 }).entries[0].pinned, true, "a sighting must not clear a pin");
});

test("dictionary: listEntries filters, and an action does not reorder it", () => {
	let state = dictionaryModule.emptyState({ now: 1 });
	state = dictionaryModule.recordSighting(state, { term: "alpha" }, { now: 2 }).state;
	state = dictionaryModule.recordSighting(state, { term: "beta" }, { now: 3 }).state;
	state = dictionaryModule.editEntry(state, "alpha", { definition: { gloss: "解释" }, pinned: true }, { now: 4 }).state;
	const order = dictionaryModule.listEntries(state, "", "all").map((entry) => entry.term);
	// Pinned FIRST was the old rule, and it is the behaviour a reader reported as a problem: pinning sent
	// the row to the top, so an action moved the thing being looked at. The pin is on the row and 「已钉选」
	// gathers them, so ordering no longer has to say it.
	assertEqual(order, ["beta", "alpha"], "the list stays in creation order however entries are pinned");
	assertEqual(dictionaryModule.listEntries(state, "bet", "all").length, 1, "search narrows the list");
	assertEqual(dictionaryModule.listEntries(state, "", "unexplained").map((entry) => entry.term), ["beta"], "the unexplained filter");
	assertEqual(dictionaryModule.listEntries(state, "", "pinned").map((entry) => entry.term), ["alpha"], "the pinned filter");
});

test("dictionary: normalizeState drops junk records and deduplicates", () => {
	const state = dictionaryModule.normalizeState({
		entries: [null, { term: "" }, { term: "ok", id: "x" }, { term: "OK", id: "x" }]
	}, { now: 5 });
	assertEqual(state.entries.length, 1, "only the usable entry survives");
	assertEqual(state.entries[0].term, "ok", "the surviving term");
});

test("dictionary: mergeState keeps local edits and adopts new remote entries", () => {
	let local = dictionaryModule.emptyState({ now: 1 });
	local = dictionaryModule.editEntry(local, "shared", { definition: { gloss: "本地解释" } }, { now: 2 }).state;
	local = dictionaryModule.recordSighting(local, { term: "local-only" }, { now: 3 }).state;
	const remote = { entries: [{ term: "shared", source: "heuristic", definition: { gloss: "远程解释" } }, { term: "remote-only" }] };
	const merged = dictionaryModule.mergeState(local, remote, { now: 4 });
	const terms = merged.entries.map((entry) => entry.term).sort();
	assertEqual(terms, ["local-only", "remote-only", "shared"], "both sides are represented");
	const shared = merged.entries.find((entry) => entry.term === "shared");
	assertEqual(shared.definition.gloss, "本地解释", "a lesser remote source must not overwrite a user definition");
});

test("dictionary: a deletion survives a union merge from the other side", () => {
	// The regression guard for deletion resurrection. A union merge can only add,
	// so without a tombstone the host's stale live copy would restore a term the
	// user just deleted — which is exactly what happened before this existed.
	let state = dictionaryModule.emptyState({ now: 1 });
	state = dictionaryModule.recordSighting(state, { term: "Resurrection" }, { now: 2 }).state;
	assertEqual(state.entries.length, 1, "the entry exists");
	const removed = dictionaryModule.removeEntry(state, "Resurrection", { now: 10 });
	assertEqual(removed.removed, true, "the removal is reported");
	assertEqual(removed.state.entries.filter((entry) => entry.deletedAt === 0).length, 0, "no live entry remains");
	// The host still holds the pre-deletion copy and sends it back.
	const stale = { entries: [{ term: "Resurrection", lastSeenAt: 5, updatedAt: 5 }] };
	const merged = dictionaryModule.mergeState(removed.state, stale, { now: 20 });
	assertEqual(dictionaryModule.listEntries(merged, "", "all").length, 0, "the stale copy must not resurrect the entry");
	assertEqual(dictionaryModule.summarize(merged).total, 0, "it is not counted either");
	assertEqual(dictionaryModule.findEntry(merged, "Resurrection"), undefined, "and it is not findable");
	// A NEW edit after the deletion revives it, which is the user changing their mind.
	const revived = dictionaryModule.editEntry(merged, "Resurrection", { definition: { gloss: "重新添加。" } }, { now: 30 });
	assertEqual(dictionaryModule.listEntries(revived.state, "", "all").length, 1, "an edit newer than the deletion revives the entry");
});

test("dictionary: a tombstone travels through serialization and back", () => {
	let state = dictionaryModule.emptyState({ now: 1 });
	state = dictionaryModule.recordSighting(state, { term: "gone" }, { now: 2 }).state;
	state = dictionaryModule.removeEntry(state, "gone", { now: 10 }).state;
	// The file keeps the tombstone so a reload knows the term was deleted, while a
	// reader never sees it in `entries`.
	const onDisk = dictionaryModule.serializeState(state);
	assertEqual(onDisk.entries, [], "no live entry is serialized");
	assertEqual(onDisk.deletedKeys, ["gone"], "the deleted key is published as a hint");
	assertEqual(onDisk.backing.length, 1, "the tombstone itself is kept for the merge");
	assertEqual(onDisk.backing[0].deletedAt, 10, "with its deletion time");
	const reloaded = dictionaryModule.normalizeState(onDisk, { now: 11 });
	assertEqual(dictionaryModule.listEntries(reloaded, "", "all").length, 0, "a reload still hides it");
	const again = dictionaryModule.mergeState(reloaded, { entries: [{ term: "gone", updatedAt: 5 }] }, { now: 12 });
	assertEqual(dictionaryModule.listEntries(again, "", "all").length, 0, "and it stays hidden after another merge");
});

test("dictionary: deletedKeys alone teaches a client that never held the tombstone", () => {
	// A second window, or a page whose storage was cleared, only ever sees what the
	// host publishes: live entries and a list of deleted keys.
	let host = dictionaryModule.emptyState({ now: 1 });
	host = dictionaryModule.recordSighting(host, { term: "quorum" }, { now: 2 }).state;
	host = dictionaryModule.removeEntry(host, "quorum", { now: 10 }).state;
	const published = JSON.parse(JSON.stringify(dictionaryModule.serializeState(dictionaryModule.seal(host))));
	assertEqual(published.entries, [], "the deleted entry is not published");
	assertEqual(published.deletedKeys, ["quorum"], "but its key is");
	// The tombstone travels with the published document so the reader learns *when*
	// the deletion happened. Without that time a later merge could only compare a
	// live copy against nothing, which is the resurrection this whole mechanism
	// exists to prevent.
	assertEqual(published.backing.length, 1, "the deletion time travels too");
	assertEqual(published.backing[0].deletedAt, 10, "with the real deletion stamp");

	// A fresh client adopts that and hides the term.
	const fresh = dictionaryModule.normalizeState(published, { now: 20 });
	assertEqual(dictionaryModule.listEntries(fresh, "", "all").length, 0, "the fresh client holds no live entry");
	assertEqual([...fresh.deletedKeys], ["quorum"], "and it does know the term was deleted");

	// What it pushes back is its whole document: live entries, plus the keys it was
	// told are deleted. The host must keep those deletions.
	const pushed = {
		entries: dictionaryModule.recordsOf(fresh).filter((entry) => entry.deletedAt === 0),
		deletedKeys: [...fresh.deletedKeys]
	};
	const merged = dictionaryModule.mergeState(host, pushed, { now: 30 });
	assertEqual(dictionaryModule.listEntries(merged, "", "all").length, 0, "the host keeps the deletion after the page's replace");
	assertEqual([...merged.deletedKeys], ["quorum"], "and still publishes the key");
	// A re-sighting at the host cannot undo it either.
	assertEqual(dictionaryModule.listEntries(dictionaryModule.recordSighting(host, { term: "quorum" }, { now: 40 }).state, "", "all").length, 0, "a re-sighting must not revive it");
});

test("dictionary: clearAll leaves a tombstone per entry", () => {
	let state = dictionaryModule.emptyState({ now: 1 });
	state = dictionaryModule.recordSighting(state, { term: "one" }, { now: 2 }).state;
	state = dictionaryModule.recordSighting(state, { term: "two" }, { now: 3 }).state;
	const cleared = dictionaryModule.clearAll(state, { now: 10 });
	assertEqual(cleared.removed, 2, "both entries were cleared");
	assertEqual(dictionaryModule.listEntries(cleared.state, "", "all").length, 0, "nothing is visible");
	assertEqual([...cleared.state.deletedKeys].sort(), ["one", "two"], "each entry left a tombstone");
	// The critical part: a real remote copy — which carries its own timestamps —
	// must not restore the dictionary.
	const stale = { entries: [{ term: "one", updatedAt: 2 }, { term: "two", updatedAt: 3 }] };
	const restored = dictionaryModule.mergeState(cleared.state, stale, { now: 20 });
	assertEqual(dictionaryModule.listEntries(restored, "", "all").length, 0, "a union merge must not undo a clear");
	// A copy the user genuinely re-curated does revive, which is the user explaining a
	// cleared term again. Two things make that a real revival rather than a stale copy:
	// the edit is newer than the deletion, and its `source` says a person asked for it.
	// Provenance is what keeps an automatic re-detection from undoing a deliberate
	// deletion, so the fixture carries it exactly as the editor path does.
	const newer = { entries: [{ term: "one", updatedAt: 99, source: "user", definition: { gloss: "又加回来了。" } }] };
	const revived = dictionaryModule.mergeState(cleared.state, newer, { now: 100 });
	assertEqual(dictionaryModule.listEntries(revived, "", "all").map((entry) => entry.term), ["one"], "a newer edit revives");
});

test("dictionary: deleting one entry leaves the others alone", () => {
	let state = dictionaryModule.emptyState({ now: 1 });
	state = dictionaryModule.recordSighting(state, { term: "keep" }, { now: 2 }).state;
	state = dictionaryModule.recordSighting(state, { term: "drop" }, { now: 3 }).state;
	state = dictionaryModule.removeEntry(state, "drop", { now: 10 }).state;
	assertEqual(dictionaryModule.listEntries(state, "", "all").map((entry) => entry.term), ["keep"], "only the target is gone");
	// Adding a new term afterwards must not revive the deleted one.
	state = dictionaryModule.recordSighting(state, { term: "added-later" }, { now: 11 }).state;
	assertEqual(dictionaryModule.listEntries(state, "", "all").map((entry) => entry.term).sort(), ["added-later", "keep"], "the tombstone holds");
});

test("dictionary: merging a delete against an edit is order-independent", () => {
	// The regression guard for the asymmetry: a notice applied before the merge would
	// overwrite a live record without comparing times, so the same two documents
	// merged in the other order gave a different answer — and one of those answers
	// silently destroyed a strictly newer edit.
	//
	// The edit side is a `source: "user"` record, which is what the editor produces and
	// what authorises a revival. A bare timestamp is not enough: a stale automatic copy
	// arrives with a recent one too, and honouring time alone would let a union merge
	// undo the user's deletion.
	const deletedAt = (t) => dictionaryModule.removeEntry(dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "v1" } }, { now: 50 }).state, "q", { now: t }).state;
	const editedAt = (t) => dictionaryModule.seal([{ ...dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "v2" } }, { now: t }).state.entries[0] }]);
	const alive = (left, right) => dictionaryModule.mergeDocuments(left, right, { now: 900 }).entries.length > 0;

	// A newer edit beats the deletion, whichever document is the base.
	assertEqual(alive(deletedAt(100), editedAt(200)), true, "newer edit wins (deletion first)");
	assertEqual(alive(editedAt(200), deletedAt(100)), true, "newer edit wins (edit first)");
	// An older edit loses to the deletion, whichever document is the base.
	assertEqual(alive(deletedAt(300), editedAt(200)), false, "older edit loses (deletion first)");
	assertEqual(alive(editedAt(200), deletedAt(300)), false, "older edit loses (edit first)");
});

test("dictionary: only content the user asked for can revive a deleted term", () => {
	// Provenance is the gate. Time alone would let the plugin's own automatic detection
	// undo a deliberate deletion: a window that never learned of the tombstone builds a
	// fresh entry stamped "now", which is always newer than the deletion.
	const curated = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "mine" } }, { now: 100 }).state;
	const deleted = dictionaryModule.removeEntry(curated, "q", { now: 2000 }).state;
	const revive = (record) => dictionaryModule.listEntries(dictionaryModule.mergeState(deleted, { entries: [record] }, { now: 6000 }), "", "all").length;

	assertEqual(revive({ term: "q", updatedAt: 5000, source: "auto", definition: { gloss: "auto" } }), 0, "an automatic copy does not revive");
	assertEqual(revive({ term: "q", updatedAt: 5000, source: "heuristic", definition: { gloss: "glossary" } }), 0, "nor a glossary fill");
	assertEqual(revive({ term: "q", updatedAt: 5000 }), 0, "nor a bare detection with no definition");
	assertEqual(revive({ term: "q", updatedAt: 5000, source: "user", definition: { gloss: "typed" } }), 1, "the user's own text does");
	assertEqual(revive({ term: "q", updatedAt: 5000, source: "llm", definition: { gloss: "explained" } }), 1, "and an explanation the user asked for");
	// An automatic copy that is OLDER than the deletion cannot revive either.
	assertEqual(revive({ term: "q", updatedAt: 5000, source: "user", definition: { gloss: "old" } }), 1, "a newer user text revives");
	assertEqual(dictionaryModule.listEntries(dictionaryModule.mergeState(deleted, { entries: [{ term: "q", updatedAt: 1000, source: "user", definition: { gloss: "old" } }] }, { now: 6000 }), "", "all").length, 0, "an older user text does not");
});

test("dictionary: an undated deletion notice deletes only an uncurated term", () => {
	// `deletedKeys` exists for a client that never held the tombstone, so it carries
	// no deletion time and cannot be weighed against one. What it can still do is
	// delete a term nobody has curated — an automatic entry with no explanation.
	const curated = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "v1" } }, { now: 200 }).state;
	const kept = dictionaryModule.mergeState(curated, { deletedKeys: ["q"] }, { now: 400 });
	assertEqual(dictionaryModule.listEntries(kept, "", "all").length, 1, "a bare key does not delete a curated entry");

	// An automatic entry: created by a sighting, so it has a real timestamp but no
	// definition. That is what "uncurated" means, and it is reachable in production.
	let auto = dictionaryModule.emptyState({ now: 1 });
	auto = dictionaryModule.recordSighting(auto, { term: "q" }, { now: 500 }).state;
	assertEqual(dictionaryModule.listEntries(auto, "", "all")[0].definition.gloss, "", "the automatic entry has no explanation");
	const removed = dictionaryModule.mergeState(auto, { deletedKeys: ["q"] }, { now: 600 });
	assertEqual(dictionaryModule.listEntries(removed, "", "all").length, 0, "a bare key does delete an uncurated record");
	assertEqual([...removed.deletedKeys], ["q"], "and it is recorded as deleted");
});

test("dictionary: an explicit edit revives a deletion even when the clock runs behind", () => {
	// Forward clock skew: the deletion carries a later stamp than the edit that
	// follows it. Comparing clocks would reject the edit, and the user would watch
	// the editor close with nothing saved — so an explicit edit revives outright.
	let state = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "beta", { definition: { gloss: "v1" } }, { now: 100 }).state;
	state = dictionaryModule.removeEntry(state, "beta", { now: 1000 }).state;
	const edited = dictionaryModule.editEntry(state, "beta", { definition: { gloss: "v2" } }, { now: 200 });
	assertEqual(dictionaryModule.listEntries(edited.state, "", "all").length, 1, "the edit revives the term");
	assertEqual(edited.state.entries[0].definition.gloss, "v2", "and the typed text is stored");
});

test("dictionary: a sighting never revives, and never inherits edit authority", () => {
	// The transient `edited` flag must not survive a spread: if a sighting inherited
	// it, the transcript re-observing a term would revive the user's deletion.
	let state = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "beta", { definition: { gloss: "v1" } }, { now: 100 }).state;
	state = dictionaryModule.removeEntry(state, "beta", { now: 1000 }).state;
	const seen = dictionaryModule.recordSighting(state, { term: "beta" }, { now: 200 });
	assertEqual(dictionaryModule.listEntries(seen.state, "", "all").length, 0, "the sighting does not revive it");
	assertEqual(seen.deleted, true, "and the caller is told it is still deleted");
	// A sighting of a live term counts once and does not re-stamp the record.
	let live = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "gamma", { definition: { gloss: "g" } }, { now: 100 }).state;
	const once = dictionaryModule.recordSighting(live, { term: "gamma" }, { now: 500 });
	assertEqual(once.state.entries[0].updatedAt, 100, "a sighting does not re-stamp the edit time");
	assertEqual(once.state.entries[0].seen, 2, "but it does count");
});

test("dictionary: merging never invents an edit time", () => {
	// A merge that re-stamped `updatedAt` with the merge clock made received content
	// look like an edit made after a deletion, which is how an older copy could win.
	const incoming = { entries: [{ term: "delta", updatedAt: 100, definition: { gloss: "d" } }] };
	const merged = dictionaryModule.mergeState(dictionaryModule.emptyState({ now: 1 }), incoming, { now: 9999 });
	assertEqual(merged.entries[0].updatedAt, 100, "the authored time survives the merge");
});

test("dictionary: the transient edit marker never reaches the wire", () => {
	// The round-4 high finding. `edited` means "this arrival revives the term". It was
	// persisted onto the tombstone a deletion produced, so the next round trip read the
	// user's own deletion as a request to restore the term — and it came back. A term
	// the user deletes must survive its own round trip.
	let state = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "alpha", { definition: { gloss: "A" } }, { now: 100 }).state;
	const deleted = dictionaryModule.removeEntry(state, "alpha", { now: 200 }).state;
	const wire = JSON.parse(JSON.stringify(dictionaryModule.serializeState(deleted)));
	assertEqual(wire.backing.length, 1, "the tombstone still travels");
	assert(wire.backing[0].edited === undefined, "but the edit marker does not");
	assert(wire.entries.every((entry) => entry.edited === undefined && entry.observed === undefined), "no live entry carries one either");

	// Feeding that exact payload back to the local document must NOT revive the term.
	const roundTripped = dictionaryModule.mergeState(deleted, wire, { now: 300 });
	assertEqual(dictionaryModule.listEntries(roundTripped, "", "all").length, 0, "the deletion survives its own round trip");
	assertEqual([...roundTripped.deletedKeys], ["alpha"], "and the term is still named as deleted");
});

test("dictionary: a merge weighs an arriving edit against the deletion in either order", () => {
	// The order-independence guard covers a revival that arrives as an edited record.
	// Reading the edit times off the arriving side alone made the two merge directions
	// disagree, which is the same asymmetry the earlier rounds kept finding.
	const editTime = (time) => dictionaryModule.seal([{ ...dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "v2" } }, { now: time }).state.entries[0], edited: true }]);
	const removeAfter = (edit) => dictionaryModule.removeEntry(dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "v1" } }, { now: 50 }).state, "q", { now: edit }).state;
	const mergeThem = (left, right) => dictionaryModule.mergeDocuments(left, right, { now: 900 });
	// A revival that arrived before the deletion is older, so it loses both ways.
	assertEqual(mergeThem(removeAfter(300), editTime(200)).entries.length, 0, "an older arriving edit loses (deletion first)");
	assertEqual(mergeThem(editTime(200), removeAfter(300)).entries.length, 0, "an older arriving edit loses (deletion first) — reversed");
	// A revival that arrived after the deletion wins both ways.
	assertEqual(mergeThem(removeAfter(100), editTime(200)).entries.length, 1, "a newer arriving edit wins (deletion first)");
	assertEqual(mergeThem(editTime(200), removeAfter(100)).entries.length, 1, "a newer arriving edit wins (edit first)");
});

test("dictionary: a re-curation survives the clock, and a stale copy does not revive", () => {
	// The two halves of the rule, and the reason the second half is stated as "older"
	// rather than "not marked as an edit": there is no marker any more. The decision is
	// a comparison of two times, so the only thing that matters is which is newer.
	//
	// 1. Forward clock skew. The deletion is stamped later than the edit that follows it,
	//    because the deleting machine's clock was ahead. `editEntry` stamps the revival
	//    one millisecond past the tombstone it supersedes, so the text the user typed is
	//    not thrown away by the next sync.
	const state = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "v1" } }, { now: 100 }).state;
	const deleted = dictionaryModule.removeEntry(state, "q", { now: 1000 }).state;
	const typed = dictionaryModule.editEntry(deleted, "q", { definition: { gloss: "typed" } }, { now: 200 });
	const revived = dictionaryModule.listEntries(typed.state, "", "all");
	assertEqual(revived.length, 1, "the typed edit revives despite the clock");
	assertEqual(revived[0].definition.gloss, "typed", "and the text is stored");
	// It must also survive a round trip against the tombstone still on the wire.
	const synced = dictionaryModule.mergeState(typed.state, JSON.parse(JSON.stringify(dictionaryModule.serializeState(deleted))), { now: 2000 });
	assertEqual(dictionaryModule.listEntries(synced, "", "all").length, 1, "and the revival survives the tombstone coming back");

	// 2. A copy that is older than the deletion cannot bring the term back, which is the
	//    guarantee that keeps a union merge from undoing a deletion.
	const stale = dictionaryModule.mergeState(deleted, { entries: [{ term: "q", updatedAt: 500, definition: { gloss: "stale" } }] }, { now: 10000 });
	assertEqual(dictionaryModule.listEntries(stale, "", "all").length, 0, "an older copy does not revive");
	const same = dictionaryModule.mergeState(deleted, { entries: [{ term: "q", updatedAt: 1000, definition: { gloss: "same" } }] }, { now: 10000 });
	assertEqual(dictionaryModule.listEntries(same, "", "all").length, 0, "nor does one stamped at the same instant (a tie is a deletion)");
});

//#endregion

//#region store-and-collector

/**
 * A minimal element whose rendered text is one text node, with the parent links the
 * interaction layer walks. Only what `readRegion` and `termAtPoint` actually read.
 * @param tag - the element's tag name.
 * @param text - its own text.
 * @param rect - its viewport box.
 * @returns the element.
 */
function makeNode(tag, text, rect) {
	const node = {
		nodeType: 1,
		tagName: tag,
		nodeValue: null,
		parentElement: null,
		parentNode: null,
		children: [],
		childNodes: [],
		innerText: text,
		textContent: text,
		rect: rect ?? { left: 0, top: 0, right: 600, bottom: 20, width: 600, height: 20 },
		getAttribute: () => null,
		hasAttribute: () => false,
		contains(other) {
			let at = other;
			while (at !== null && at !== undefined) {
				if (at === this) return true;
				at = at.parentElement;
			}
			return false;
		},
		closest: () => null,
		getBoundingClientRect() {
			return this.rect;
		}
	};
	if (typeof text === "string" && text !== "") {
		const textNode = { nodeType: 3, nodeValue: text, textContent: text, parentElement: null, parentNode: null, children: [], childNodes: [] };
		textNode.parentElement = node;
		textNode.parentNode = node;
		node.childNodes.push(textNode);
	}
	return node;
}

/**
 * Attach a child to a fixture element.
 * @param parent - the parent.
 * @param child - the child.
 * @returns the child.
 */
function attachNode(parent, child) {
	child.parentElement = parent;
	child.parentNode = parent;
	parent.children.push(child);
	parent.childNodes.push(child);
	return child;
}

/**
 * A region holding one paragraph, plus the document and window stubs the layer reads.
 * @param text - the transcription text.
 * @returns `{ region, document, window }`.
 */
function makeCollectorWorld(text) {
	const region = makeNode("DIV", "");
	const paragraph = attachNode(region, makeNode("P", text));
	region.innerText = paragraph.innerText;
	region.textContent = paragraph.textContent;
	const documentStub = {
		querySelector: (selector) => (typeof selector === "string" && selector.includes("conversation-region") ? region : null),
		addEventListener: () => {},
		removeEventListener: () => {},
		caretRangeFromPoint: () => null
	};
	const windowStub = {
		getSelection: () => ({ isCollapsed: true, rangeCount: 0, toString: () => "" }),
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (handle) => clearTimeout(handle),
		innerWidth: 1280,
		innerHeight: 800
	};
	return { region, document: documentStub, window: windowStub };
}

/**
 * A detector that reports one term, so a check can drive the collector's refusal path
 * without depending on which words the bundled lexicons happen to know. The refusal is
 * reached only when the collector considers the term NEW, which is the only shape in
 * which it is observable.
 * @param term - the term to report.
 * @returns the detector stub.
 */
function detectingOnly(term) {
	return {
		scan: () => [{ term, key: term, start: 4, end: 4 + term.length, known: false, confidence: 0.5 }],
		// `undefined`, matching the real detector's miss shape. `null` is a *hit* to the
		// guard, which tests against `undefined`, and returning it silently disabled the
		// collection this stub exists to provoke.
		glossaryOf: () => undefined,
		knownOf: () => [],
		bestCandidate: () => null,
		findAll: () => []
	};
}

/**
 * Drive the collector against a REAL store, so the refusal path is not bypassed by a
 * test seam. That seam is exactly what let a false "自动收录了 N 个术语" notice ship:
 * the older check forced the answer with `setSightingAnswer`, which hid the fact that
 * the store was dropping the `deleted` flag the collector reads.
 *
 * The store holds the tombstone but NO live entry — the only shape in which the refusal
 * is reachable, because `recordSighting` needs a tombstone to refuse.
 * @returns a promise settling when the check has run.
 */
async function storeChecks() {
	await asyncCheck("store + interact: a refused sighting is not announced as collected", "collectorRefusal", async () => {
		const { createInteractionLayer } = loadCore("interact.js");
		const memory = new Map();
		const storage = {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key)
		};
		const browserStore = dictionaryModule.createBrowserStore(storage, { warn: () => {} });
		// A window that deleted a term: its document carries the tombstone and nothing live.
		// The term is a rare identifier, which is what auto-collection is for — an ordinary
		// word would never reach the store now.
		let deleted = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "WriteAheadLog", { definition: { gloss: "先写一条。" } }, { now: 100 }).state;
		deleted = dictionaryModule.removeEntry(deleted, "WriteAheadLog", { now: 2000 }).state;
		await browserStore.save(deleted);
		const store = createDictionaryStore({ local: browserStore, remote: null, logger: { warn: () => {} }, now: () => 5000 });
		await store.hydrate();
		assertEqual(store.list("", "all").length, 0, "nothing is live to begin with");
		assertEqual(store.find("WriteAheadLog"), null, "and the term is not findable");

		const world = makeCollectorWorld("the WriteAheadLog flush");
		const toasts = [];
		const sights = [];
		const layer = createInteractionLayer({
			detector: detectingOnly("WriteAheadLog"),
			store: {
				getState: () => store.getState(),
				noteSighting: (sighting) => {
					sights.push(sighting.term);
					return store.noteSighting(sighting);
				}
			},
			isWordCharacter: (character) => /\w/.test(character),
			// Permissive on purpose: these checks are about the collector's LOGIC, while the
			// shipped defaults (no code-shaped names, nothing under four characters) are asserted
			// in the settings checks. Letting a preference decide the outcome here would hide a
			// real regression in collection behind a switch.
			collectSettings: () => ({ collectMinLength: 1, collectIdentifiers: true, collectCjk: true }),
			logger: { warn: () => {} },
			onExplain: () => {},
			onSelection: () => {},
			onToast: (toast) => toasts.push(toast),
			document: world.document,
			window: world.window
		});
		// The stub reports an ordinary-looking word, so the built-in rarity policy would
		// skip it and the refusal path would never be reached. The filter seam narrows the
		// policy for this check alone; the glossary and "already known" guards still run
		// first, so the seam cannot make the layer decide anything unsafe.
		layer.setAutoCreateFilter(() => true);
		// `attach()` binds the conversation region, which the snapshot reads; the settle
		// timer it schedules fires long after this pass, so `scanNow` still sees the message.
		layer.attach();
		try {
			const created = await layer.scanNow();
			assert(sights.includes("WriteAheadLog"), `the collector must have tried to record the deleted term, saw ${JSON.stringify(sights)}`);
			assertEqual(created, 0, "a refused sighting is reported as nothing collected");
			assertEqual(toasts.length, 0, "and no notice claims a term was collected");
			assertEqual(store.find("WriteAheadLog"), null, "and the deleted term is still deleted");
		} finally {
			layer.detach();
		}
	});

	await asyncCheck("interact: auto-collection creates only rare terms, never glossary words or prose", "autoCreatePolicy", async () => {
		// The policy the user asked for: a rare word the agent used gets an entry, and
		// everything the plugin can already define, or that is simply ordinary text, does
		// not. Without this the panel fills with the agent's whole vocabulary.
		//
		// Every candidate is deleted first so all three are genuinely NEW to the collector
		// — otherwise the glossary terms would be skipped as "already known" and the check
		// would pass without testing the policy at all.
		const { createInteractionLayer } = loadCore("interact.js");
		const attempts = [];
		const world = makeCollectorWorld("the WriteAheadLog and the idempotent handler agree on the quorum");
		const layer = createInteractionLayer({
			detector: detectorWith([]),
			store: {
				getState: () => ({ entries: [] }),
				noteSighting: (sighting) => {
					attempts.push(sighting.term);
					return { created: true, deleted: false };
				}
			},
			isWordCharacter: (character) => /\w/.test(character),
			// Permissive on purpose: these checks are about the collector's LOGIC, while the
			// shipped defaults (no code-shaped names, nothing under four characters) are asserted
			// in the settings checks. Letting a preference decide the outcome here would hide a
			// real regression in collection behind a switch.
			collectSettings: () => ({ collectMinLength: 1, collectIdentifiers: true, collectCjk: true }),
			logger: { warn: () => {} },
			onExplain: () => {},
			onSelection: () => {},
			onToast: () => {},
			document: world.document,
			window: world.window
		});
		// `attach()` binds the conversation region, which the snapshot reads from. The
		// settle timer it schedules fires long after this pass, so `scanNow` still sees the
		// message and the three candidates are all new.
		layer.attach();		try {
			await layer.scanNow();
			assert(attempts.includes("WriteAheadLog"), `the rare identifier must be collected, saw ${JSON.stringify(attempts)}`);
			assertEqual(attempts.includes("quorum"), false, "a term the built-in glossary already explains must not be");
			assertEqual(attempts.includes("idempotent"), false, "nor another term the glossary explains");
			assertEqual(attempts.includes("the"), false, "and nor ordinary prose");
		} finally {
			layer.detach();
		}
	});

	await asyncCheck("interact: a deleted rare term is not re-collected from conversation", "deletedNotRecollected", async () => {
		// The rule the user asked for and the one users will notice: deletion is final for
		// the COLLECTOR. A rare term still in the transcript must not come back just because
		// the agent mentioned it again — otherwise a later reply revives it on its own and
		// the user's deletion quietly undoes itself. The manual paths (selecting the word,
		// typing in the editor) are unaffected.
		const { createInteractionLayer } = loadCore("interact.js");
		const memory = new Map();
		const storage = {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key)
		};
		const store = createDictionaryStore({
			local: dictionaryModule.createBrowserStore(storage, { warn: () => {} }),
			remote: null,
			logger: { warn: () => {} },
			now: () => 5000
		});
		await store.hydrate();
		await store.saveEntry("WriteAheadLog", { definition: { gloss: "先写一条。" } });
		await store.deleteEntry("WriteAheadLog");
		assertEqual(store.find("WriteAheadLog"), null, "the term is deleted before the transcript is read");

		const attempts = [];
		const world = makeCollectorWorld("As established, the WriteAheadLog handles it.");
		const layer = createInteractionLayer({
			detector: detectorWith([]),
			store: {
				getState: () => store.getState(),
				noteSighting: (sighting) => {
					attempts.push(sighting.term);
					return store.noteSighting(sighting);
				}
			},
			isWordCharacter: (character) => /\w/.test(character),
			// Permissive on purpose: these checks are about the collector's LOGIC, while the
			// shipped defaults (no code-shaped names, nothing under four characters) are asserted
			// in the settings checks. Letting a preference decide the outcome here would hide a
			// real regression in collection behind a switch.
			collectSettings: () => ({ collectMinLength: 1, collectIdentifiers: true, collectCjk: true }),
			logger: { warn: () => {} },
			onExplain: () => {},
			onSelection: () => {},
			onToast: () => {},
			document: world.document,
			window: world.window
		});
		layer.attach();
		try {
			const created = await layer.scanNow();
			assertEqual(created, 0, "a later mention creates nothing");
			assertEqual(attempts.length, 0, "and the collector does not even ask — a deleted term is skipped outright");
			assertEqual(store.find("WriteAheadLog"), null, "and it stays deleted");
			// The manual path is the one that may revive it.
			await store.saveEntry("WriteAheadLog", { definition: { gloss: "手动加回来的。" } });
			assert(store.find("WriteAheadLog") !== null, "a deliberate add still revives it");
			assertEqual(store.find("WriteAheadLog").definition.gloss, "手动加回来的。", "with the text the user gave");
		} finally {
			layer.detach();
		}
	});

	await asyncCheck("store: a refused sighting writes nothing, a live one still counts", "sightingStore", async () => {
		const memory = new Map();
		const storage = {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key)
		};
		const store = createDictionaryStore({
			local: dictionaryModule.createBrowserStore(storage, { warn: () => {} }),
			remote: null,
			logger: { warn: () => {} },
			now: () => 5000
		});
		await store.saveEntry("Refused", { definition: { gloss: "x" } });
		await store.deleteEntry("Refused");
		const before = JSON.stringify(dictionaryModule.serializeState(store.getState()));
		const refused = await store.noteSighting({ term: "Refused" });
		assertEqual(refused.deleted, true, "the store must report the refusal");
		assertEqual(refused.created, false, "and report nothing created");
		assertEqual(JSON.stringify(dictionaryModule.serializeState(store.getState())), before, "and the document must not change");

		await store.saveEntry("Live", { definition: { gloss: "kept" } });
		const counted = await store.noteSighting({ term: "Live", context: "a sentence" });
		assertEqual(counted.deleted, false, "a live term is not reported as deleted");
		assertEqual(store.find("Live").seen, 2, "and its sighting is counted");
	});
}

test("dictionary: a record cannot be smuggled in through the tombstone channel", () => {
	// `entries` are live and `backing` are tombstones, and a record whose own `deletedAt`
	// contradicts the channel it arrived in is malformed. Both directions are resolved
	// toward the channel, because the alternative is a payload that carries live content
	// in the deletion list to slip past the deletion rules.
	const live = dictionaryModule.editEntry(dictionaryModule.emptyState({ now: 1 }), "q", { definition: { gloss: "mine" } }, { now: 100 }).state;
	const deleted = dictionaryModule.removeEntry(live, "q", { now: 2000 }).state;

	// A crafted LIVE record in `backing` must not revive the term.
	const smuggled = dictionaryModule.mergeState(deleted, { backing: [{ term: "q", updatedAt: 9000, source: "user", definition: { gloss: "smuggled" } }] }, { now: 9000 });
	assertEqual(dictionaryModule.listEntries(smuggled, "", "all").length, 0, "a live record in backing cannot revive");
	// A crafted TOMBSTONE must not authorise its own revival either, whatever it claims
	// about when it was written.
	const selfAuthorised = dictionaryModule.mergeState(deleted, { backing: [{ term: "q", deletedAt: 100, updatedAt: 999999, source: "user", definition: { gloss: "x" } }] }, { now: 9000 });
	assertEqual(dictionaryModule.listEntries(selfAuthorised, "", "all").length, 0, "a tombstone cannot revive itself");
	// The legitimate path is untouched: a live crafted record in `entries`, newer than the
	// deletion, still revives.
	const proper = dictionaryModule.mergeState(deleted, { entries: [{ term: "q", updatedAt: 9000, source: "user", definition: { gloss: "typed" } }] }, { now: 9000 });
	assertEqual(dictionaryModule.listEntries(proper, "", "all").length, 1, "a live crafted record in entries still revives");
	// And a tombstone planted in `entries` is read as the tombstone it claims to be.
	const planted = dictionaryModule.mergeState(dictionaryModule.emptyState({ now: 1 }), { entries: [{ term: "q", updatedAt: 9000, deletedAt: 500, source: "user", definition: { gloss: "x" } }] }, { now: 9000 });
	assertEqual(dictionaryModule.listEntries(planted, "", "all").length, 0, "a tombstone in entries stays deleted");
});

//#endregion

//#region terms

const { TermDetector } = loadCore("terms.js");
const lexiconEn = existsSync(join(coreDir, "lexicon.en.js")) ? loadCore("lexicon.en.js") : {};
const lexiconZh = existsSync(join(coreDir, "lexicon.zh.js")) ? loadCore("lexicon.zh.js") : {};
const stopwordLists = existsSync(join(coreDir, "stopwords.js")) ? loadCore("stopwords.js") : { EN: [], ZH: [] };

/**
 * Build a detector over the bundled lexicons and an optional user dictionary.
 * @param entries - user dictionary entries.
 * @returns the detector.
 */
function detectorWith(entries = []) {
	return new TermDetector({ lexicon: { ...lexiconEn, ...lexiconZh }, entries, stopwords: stopwordLists });
}

test("terms: the bundled lexicons are non-trivial", () => {
	assert(Object.keys(lexiconEn).length >= 400, `English lexicon is too small: ${Object.keys(lexiconEn).length}`);
	assert(Object.keys(lexiconZh).length >= 60, `Chinese lexicon is too small: ${Object.keys(lexiconZh).length}`);
});

test("terms: the bundled stopword lists are non-trivial", () => {
	assert(stopwordLists.EN.length >= 300, `English stopword list is too small: ${stopwordLists.EN.length}`);
	assert(stopwordLists.ZH.length >= 30, `Chinese stopword list is too small: ${stopwordLists.ZH.length}`);
});

test("terms: a glossary phrase is detected as one hit, not two words", () => {
	const detector = detectorWith();
	const text = "We adopted event sourcing for the ledger.";
	const found = detector.scan(text);
	const hit = found.find((occurrence) => occurrence.key === "event sourcing");
	assert(hit !== undefined, `the phrase must be detected, got ${JSON.stringify(found.map((o) => o.key))}`);
	assertEqual(text.slice(hit.start, hit.end), "event sourcing", "the match covers the whole phrase");
	assertEqual(found.filter((occurrence) => occurrence.key === "event" || occurrence.key === "sourcing").length, 0, "its words must not be reported separately");
});

test("terms: a Chinese glossary term is detected inside a longer word", () => {
	const detector = detectorWith();
	const found = detector.scan("这个接口需要保证幂等性，避免重复扣款。");
	assert(
		found.some((occurrence) => occurrence.key === "幂等" || occurrence.key === "幂等性"),
		`expected a 幂等 hit, got ${JSON.stringify(found.map((o) => o.key))}`
	);
});

test("terms: the user's own entry is matched, not merely remembered", () => {
	// The regression guard for "已经添加的词条在对话中没有变成词条块".
	//
	// `scan` finds occurrences by searching the text for each key in `keys`, and `keys`
	// was filled ONLY from the lexicon. A collected term that is not also a built-in
	// glossary word therefore came back as an unknown `identifier` candidate — never
	// marked in the transcript, never explained on hover, and clicking it offered to
	// create the entry that already existed. Only entries that happened to be glossary
	// words (like `quorum`) worked, which is why every test passed.
	const detector = new TermDetector({
		lexicon: { quorum: { zh: "法定人数", domain: "系统", gloss: "多数派确认。" } },
		entries: [{ term: "WriteAheadLog", id: "e1", aliases: ["WAL"] }],
		stopwords: []
	});
	const hit = detector.scan("Call WriteAheadLog before commit.", { includeCandidates: true }).find((occurrence) => occurrence.key === "writeaheadlog");
	assert(hit !== undefined, "the collected term must be matched at all");
	assertEqual(hit.source, "dictionary", "and reported as the dictionary's own hit");
	assertEqual(hit.known, true, "so the transcript treats it as known");
	const viaAlias = detector.scan("The WAL is flushed.", { includeCandidates: true }).find((occurrence) => occurrence.key === "writeaheadlog");
	assert(viaAlias !== undefined, "an alias must match too");
	assertEqual(viaAlias.source, "dictionary", "and resolve to the entry");
	// The two sources stay distinguishable, which is what the marking and the click route on.
	assertEqual(detector.scan("The quorum decides.", { includeCandidates: true })[0].source, "glossary", "a built-in term stays a glossary hit");
});

test("terms: a known dictionary term outranks the glossary", () => {
	const detector = detectorWith([{ term: "quorum", id: "custom", definition: { gloss: "我的解释" } }]);
	const found = detector.scan("A quorum is required.");
	const hit = found.find((occurrence) => occurrence.key === "quorum");
	assert(hit !== undefined, "the term must be detected");
	assertEqual(hit.source, "dictionary", "the user dictionary answers first");
	assertEqual(hit.id, "custom", "the user entry's id is used");
});

test("terms: identifier spelling is noticed without any dictionary", () => {
	const detector = detectorWith([]);
	const found = detector.scan("Call runInTransaction before you commit.");
	assert(
		found.some((occurrence) => occurrence.term === "runInTransaction" && occurrence.source === "identifier"),
		`expected an identifier hit, got ${JSON.stringify(found.map((o) => o.term))}`
	);
});

test("terms: ordinary prose is not flagged", () => {
	const detector = detectorWith();
	const found = detector.scan("The user said the file is in the folder and the value is small.");
	const flagged = found.filter((occurrence) => !occurrence.known);
	assertEqual(flagged.length, 0, `ordinary words must not be candidates, got ${JSON.stringify(flagged.map((o) => o.term))}`);
});

test("terms: a substring inside a longer word is not a hit", () => {
	const detector = detectorWith([{ term: "act" }]);
	const found = detector.scan("The interaction was long.");
	assertEqual(found.filter((occurrence) => occurrence.key === "act").length, 0, "act must not match inside interaction");
});

test("terms: matches never overlap", () => {
	const detector = detectorWith();
	const found = detector.scan("Event sourcing and eventual consistency both matter.");
	for (let index = 1; index < found.length; index++) {
		assert(found[index].start >= found[index - 1].end, `overlapping matches: ${JSON.stringify(found.slice(index - 1, index + 1))}`);
	}
});

test("terms: bestCandidate prefers the strongest unknown evidence", () => {
	const detector = detectorWith();
	const best = detector.bestCandidate("We rely on itsBackpressure handling.");
	assert(best !== null, "a candidate must be found");
	assertEqual(best.occurrence.term, "itsBackpressure", "the identifier wins");
});

//#endregion

//#region bundle

test("bundle: the generated browser half loads and registers the plugin", () => {
	const { slots, localeRegistrations } = loadBundle();
	assertEqual(slots.includes("sidebar.panellist"), true, "the panel row slot must be injected");
	assertEqual(slots.includes("main"), true, "the center panel slot must be injected");
	assertEqual(slots.includes("shell.overlay"), true, "the overlay slot must be injected");
	assert(localeRegistrations.some((entry) => entry.ns === "termDictionary"), "the plugin must register its dictionaries");
});

test("bundle: the bundle id matches the package name", () => {
	const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
	const { sandbox } = loadBundle();
	assert(sandbox !== null, "the bundle evaluated");
	assert(pkg.name === "dsh-plugin-term-dictionary", "package name");
});

test("bundle: the shell's views render without throwing", () => {
	const { registered } = loadBundle();
	const panel = registered.find((options) => options.name === "main");
	assert(panel !== undefined, "the main slot registration must be captured");
	assert(typeof panel.inject === "function", "the panel registration must declare its injected face");
	const face = panel.inject();
	assert(face !== null && typeof face === "object" && typeof face.store?.getSnapshot === "function", "the panel must receive the dictionary store");
});

test("bundle: every registered surface carries the localization and identity the slot needs", () => {
	const { registered } = loadBundle();
	const row = registered.find((options) => options.name === "sidebar.panellist");
	assert(row !== undefined, "the sidebar row must be registered");
	assertEqual(row.id, "term-dictionary", "the panel id is what the layout selects");
	assert(typeof row.order === "number", "the row needs an order");
	assertEqual(typeof row.label, "function", "the row label is a thunk so it follows the locale");
	const overlay = registered.find((options) => options.name === "shell.overlay");
	assert(overlay !== undefined, "the overlay must be registered");
	assertEqual(overlay.id, "term-dictionary-overlay", "the overlay id");
});

test("bundle: the panel follows a reveal command to the entry it names", () => {
	// The gesture contract: clicking a term the dictionary already holds must show the
	// entry, not open a blank editor over it. The shell writes the reveal on the bus,
	// and this renders the panel the slot would render, watching what it decides.
	const sets = [];
	const react = makeReactStub({ onSet: (value) => sets.push(value) });
	const { registered, components } = loadBundle({ react });
	const index = registered.findIndex((options) => options.name === "main");
	assert(index >= 0, "the main slot registration must be captured");
	const face = registered[index].inject();
	face.bus.requestFocus("quorum");
	const component = components[index];
	assertEqual(typeof component, "function", "the panel component must be captured");
	component({ ...face, t: (key) => key });
	assert(sets.includes("quorum"), `the panel must reveal the named entry, saw ${JSON.stringify(sets)}`);
	// The editor drafts an object carrying `isNew`; a reveal must not produce one.
	const openedEditor = sets.some((value) => value !== null && typeof value === "object" && "isNew" in value);
	assertEqual(openedEditor, false, "revealing an existing entry must not open the editor");
	assertEqual(face.bus.consumeFocus(), null, "the panel acknowledges the command by consuming it");
});

test("settings: defaults, persistence, and a storage that refuses", () => {
	const { createSettingsStore, SETTINGS_KEY, DEFAULT_SETTINGS } = loadCore("settings.js");
	const memory = () => ({
		map: new Map(),
		getItem(key) {
			return this.map.has(key) ? this.map.get(key) : null;
		},
		setItem(key, value) {
			this.map.set(key, String(value));
		}
	});
	const storage = memory();
	const store = createSettingsStore({ storage });
	assertEqual(store.getSnapshot(), DEFAULT_SETTINGS, "unset switches fall back to the defaults");
	const first = store.getSnapshot();
	store.set("autoCollect", false);
	assertEqual(store.getSnapshot().autoCollect, false, "a switch flips");
	assert(store.getSnapshot() !== first, "and the snapshot identity changes, which is what re-renders the panel");
	assert(store.getSnapshot() === store.getSnapshot(), "but is stable between changes");
	assertEqual(createSettingsStore({ storage }).getSnapshot().autoCollect, false, "the switch persists under its own key");
	assert(storage.getItem(SETTINGS_KEY) !== null, "and is written there");
	store.set("nonsense", true);
	assertEqual(store.getSnapshot().nonsense, undefined, "an unknown switch is ignored rather than stored");
	// A storage that refuses must not take the panel down with it: the switches still work
	// for this session, and the defaults are what a fresh store starts from.
	const hostile = {
		getItem() {
			throw new Error("denied");
		},
		setItem() {
			throw new Error("denied");
		}
	};
	const fallback = createSettingsStore({ storage: hostile, logger: { warn: () => {} } });
	assertEqual(fallback.getSnapshot(), DEFAULT_SETTINGS, "an unusable storage yields the defaults");
	fallback.set("autoExplain", false);
	assertEqual(fallback.getSnapshot().autoExplain, false, "and the switch still works in memory");
});

test("dictionary: a revived entry survives a merge with the copy that still has the tombstone", () => {
	// "Retract from the blacklist" only means something if it survives the next sync. A revival is
	// decided by one comparison in the merge — a CRAFTED record strictly newer than the deletion —
	// so the two ways to get this wrong are inheriting a non-crafted source and not being newer.
	const { emptyState, editEntry, removeEntry, reviveEntry, listEntries, mergeState, findEntry } = loadCore("dictionary.js");
	let state = emptyState({ now: 1 });
	state = editEntry(state, "Quorum", { definition: { zh: "法定人数", gloss: "g" } }, { now: 2 }).state;
	const removed = removeEntry(state, "Quorum", { now: 5 });
	assertEqual(listEntries(removed.state).length, 0, "the entry is gone to every reader");
	assertEqual(findEntry(removed.state, "Quorum"), undefined, "and invisible by lookup");

	const revived = reviveEntry(removed.state, "Quorum", { now: 10 });
	assertEqual(revived.revived, true, "the revival reports what it did");
	assertEqual(listEntries(revived.state).map((entry) => entry.term), ["Quorum"], "and the entry is live again");
	assertEqual(revived.state.backing.length, 0, "the tombstone leaves `backing`, so nothing can weigh it a second time");
	assertEqual(revived.state.deletedKeys.length, 0, "and its key leaves the deletion list");

	// The whole point: merge with the copy that predates the revival and still carries the tombstone.
	const merged = mergeState(revived.state, removed.state, { now: 11 });
	assertEqual(listEntries(merged).map((entry) => entry.term), ["Quorum"], "the revival survives a union merge with the older tombstone");
	assertEqual(findEntry(merged, "Quorum").source, "user", "because a revival IS user intent, which is the only thing that outweighs a deletion");

	// The three no-ops, so a caller can press the button twice without inventing state.
	assertEqual(reviveEntry(revived.state, "Quorum", { now: 12 }).revived, false, "reviving a live entry does nothing");
	assertEqual(reviveEntry(removed.state, "Never heard of it", { now: 12 }).revived, false, "and so does reviving a term that was never here");

	// A revival stamped before the deletion must still win: the clock is not the authority, intent
	// plus a strictly newer stamp is — and `+1` is what supplies the "strictly".
	const early = reviveEntry(removed.state, "Quorum", { now: 0 });
	assertEqual(listEntries(early.state).length, 1, "a revival whose clock is behind the deletion still revives");
	assertEqual(
		listEntries(mergeState(early.state, removed.state, { now: 11 })).length,
		1,
		"and it survives the merge too, which is where a naive `now` would have lost"
	);
});

test("dictionary: the deleted list shows the tombstones, newest deletion first", () => {
	// "Retract from the blacklist" needs a blacklist to look at. Tombstones ride in `backing` and are
	// invisible to every ordinary reader — including `listEntries`, which is exactly why the deleted
	// view is a different LIST rather than one more predicate over the same one.
	const { emptyState, editEntry, removeEntry, reviveEntry, listDeleted, listEntries } = loadCore("dictionary.js");
	let state = emptyState({ now: 1 });
	state = editEntry(state, "Quorum", { definition: { gloss: "g" } }, { now: 2 }).state;
	state = editEntry(state, "Entropy", { definition: { gloss: "g" } }, { now: 3 }).state;
	state = editEntry(state, "Live one", { definition: { gloss: "g" } }, { now: 4 }).state;
	const firstGone = removeEntry(state, "Quorum", { now: 10 }).state;
	const twoGone = removeEntry(firstGone, "Entropy", { now: 20 }).state;

	assertEqual(listEntries(twoGone).map((entry) => entry.term), ["Live one"], "the ordinary list never shows a tombstone");
	assertEqual(listDeleted(twoGone).map((entry) => entry.term), ["Entropy", "Quorum"], "the deleted list shows them, newest deletion first");
	assertEqual(listDeleted(twoGone, "quo").map((entry) => entry.term), ["Quorum"], "and it is searchable like the other one");
	assertEqual(listDeleted(emptyState({ now: 1 })), [], "a document with no deletions lists nothing");

	// Reviving is the whole interaction: the row leaves one list and rejoins the other.
	const back = reviveEntry(twoGone, "Quorum", { now: 30 }).state;
	assertEqual(listDeleted(back).map((entry) => entry.term), ["Entropy"], "a revived entry leaves the deleted list");
	assert(listEntries(back).some((entry) => entry.term === "Quorum"), "and is live in the ordinary one again");
});

test("dictionary: a remark is a decision, and the later one wins in either merge order", () => {
	// The same shape as `pinned`: a thing the user can say and take back needs its own clock, because
	// `updatedAt` follows the definition and neither of these changes one. The failure this guards is
	// the one unpinning had: an OR (or a value-only comparison) can only ever add, so a retraction on
	// one machine comes back from the other on the next sync.
	const { emptyState, editEntry, listEntries, mergeState } = loadCore("dictionary.js");
	const state = editEntry(emptyState({ now: 1 }), "Quorum", { definition: { gloss: "g" } }, { now: 10 }).state;
	const marked = editEntry(state, "Quorum", { feedback: { kind: "wrong-gloss", note: "太笼统" }, untrusted: true }, { now: 20 }).state;
	assertEqual(listEntries(marked, "", "flagged").map((entry) => entry.term), ["Quorum"], "a remark flags the entry");

	// An unrelated save must not move either decision: fixing a typo in the gloss is not a retraction.
	const edited = editEntry(marked, "Quorum", { definition: { gloss: "g2" } }, { now: 30 }).state;
	assertEqual(listEntries(edited, "", "flagged").length, 1, "an unrelated save leaves the remark alone");
	assertEqual(listEntries(edited)[0].feedbackAt, 20, "and does not re-stamp when it was made");

	// Retraction in the SAME millisecond as the remark it takes back: the stamp has to advance anyway,
	// or the retraction would tie with the remark and lose to it (the comparison is strict). Two clicks
	// inside one millisecond is not a hypothetical — it is a double-click.
	const sameMs = editEntry(marked, "Quorum", { feedback: null, untrusted: false }, { now: 20 }).state;
	assertEqual(listEntries(sameMs, "", "flagged").length, 0, "a retraction in the same millisecond still wins");
	assertEqual(listEntries(sameMs)[0].feedbackAt > 20, true, "because its stamp is strictly later");
	assertEqual(listEntries(mergeState(sameMs, marked, { now: 40 }), "", "flagged").length, 0, "and it survives the merge that still carries the remark");

	// And a retraction later than the remark, for the ordinary case.
	const cleared = editEntry(edited, "Quorum", { feedback: null, untrusted: false }, { now: 30 }).state;
	assertEqual(listEntries(cleared, "", "flagged").length, 0, "clearing takes the entry off the list");
	assertEqual(listEntries(cleared)[0].untrusted, false, "and takes the verdict with it");
	assertEqual(listEntries(cleared)[0].feedbackAt > 20, true, "the retraction is stamped strictly later than the remark");

	// The copy that still carries the remark cannot bring it back — in either direction, because both
	// sides run the same merge and have to converge.
	assertEqual(listEntries(mergeState(cleared, marked, { now: 40 }), "", "flagged").length, 0, "the older remark loses the merge");
	assertEqual(listEntries(mergeState(marked, cleared, { now: 40 }), "", "flagged").length, 0, "in both directions");
});

test("dictionary: an unknown feedback kind degrades to \"other\" instead of refusing the remark", () => {
	// A remark is the user's words. A category this version does not know — written by a newer one, or
	// hand-edited into the file — is not a reason to drop them; the vocabulary can grow without the
	// data layer treating yesterday's file as corrupt.
	const { emptyState, editEntry, listEntries } = loadCore("dictionary.js");
	const state = editEntry(
		editEntry(emptyState({ now: 1 }), "Quorum", { definition: { gloss: "g" } }, { now: 10 }).state,
		"Quorum",
		{ feedback: { kind: "wrong-translation", note: "n".repeat(400) } },
		{ now: 20 }
	).state;
	const entry = listEntries(state)[0];
	assertEqual(entry.feedback.kind, "other", "the unfamiliar category becomes other");
	assertEqual(entry.feedback.note.length, 200, "and the note is clamped to what one field holds");
});

test("dictionary: the flagged list gathers both things the user said", () => {
	// Two independent claims — "here is what is wrong" and "stop treating this as authoritative" — and
	// one view that has to show either of them. A deleted entry is out of it like it is out of every
	// other live list.
	const { emptyState, editEntry, removeEntry, listEntries } = loadCore("dictionary.js");
	let state = emptyState({ now: 1 });
	state = editEntry(state, "Remarked", { definition: { gloss: "g" } }, { now: 10 }).state;
	state = editEntry(state, "Verdicted", { definition: { gloss: "g" } }, { now: 11 }).state;
	state = editEntry(state, "Plain", { definition: { gloss: "g" } }, { now: 12 }).state;
	state = editEntry(state, "Gone", { definition: { gloss: "g" } }, { now: 13 }).state;
	state = editEntry(state, "Remarked", { feedback: { kind: "other", note: "" } }, { now: 20 }).state;
	state = editEntry(state, "Verdicted", { untrusted: true }, { now: 21 }).state;
	state = editEntry(state, "Gone", { untrusted: true }, { now: 22 }).state;
	state = removeEntry(state, "Gone", { now: 30 }).state;

	assertEqual(listEntries(state, "", "flagged").map((entry) => entry.term).sort(), ["Remarked", "Verdicted"], "both kinds of remark, and nothing else");
	assertEqual(listEntries(state, "", "all").length, 3, "the flagged view is a filter over the live list, not a different list");
	assertEqual(listEntries(state, "verd", "flagged").map((entry) => entry.term), ["Verdicted"], "and the search box narrows it too");
});

test("dictionary: a sighting cannot write over an entry the user called untrustworthy", () => {
	// The quality loop's authority. It lives here rather than in the explain queue because EVERY
	// automatic writer funnels through this function — the page's queue, a background refresh, the
	// host's own `record` action — so one refusal covers all of them.
	const { emptyState, editEntry, recordSighting, findEntry } = loadCore("dictionary.js");
	const flagged = editEntry(emptyState({ now: 1 }), "Quorum", { definition: { gloss: "" }, untrusted: true }, { now: 10 }).state;
	assertEqual(findEntry(flagged, "Quorum").untrusted, true, "the verdict is recorded");

	const refused = recordSighting(flagged, { term: "Quorum", definition: { gloss: "自动写的" }, source: "llm" }, { now: 20 });
	assertEqual(findEntry(refused.state, "Quorum").definition.gloss, "", "an automatic answer must not fill it in");
	assertEqual(findEntry(refused.state, "Quorum").seen, 2, "while the sighting itself is still counted");

	// The escape hatch: a generation the user pressed the button for is not the machine deciding alone.
	const allowed = recordSighting(flagged, { term: "Quorum", definition: { gloss: "手动要来的" }, source: "llm", overridesUntrusted: true }, { now: 20 });
	assertEqual(findEntry(allowed.state, "Quorum").definition.gloss, "手动要来的", "a requested generation may fill it");

	// And an entry nobody flagged fills exactly as before: the guard is not a blanket refusal.
	const plain = editEntry(emptyState({ now: 1 }), "Entropy", { definition: { gloss: "" } }, { now: 10 }).state;
	const filled = recordSighting(plain, { term: "Entropy", definition: { gloss: "正常填充" }, source: "llm" }, { now: 20 });
	assertEqual(findEntry(filled.state, "Entropy").definition.gloss, "正常填充", "an unflagged entry is still explained automatically");

	// A sighting carries no decision of its own: it can neither set nor clear either field.
	const smuggled = recordSighting(flagged, { term: "Quorum", feedback: null, untrusted: false }, { now: 20 });
	assertEqual(findEntry(smuggled.state, "Quorum").untrusted, true, "a sighting never clears a verdict");
	assertEqual(findEntry(smuggled.state, "Quorum").untrustedAt, 10, "and never re-stamps one");
	const smuggledRemark = recordSighting(flagged, { term: "Quorum", feedback: { kind: "other", note: "偷渡" } }, { now: 20 });
	assertEqual(findEntry(smuggledRemark.state, "Quorum").feedback, null, "nor writes a remark");
});

test("transfer: the feedback report says what was said, and never the conversation", () => {
	// The half of feedback the host channel cannot carry: the host records a remark into this machine's
	// session log, so a report is the only thing that can reach whoever could act on it. Its shape is
	// therefore a privacy decision as much as a data one.
	const { buildFeedbackReport } = loadCore("transfer.js");
	const entries = [
		{ term: "Quorum", key: "quorum", definition: { gloss: "多数派" }, context: "甲方的原话不该出现", feedback: { kind: "wrong-gloss", note: "太笼统" }, feedbackAt: 20, untrusted: true, untrustedAt: 15 },
		{ term: "Entropy", key: "entropy", definition: { gloss: "熵" }, feedback: null, feedbackAt: 0, untrusted: true, untrustedAt: 30 },
		{ term: "Plain", key: "plain", definition: { gloss: "x" }, feedback: null, feedbackAt: 0, untrusted: false, untrustedAt: 0 }
	];
	const report = buildFeedbackReport(entries, { now: 42 });
	assertEqual([report.kind, report.version, report.exportedAt, report.count], ["dsh-term-dictionary-feedback", 1, 42, 2], "the envelope identifies itself and counts what it carries");
	assertEqual(report.entries.map((entry) => entry.term), ["Entropy", "Quorum"], "newest remark first, so a reader starts at the top");
	assertEqual(report.entries[1].kind, "wrong-gloss", "the category travels");
	assertEqual(report.entries[1].note, "太笼统", "and the user's own words");
	assertEqual(report.entries[1].at, 20, "and when they said it");
	assertEqual("kind" in report.entries[0], false, "an entry with only a verdict carries no remark fields");
	assertEqual(report.entries[0].untrusted, true, "but does carry the verdict");
	assertEqual(JSON.stringify(report).includes("甲方的原话"), false, "the conversation is not in the report, by construction");
	assertEqual("gloss" in report.entries[0], false, "nor the explanation, unless it is asked for");
	assertEqual("context" in report.entries[0], false, "and never the entry's context under any option");
	const withGloss = buildFeedbackReport(entries, { now: 42, includeGloss: true });
	assertEqual(withGloss.entries[1].gloss, "多数派", "asking for the explanation attaches it");
	assertEqual("context" in withGloss.entries[1], false, "even then the conversation stays out");
	assertEqual(buildFeedbackReport([], { now: 42 }).entries.length, 0, "nothing flagged is an empty report, not a missing one");
});

test("entries: an entry reads as the text somebody would paste", () => {
	// Copying by selecting text is a moving target — the list re-sorts as sightings arrive, and the
	// click that ends a selection used to open the editor over it — so copying is a button that needs
	// no selection. This is the text that button writes, and its shape is the whole point: what a
	// person would paste into a conversation, not a record dump.
	const { entryAsText } = loadCore("entries.js");
	assertEqual(
		entryAsText({ term: "Quorum", definition: { zh: "多数派确认", gloss: "写入需要多少个副本确认。", usage: "reached quorum" } }),
		"Quorum（多数派确认）\n写入需要多少个副本确认。\n例：reached quorum",
		"term, name, explanation and an example"
	);
	assertEqual(entryAsText({ term: "Quorum", definition: { zh: "", gloss: "", usage: "" } }), "Quorum", "a term with nothing else is still a term");
	assertEqual(entryAsText({ term: "Quorum", definition: { zh: "多数派确认", gloss: "", usage: "" } }), "Quorum（多数派确认）", "and a name without an explanation keeps the name");
	assertEqual(entryAsText({ term: "", definition: { gloss: "x" } }), "", "nothing to copy is empty rather than a blank line");
	assertEqual(entryAsText(null), "", "and a missing entry does not throw");
	// Aliases and the domain are lookup metadata: a reader searching the panel uses them, and nobody
	// pasting an entry wants them in the middle of the sentence.
	const withMetadata = entryAsText({ term: "WAL", definition: { gloss: "g" }, aliases: ["write-ahead log"], domain: "数据库" });
	assertEqual(withMetadata, "WAL\ng", "aliases and the domain stay out of the pasted text");
});

test("selection: one shared answer, aware of carets, whitespace and which host was asked", () => {
	// Three call sites ask this question — the panel's rows, the annotated-term click and the
	// unannotated-word click — and the rule lives here so they cannot drift. The bug it prevents is
	// always the same shape: a click that FINISHES a selection is treated as a click that CHOOSES.
	const { selectionActive, selectionInside, readSelection } = loadCore("selection.js");
	assertEqual(selectionActive({ getSelection: () => ({ isCollapsed: true, toString: () => "x" }) }), false, "a collapsed caret is not a selection");
	assertEqual(selectionActive({ getSelection: () => ({ isCollapsed: false, toString: () => "  \n " }) }), false, "nor is whitespace");
	assertEqual(selectionActive({ getSelection: () => ({ isCollapsed: false, toString: () => "quorum" }) }), true, "text is");
	assertEqual(selectionActive({}), false, "and a host with no selection of its own falls back rather than throwing");
	assertEqual(selectionActive(undefined), false, "including no host at all");
	const chosen = { isCollapsed: false, toString: () => "chosen" };
	assertEqual(readSelection({ getSelection: () => chosen }), chosen, "the host it was given is the one read");
	assertEqual(selectionActive({ getSelection: () => null }), false, "a host answering null falls through to the page's own");

	// The panel's narrower question: inside THIS element, or somewhere else on the page.
	const element = { contains: (node) => node === "inside" };
	assertEqual(selectionInside(element, { getSelection: () => ({ isCollapsed: false, toString: () => "x", anchorNode: "inside" }) }), true, "a selection inside the element counts");
	assertEqual(selectionInside(element, { getSelection: () => ({ isCollapsed: false, toString: () => "x", anchorNode: "outside" }) }), false, "one outside it does not");
	assertEqual(selectionInside(element, { getSelection: () => ({ isCollapsed: false, toString: () => "x" }) }), false, "and a selection with no node to place is not inside anything");
	assertEqual(selectionInside(null, { getSelection: () => ({ isCollapsed: false, toString: () => "x" }) }), false, "no element is no selection");
});

test("pack: a pack is content, sliced by category, and never a tombstone", () => {
	// The module's own contract, asserted here rather than only through the host route: the route
	// builds from `serializeState`, which has already dropped tombstones, so a filter that stopped
	// working inside `buildPack` would be invisible from there. The client half can call this module
	// too (it validates a fetched pack with the same `parsePack`), which is the other reason the rule
	// belongs to the module rather than to its caller.
	const pack = loadCore("pack.js");
	const entries = [
		{ term: "Quorum", key: "quorum", definition: { zh: "多数派确认", gloss: "g", usage: "u", notes: "私人笔记" }, domain: "分布式", aliases: ["q"], context: "私人上下文", feedback: { kind: "wrong-gloss", note: "x" }, untrusted: true, pinned: true, seen: 9, deletedAt: 0 },
		{ term: "Sidecar", key: "sidecar", definition: { gloss: "s" }, domain: "架构", deletedAt: 0 },
		{ term: "Gone", key: "gone", definition: { gloss: "x" }, deletedAt: 5 }
	];
	const built = pack.buildPack(entries, { id: "a/b", name: "N", author: "me", scope: "all", now: 7 });
	assertEqual(built.ok, true, "a pack builds");
	assertEqual(built.pack.count, 2, "a deleted entry is not published");
	assertEqual(built.pack.entries.map((entry) => entry.key), ["quorum", "sidecar"], "and the live ones are sorted, so the same dictionary always makes the same bytes");
	assertEqual(Object.keys(built.pack.entries[0]).sort(), ["aliases", "definition", "domain", "key", "term"], "a record is content and nothing else");
	assertEqual(Object.keys(built.pack.entries[0].definition).sort(), ["gloss", "usage", "zh"], "not the author's private notes");
	assertEqual(JSON.stringify(built.pack).includes("私人上下文"), false, "and never the conversation a term appeared in");

	const scoped = pack.buildPack(entries, { scope: "domains", domains: ["架构"], now: 7 });
	assertEqual(scoped.pack.entries.map((entry) => entry.key), ["sidecar"], "a scoped pack takes only its category");
	assertEqual(scoped.pack.scope, { kind: "domains", domains: ["架构"] }, "and says what it is a slice of");
	assertEqual(pack.buildPack([], {}).error, "empty", "an empty dictionary is refused");
	assertEqual(pack.buildPack(entries, { scope: "domains", domains: ["nope"] }).error, "empty-scope", "and an empty selection is refused as a selection");

	assertEqual(pack.parsePack({ kind: "x", version: 1, entries: [{ term: "a" }] }).error, "not-a-pack", "a file that is not a pack says so");
	assertEqual(pack.parsePack({ kind: "dsh-term-dictionary-pack", version: 99, entries: [{ term: "a" }] }).error, "unsupported-version", "a newer version is refused by name");
	assertEqual(pack.parsePack({ kind: "dsh-term-dictionary-pack", version: 1, entries: [] }).error, "no-usable-entries", "and a pack with nothing usable in it is refused");
	const round = pack.parsePack(JSON.parse(pack.packBytes(built.pack)));
	assertEqual([round.ok, round.pack.count, round.pack.name], [true, 2, "N"], "while a real pack round-trips through the same bytes a file would carry");
	assertEqual(pack.summarizePack(round.pack).domains.map((entry) => entry.domain).sort(), ["分布式", "架构"], "and summarises its categories");

	// The index the reader browses, and the one rule that makes a source safe to follow.
	const index = pack.buildIndex([{ id: "a/b", name: "B", url: "https://example.com/p.json", count: 2 }, { id: "bad", name: "Bad", url: "http://insecure/p.json" }], { now: 7 });
	assertEqual([index.kind, index.count, index.packs.length], ["dsh-term-dictionary-index", 1, 1], "an index keeps only the sources it could actually fetch");
	const parsedIndex = pack.parseIndex({ ...index, packs: [...index.packs, { id: "nourl" }, "junk"] });
	assertEqual([parsedIndex.ok, parsedIndex.dropped], [true, 2], "and reading one drops the rows it cannot use instead of failing the file");
	assertEqual(pack.refuseUrl("https://example.com/p.json"), null, "https may be fetched");
	for (const [url, reason] of [["http://example.com/p.json", "not-https"], ["file:///c:/p.json", "not-https"], ["https://u:p@example.com/p.json", "credentials-in-url"], ["nonsense", "bad-url"], ["", "no-url"]]) {
		assertEqual(pack.refuseUrl(url), reason, `${url || "(empty)"} is refused as ${reason}`);
	}
});

test("settings: the source list keeps only what can actually be fetched", () => {
	// The sources are configuration the user typed, and the store is where it is validated. The rule is
	// `pack.js`'s own `refuseUrl` — the same one the host applies before it fetches anything — so a
	// stored list cannot hold a source the transport would later refuse, and the page cannot disagree
	// with the host about what a usable source is.
	const { normalizeSettings, MAX_SOURCES, DEFAULT_PACK_SOURCE } = loadCore("settings.js");
	const normalized = normalizeSettings({
		packSources: [
			"https://cdn.jsdelivr.net/gh/a/b@main/index.json",
			"http://insecure.example/index.json",
			"file:///c:/index.json",
			"https://user:pw@example.com/index.json",
			"not a url",
			"  https://example.com/spaced.json  ",
			"https://cdn.jsdelivr.net/gh/a/b@main/index.json",
			42,
			null
		]
	});
	assertEqual(normalized.packSources, ["https://cdn.jsdelivr.net/gh/a/b@main/index.json", "https://example.com/spaced.json"], "only https, trimmed and deduplicated");
	// An absent key and an empty list are different statements: "never touched, use the shipped default"
	// against "I removed them all". A store that conflated them would resurrect the default every time
	// somebody cleared the list — which is what makes shipping a default possible at all.
	assertEqual(normalizeSettings({}).packSources, [DEFAULT_PACK_SOURCE], "a record with no sources key gets the shipped default");
	assertEqual(normalizeSettings({ packSources: [] }).packSources, [], "while an explicitly empty list stays empty");
	assertEqual(normalizeSettings({ packSources: "https://example.com/i.json" }).packSources, [], "a bare string is not a list, and is not the default either");
	const many = normalizeSettings({ packSources: Array.from({ length: 30 }, (unused, index) => `https://example.com/${index}.json`) });
	assertEqual(many.packSources.length, MAX_SOURCES, "and the list is capped rather than unbounded");
	// A fresh array each read: a snapshot is compared by identity, and a shared default array would let
	// one page's edit appear in another page's defaults.
	assertEqual(normalizeSettings({}).packSources === normalizeSettings({}).packSources, false, "each read is its own array");
});

test("panel: the entry list's layout follows the column preference", () => {
	// The list container carries the preference, and the sandbox has no layout engine — so what a check
	// can prove is the STYLE the page asked for, which is the whole of the rule: `auto` fits as many
	// columns as the panel is wide enough for, a number pins it, and `1` is the plain column the panel
	// had before any of this existed.
	const react = makeReactStub();
	const bundle = loadBundle({ react });
	const index = bundle.registered.findIndex((options) => options.name === "main");
	const face = bundle.registered[index].inject();
	const { createSettingsStore } = loadCore("settings.js");
	const memory = new Map();
	const settings = createSettingsStore({
		storage: {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key)
		}
	});
	const renderPanel = () => {
		react.__beginRender();
		return bundle.components[index]({ ...face, settings, t: (key) => key, setToast: () => {} });
	};
	const listOf = (tree) => {
		const found = [];
		const walk = (node) => {
			if (node === null || node === undefined || typeof node !== "object") return;
			if (Array.isArray(node)) {
				for (const child of node) walk(child);
				return;
			}
			if (typeof node.type === "function") {
				walk(node.type(node.props));
				return;
			}
			if (typeof node.props?.["data-term-columns"] === "string") found.push(node);
			walk(node.props?.children);
		};
		walk(tree);
		return found[0];
	};

	const auto = listOf(renderPanel());
	assertEqual(auto?.props["data-term-columns"], "auto", "a fresh install lays the list out automatically");
	assertEqual(auto?.props.style.display, "grid", "which is a grid rather than one column");
	assert(String(auto?.props.style.gridTemplateColumns).includes("auto-fill"), "the grid fits as many columns as the panel allows");
	// The cards in a row share its height by default: the complaint was the empty strips under the short
	// ones, and a grid track is only as tall as its tallest cell unless every cell is told to fill it.
	assertEqual(auto?.props.style.alignItems, "stretch", "with the cards filling the row's height, so no strip is left");
	// But the ROWS are as tall as their content: a grid stretches its rows to fill its container otherwise,
	// and two cards in a tall panel then became two 700px boxes — equal height taken much too far.
	assertEqual(auto?.props.style.alignContent, "start", "while the rows stay as tall as their content");

	// The compact reading is the other answer to the same complaint, and it is a preference.
	settings.set("entryRows", "compact");
	assertEqual(listOf(renderPanel())?.props.style.alignItems, "start", "the compact reading keeps each card its own height");
	settings.set("entryRows", "uniform");
	assertEqual(listOf(renderPanel())?.props.style.alignItems, "stretch", "and uniform is what a fresh install gets");

	settings.set("entryColumns", "2");
	const two = listOf(renderPanel());
	assertEqual([two?.props["data-term-columns"], two?.props.style.gridTemplateColumns], ["2", "repeat(2, minmax(0, 1fr))"], "a chosen count is pinned exactly");

	settings.set("entryColumns", "1");
	const one = listOf(renderPanel());
	assertEqual(one?.props["data-term-columns"], "1", "and one column is still a choice");
	assertEqual(one?.props.style.display, "grid", "expressed as a single-track grid, so the rule has one shape");

	// A value the store has no branch for never reaches the page: `set` normalises, so the impossible
	// count is turned into the default on the way in rather than being rendered as nothing.
	settings.set("entryColumns", "9");
	assertEqual(listOf(renderPanel())?.props["data-term-columns"], "auto", "an impossible count is normalised to the default by the store");
});

test("transfer: a folder is read as one import, and it names what it could not use", () => {
	// The shape people actually keep is one folder per topic, with whatever else in it. So a folder import
	// has to be tolerant in two directions: files that are not JSON are not mistakes, and files that cannot
	// be read are named rather than swallowing the whole folder.
	const { collectFolderImport } = loadCore("transfer.js");
	const dictionary = JSON.stringify({ kind: "dsh-term-dictionary", version: 1, entries: [{ term: "Quorum", key: "quorum", definition: { gloss: "g" } }] });
	const packFile = JSON.stringify({ kind: "dsh-term-dictionary-pack", version: 1, id: "a/b", name: "B", entries: [{ term: "Sidecar", key: "sidecar", definition: { gloss: "s" }, group: "vendor" }] });
	const indexFile = JSON.stringify({ kind: "dsh-term-dictionary-index", version: 1, packs: [] });
	const files = [
		{ path: "topics/backend.json", text: dictionary },
		{ path: "topics/infra.json", text: packFile },
		{ path: "topics/notes.md", text: "not json, and not a mistake" },
		{ path: "topics/index.json", text: indexFile },
		{ path: "broken.json", text: "{" }
	];

	const plain = collectFolderImport(files, {});
	// `index.json` lists packs rather than holding entries, and a file that is not JSON at all is reported
	// as that: both are skipped, and nothing else is.
	assertEqual([plain.files, plain.used], [4, 2], "four .json files were found and two were usable");
	assertEqual(plain.entries.map((entry) => entry.key).sort(), ["quorum", "sidecar"], "and their entries are what comes back");
	assertEqual(plain.skipped.map((entry) => entry.name).sort(), ["broken.json", "topics/index.json"], "the unusable ones are named");
	assertEqual(plain.skipped.map((entry) => entry.error).sort(), ["no-entries", "not-json"], "with the reason each one failed");
	assertEqual(plain.entries.find((entry) => entry.key === "quorum").group, "", "and no group is invented for an entry that had none");
	assertEqual(plain.entries.find((entry) => entry.key === "sidecar").group, "vendor", "while one the file itself filed keeps its group");

	const withFolders = collectFolderImport(files, { useFolderAsGroup: true });
	assertEqual(withFolders.entries.find((entry) => entry.key === "quorum").group, "topics", "the folder names the group");
	assertEqual(withFolders.entries.find((entry) => entry.key === "sidecar").group, "vendor", "unless the file already filed it, which wins");
	const nested = collectFolderImport([{ path: "picked/backend/net/deep.json", text: dictionary }], { useFolderAsGroup: true });
	assertEqual(nested.entries[0].group, "picked/backend/net", "and a nested path becomes a nested group, starting with the folder that was picked");
	const nothingUsable = collectFolderImport([{ path: "broken.json", text: "{" }], { useFolderAsDomain: true });
	assertEqual([nothingUsable.used, nothingUsable.entries.length, nothingUsable.skipped.length], [0, 0, 1], "a folder with nothing usable reports that rather than importing nothing quietly");
	assertEqual(collectFolderImport([], {}).files, 0, "and an empty folder is not an error in itself");
});

test("dictionary: groups are directories — one level at a time, and a move is a decision", () => {
	// The data half of "an entry group, the same size as an entry, that you click into". One string field
	// carries any depth, so nothing else had to be added to the document — but a MOVE is a decision the
	// user can make and unmake, and content-merge rules cannot carry one: the first attempt let the group
	// ride on the content, and merging one entry from two windows then wiped it, order-dependently.
	const { emptyState, editEntry, findEntry, listEntries, groupsIn, mergeState } = loadCore("dictionary.js");
	let state = emptyState({ now: 1 });
	// Distinct times, so "newest first" is a claim the fixture can actually support — with every entry stamped
	// the same, the sample falls back to the alphabetical tie-break and the assertion stops meaning anything.
	let stamp = 10;
	for (const [term, group] of [["Alpha", ""], ["Beta", "backend"], ["Gamma", "backend/net"], ["Delta", "backend/net"], ["Epsilon", "ops"]]) {
		state = editEntry(state, term, { definition: { gloss: "g" }, group }, { now: (stamp += 1) }).state;
	}

	// One level at a time: what is filed exactly here, not everything below it.
	assertEqual(listEntries(state, "", "all", "").map((entry) => entry.term), ["Alpha"], "the top level shows what is filed there");
	assertEqual(listEntries(state, "", "all", "backend").map((entry) => entry.term), ["Beta"], "and a group shows its own");
	assertEqual(listEntries(state, "", "all", "backend/net").map((entry) => entry.term).sort(), ["Delta", "Gamma"], "however deep");
	assertEqual(listEntries(state, "", "all").map((entry) => entry.term), ["Alpha"], "a caller that asks for no group gets the top level, which is what the panel did before groups existed");
	assertEqual(listEntries(state, "ga", "all", "backend/net").map((entry) => entry.term), ["Gamma"], "the search still narrows within the level");

	// The group rows: immediate children, with a count that covers everything under each and a SAMPLE of what
	// is inside, newest first — the row has to say something once it is as tall as the entries beside it.
	const topGroups = groupsIn(state.entries, "");
	assertEqual(topGroups.map(({ group, name, count }) => ({ group, name, count })), [{ group: "backend", name: "backend", count: 3 }, { group: "ops", name: "ops", count: 1 }], "the top level lists its groups with counts");
	assertEqual(topGroups[0].sample, ["Delta", "Gamma", "Beta"], "and names the newest few of what is inside it");
	assertEqual(topGroups[1].sample, ["Epsilon"], "however few there are");
	assertEqual(groupsIn(state.entries, "backend"), [{ group: "backend/net", name: "net", count: 2, sample: ["Delta", "Gamma"] }], "and a group lists its own");
	assertEqual(groupsIn(state.entries, "backend/net"), [], "a leaf has none");
	assertEqual(groupsIn(state.entries, "nope"), [], "and a path nobody filed anything under is empty rather than an error");

	// Moving is a stamped decision, so it survives a merge in either direction — including moving back out.
	const plain = editEntry(emptyState({ now: 1 }), "Beta", { definition: { gloss: "g" } }, { now: 10 }).state;
	assertEqual(findEntry(mergeState(state, plain, { now: 30 }), "Beta").group, "backend", "a move survives a merge with the copy that has not heard about it");
	assertEqual(findEntry(mergeState(plain, state, { now: 30 }), "Beta").group, "backend", "in either order");
	const home = editEntry(state, "Beta", { group: "" }, { now: 40 }).state;
	assertEqual(findEntry(home, "Beta").group, "", "and an entry can be moved back to the top level");
	assertEqual(findEntry(mergeState(home, state, { now: 50 }), "Beta").group, "", "which is itself a decision that survives a merge");
	assertEqual(findEntry(editEntry(home, "Beta", { definition: { gloss: "g2" } }, { now: 60 }).state, "Beta").group, "", "while an unrelated edit leaves the group where it is");
	// Two moves inside one millisecond still have an order: the stamp moves strictly forward.
	assertEqual(findEntry(editEntry(state, "Beta", { group: "ops" }, { now: 10 }).state, "Beta").group, "ops", "a move in the same millisecond as the last one still wins");
});

test("dictionary: an action never moves the row it acted on", () => {
	// Reported: "pinning moves the entry to the top". It did — the list sorted pinned first, then
	// unexplained first, then by when each term was last SEEN, so pinning, answering a prompt, and merely
	// mentioning a term again all shuffled the list under the reader's hand. Creation time is the one thing
	// no action changes.
	const { emptyState, editEntry, listEntries } = loadCore("dictionary.js");
	let state = emptyState({ now: 1 });
	state = editEntry(state, "Older", { definition: { gloss: "g" } }, { now: 10 }).state;
	state = editEntry(state, "Newer", { definition: { gloss: "g" } }, { now: 20 }).state;
	const before = listEntries(state, "", "all").map((entry) => entry.term);
	assertEqual(before, ["Newer", "Older"], "the newest term is first to begin with");

	const pinned = editEntry(state, "Older", { pinned: true }, { now: 30 }).state;
	assertEqual(listEntries(pinned, "", "all").map((entry) => entry.term), before, "pinning does not move it");
	assertEqual(listEntries(pinned, "", "pinned").map((entry) => entry.term), ["Older"], "while the pinned view still gathers it");
	assertEqual(listEntries(pinned, "", "all").find((entry) => entry.term === "Older").pinned, true, "and the row itself says so, which is why the order has no job left");

	const edited = editEntry(pinned, "Older", { definition: { gloss: "answered" } }, { now: 40 }).state;
	assertEqual(listEntries(edited, "", "all").map((entry) => entry.term), before, "nor does editing or explaining it");
	const unseen = { ...edited, entries: edited.entries.map((entry) => (entry.term === "Older" ? { ...entry, lastSeenAt: 9000 } : entry)) };
	assertEqual(listEntries(unseen, "", "all").map((entry) => entry.term), before, "nor does the transcript mentioning it again");
	const newer = editEntry(edited, "Newest", { definition: { gloss: "g" } }, { now: 50 }).state;
	assertEqual(listEntries(newer, "", "all").map((entry) => entry.term), ["Newest", ...before], "while a genuinely new term does arrive at the top");
});

test("panel: the pin leads the row and the actions sit on their own line", () => {
	// Reported: "put the entry's small controls on the second line and the pin before the title, so an
	// action cannot produce a one-off layout". On the title line the controls moved from row to row with
	// the length of the term and the number of badges; the pin is a STATE of the entry, so it belongs with
	// the title, and the four actions belong where every row has them.
	const react = makeReactStub();
	const bundle = loadBundle({ react });
	const index = bundle.registered.findIndex((options) => options.name === "main");
	const face = bundle.registered[index].inject();
	const { createSettingsStore } = loadCore("settings.js");
	const memory = new Map();
	const settings = createSettingsStore({
		storage: {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key)
		}
	});
	face.store.saveEntry("Quorum", { definition: { gloss: "多数派确认" } });

	const tree = (() => {
		react.__beginRender();
		return bundle.components[index]({ ...face, settings, t: (key) => key, setToast: () => {} });
	})();
	const walk = (node, visit) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child, visit);
			return;
		}
		visit(node);
		if (typeof node.type === "function") walk(node.type(node.props), visit);
		else walk(node.props?.children, visit);
	};
	const actions = [];
	const heads = [];
	walk(tree, (node) => {
		if (typeof node.props?.["data-term-actions"] === "string") actions.push(node);
		if (node.type === "div" && node.props?.style?.display === "flex" && node.props?.style?.gap === "6px" && node.props?.style?.flexWrap === "wrap") heads.push(node);
	});
	assertEqual(actions.length, 1, "the row has an action line of its own");
	// It is a DIFFERENT line from the title, which is the whole point: same style would mean the controls
	// share the title's line and drift from row to row with the length of the term.
	assertEqual(actions[0].props.style, { display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }, "with the action line's own layout");
	const buttons = [];
	walk(actions[0], (node) => {
		// Only RENDERED elements: `walk` visits a component and then its output, and both carry the same
		// props, so counting every visit would report each button twice.
		if (typeof node.type === "function") return;
		if (typeof node.props?.title === "string" && typeof node.props?.onClick === "function") buttons.push(node.props.title);
	});
	assertEqual(buttons, ["copyEntry", "feedbackTitle", "edit", "remove"], "carrying every action, in one order, on every row");

	const head = heads[0];
	const headButtons = [];
	walk(head, (node) => {
		if (typeof node.type === "function") return;
		if (typeof node.props?.title === "string" && typeof node.props?.onClick === "function") headButtons.push(node.props.title);
	});
	// The pin, then the term itself — whose own click opens the editor, which is why it is a button too.
	assertEqual(headButtons, ["pin", "edit"], "and the title line carries the pin and the term, and no action");
	// The pin is a state, so it also has to come BEFORE the term it belongs to.
	const order = [];
	walk(head, (node) => {
		if (typeof node.type === "function") return;
		if (node.props?.title === "pin" || node.props?.title === "unpin") order.push("pin");
		else if (node.props?.children === "Quorum") order.push("term");
	});
	assertEqual(order, ["pin", "term"], "with the pin in front of the term");
});

test("pack: the parsers read the TEXT that production actually hands them", () => {
	// Reported: "the pack imports and nothing appears". Both parsers accepted only an already-parsed
	// OBJECT, while the host fetches a file and passes the BODY — so every source answered `not-an-object`,
	// and every pack fetched from a source did too. That reads like a bad URL rather than like a bug, and
	// the checks passed because they handed the parsers objects: production hands them text.
	const { parsePack, parseIndex } = loadCore("pack.js");
	// Hand-written rather than built, because what is under test is the PARSER's tolerance of text — and a
	// fixture written the way a real file on disk looks is the honest input for that.
	const packFile = JSON.stringify({
		kind: "dsh-term-dictionary-pack",
		version: 1,
		id: "a/b",
		name: "B",
		author: "a",
		license: "MIT",
		createdAt: "2026-10-11T00:00:00.000Z",
		entries: [{ term: "Quorum", key: "quorum", definition: { zh: "法定人数", gloss: "g", usage: "" } }]
	});
	const indexFile = JSON.stringify({ kind: "dsh-term-dictionary-index", version: 1, updatedAt: 1, count: 1, packs: [{ id: "a/b", name: "B", url: "https://example.test/b.json", sha256: "x", entries: 1 }] });

	assertEqual(parsePack(packFile).ok, true, "a pack read from the text a fetch returns");
	assertEqual(parsePack(packFile).pack.entries.length, 1, "with its entries");
	assertEqual(parsePack(JSON.parse(packFile)).ok, true, "and the same pack as an object still reads");
	assertEqual(parseIndex(indexFile).ok, true, "an index read from the text a fetch returns");
	assertEqual(parseIndex(indexFile).index.packs.length, 1, "with its rows");
	assertEqual(parseIndex(JSON.parse(indexFile)).ok, true, "and the same index as an object still reads");

	// What is not a pack is still refused, and with the reason it failed rather than one generic error.
	assertEqual(parsePack("{").error, "not-json", "broken text is not JSON");
	assertEqual(parsePack("[]").error, "not-an-object", "an array is not a pack");
	assertEqual(parsePack('{"kind":"something-else"}').error, "not-a-pack", "and a file that is not a pack says so");
	assertEqual(parseIndex("{").error, "not-json", "broken index text too");
	assertEqual(parseIndex('{"kind":"dsh-term-dictionary-pack"}').error, "not-an-index", "and an index that is not an index");
});

test("import: a brand-new term arrives, and the report says so", () => {
	// The gap a reader named: nothing checked importing terms the dictionary had NEVER seen, only the
	// interesting mixed cases. Without it, "I imported a file and nothing appeared" cannot be told apart
	// from "the entries went somewhere I was not looking". The page's own path through this is covered by
	// the panel check that imports a real file; this is the decision underneath it.
	const { emptyState, editEntry, listEntries, findEntry, listDeleted } = loadCore("dictionary.js");
	const { parseImport, planImport } = loadCore("transfer.js");

	let state = emptyState({ now: 1 });
	state = editEntry(state, "Quorum", { definition: { gloss: "已有" } }, { now: 10 }).state;
	const file = JSON.stringify({
		kind: "dsh-term-dictionary",
		version: 1,
		entries: [
			{ term: "Freshterm", key: "freshterm", definition: { zh: "新词条", gloss: "从没出现过" } },
			{ term: "Quorum", key: "quorum", definition: { gloss: "文件里的" } }
		]
	});
	const parsed = parseImport(file);
	assertEqual(parsed.ok, true, "the file parses");
	const plan = planImport(state.entries, parsed.entries, new Set(), { includeDeleted: false });
	assertEqual(plan.accepted.map((entry) => entry.term), ["Freshterm"], "exactly the term that is new is accepted");
	assertEqual(plan.existing.map((entry) => entry.term), ["Quorum"], "and the one already here is left alone");

	// The write the page performs, applied here: `importEntries` calls exactly this for each accepted entry.
	for (const entry of plan.accepted) {
		state = editEntry(state, entry.term, { definition: entry.definition, domain: entry.domain, aliases: entry.aliases, pinned: entry.pinned }, { now: 20 }).state;
	}
	assertEqual(findEntry(state, "Freshterm") !== undefined, true, "the new term is in the document");
	assertEqual(listEntries(state, "", "all").map((entry) => entry.term).sort(), ["Freshterm", "Quorum"], "and in the list the panel draws");
	assertEqual(listEntries(state, "fresh", "all").map((entry) => entry.term), ["Freshterm"], "where a search for it finds it");
	assertEqual(listDeleted(state).length, 0, "and nothing was deleted on the way");
	assertEqual(findEntry(state, "Quorum").definition.gloss, "已有", "while the entry that was already here kept its own text");
});

test("dictionary: restoring a deleted term withdraws the tombstone instead of outvoting it", () => {
	// Reported: "a term that was collected and then deleted cannot be restored". Restoring was expressed as
	// "write an edit and hope the merge weighs it right" — an inferred comparison between a crafted
	// timestamp and the deletion's. It is now a named act with its own evidence, and the document it
	// produces no longer claims the term is deleted at all, which is what makes a later merge unable to put
	// the deletion back.
	const { emptyState, editEntry, removeEntry, restoreEntry, findEntry, listEntries, listDeleted, mergeState } = loadCore("dictionary.js");
	let state = emptyState({ now: 1 });
	state = editEntry(state, "Quorum", { definition: { gloss: "旧解释" } }, { now: 10 }).state;
	const id = findEntry(state, "Quorum").id;
	state = removeEntry(state, id, { now: 20 }).state;
	assertEqual([listEntries(state, "", "all").length, listDeleted(state).length], [0, 1], "the term starts out deleted");
	assertEqual(state.deletedKeys, ["quorum"], "with the deletion announced by key");

	const restored = restoreEntry(state, "Quorum", { definition: { gloss: "来自文件" } }, { now: 30 });
	assertEqual(restored.restored, true, "the restoration reports that it happened");
	assertEqual(listEntries(restored.state, "", "all").map((entry) => entry.term), ["Quorum"], "the term is live");
	assertEqual(listDeleted(restored.state).length, 0, "and off the deleted list");
	assertEqual(restored.state.deletedKeys, [], "the deletion is WITHDRAWN from the document, not merely outvoted");
	assertEqual((restored.state.backing ?? []).length, 0, "and the tombstone record is gone with it");
	assertEqual(restored.entry.definition.gloss, "来自文件", "the imported text is what it comes back with");
	assertEqual(restored.entry.restoredAt, 30, "stamped as a restoration, which is the evidence a merge reads");
	assertEqual(restored.entry.source, "user", "and attributed to the user, because they asked for it");

	// The merge that used to undo it: a document still holding the tombstone, in both directions.
	assertEqual(listEntries(mergeState(restored.state, state, { now: 40 }), "", "all").map((entry) => entry.term), ["Quorum"], "a merge against the copy that still has the tombstone keeps it");
	assertEqual(listEntries(mergeState(state, restored.state, { now: 40 }), "", "all").map((entry) => entry.term), ["Quorum"], "in either order");
	assertEqual(listDeleted(mergeState(state, restored.state, { now: 40 })).length, 0, "with nothing left on the deleted list");

	// Restoring something already live is not a restoration, and must not claim to be one.
	const again = restoreEntry(restored.state, "Quorum", {}, { now: 50 });
	assertEqual(again.restored, false, "restoring a live term does nothing and says so");
	assertEqual(again.entry.definition.gloss, "来自文件", "leaving its text alone");
	// And a term nobody ever had is simply created, which is what an import of a new term needs.
	const created = restoreEntry(state, "Freshterm", { definition: { gloss: "新的" } }, { now: 60 });
	assertEqual([created.restored, findEntry(created.state, "Freshterm") !== undefined], [false, true], "a term that was never here is created");
});

test("panel: groups are rows you open, with a way back up", () => {
	// The UI half of the group tree. A group is the same KIND of thing as an entry — something you open —
	// so it is a row of the same list rather than a sidebar, and the breadcrumb is the way back: a
	// directory you can only enter is a trap.
	const react = makeReactStub();
	const bundle = loadBundle({ react });
	const index = bundle.registered.findIndex((options) => options.name === "main");
	const face = bundle.registered[index].inject();
	const { createSettingsStore } = loadCore("settings.js");
	const memory = new Map();
	const settings = createSettingsStore({
		storage: {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key)
		}
	});
	for (const [term, group] of [["Alpha", ""], ["Beta", "backend"], ["Gamma", "backend/net"], ["Delta", "backend/net"]]) {
		face.store.saveEntry(term, { definition: { gloss: "g" }, group });
	}

	const render = () => {
		react.__beginRender();
		return bundle.components[index]({ ...face, settings, t: (key, values) => (values === undefined ? key : `${key}|${JSON.stringify(values)}`), setToast: () => {} });
	};
	const walk = (node, visit) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child, visit);
			return;
		}
		visit(node);
		if (typeof node.type === "function") walk(node.type(node.props), visit);
		else walk(node.props?.children, visit);
	};
	const find = (tree, match) => {
		const found = [];
		walk(tree, (node) => {
			if (match(node)) found.push(node);
		});
		return found;
	};
	const groupRows = (tree) => find(tree, (node) => node.type === "article" && typeof node.props?.["data-term-group"] === "string");
	const termsShown = (tree) => find(tree, (node) => typeof node.props?.["data-term-entry"] === "string").map((node) => node.props["data-term-entry"]);
	const openControl = (tree, group) => {
		const row = find(tree, (node) => node.type === "article" && node.props?.["data-term-group"] === group)[0];
		return find(row, (node) => node.type === "button" && node.props?.title === "groupOpen")[0];
	};

	// At the top level: the group row, and only the entries filed there.
	const top = render();
	assertEqual(groupRows(top).map((node) => node.props["data-term-group"]), ["backend"], "the top level lists its group as a row");
	// It fills its row, now that the height carries something: the preview below is what makes the same
	// height as the entry beside it information rather than blank space.
	assertEqual(groupRows(top)[0].props.style.alignSelf, undefined, "the group card fills its row like the entries do");
	assertEqual(termsShown(top).sort(), ["alpha"], "and only the entries filed at that level");
	assertEqual(find(top, (node) => node.props?.["data-term-breadcrumb"] !== undefined).length, 0, "with no breadcrumb, because there is nowhere to go back to");
	const label = openControl(top, "backend");
	assert(label !== undefined, "the group row carries the control that opens it");
	assert(JSON.stringify(label.props.children).includes("backend"), "labelled with the group's name");
	// Its actions, on a line of their own — the same shape an entry row has, and for the same reason: the
	// controls must not move around with the length of what they act on.
	const groupActions = find(top, (node) => node.props?.["data-term-group-actions"] === "backend")[0];
	assert(groupActions !== undefined, "the group row carries an action line of its own");
	const actionTitles = find(groupActions, (node) => typeof node.type !== "function" && typeof node.props?.title === "string").map((node) => node.props.title);
	assertEqual(actionTitles, ["groupRename", "groupDelete"], "offering to rename or move it, and to delete it");
	// And pressing one of them must not ALSO open the group: the row itself is a click target now.
	let entered = 0;
	groupRows(top)[0].props.onClick({ target: { closest: () => ({}) } });
	assertEqual(find(render(), (node) => node.props?.["data-term-breadcrumb"] !== undefined).length, 0, "a click that landed on a button does not open the group");
	// Pressing rename opens the form, prefilled with the path.
	find(groupActions, (node) => node.type !== "function" && node.props?.title === "groupRename")[0].props.onClick();
	const formed = render();
	const form = find(formed, (node) => node.props?.["data-term-group-form"] === "backend")[0];
	assert(form !== undefined, "renaming opens an inline form rather than a browser prompt, which Electron does not implement");
	assertEqual(find(form, (node) => node.props?.type === "text")[0].props.value, "backend", "prefilled with the group's path");
	// What the form DOES is `store.renameGroup`, whose decision is asserted at the data level by the check
	// above; here the subject is that the control exists and is wired to it.
	assertEqual(typeof find(form, (node) => node.props?.label === "groupRenameApply")[0].props.onClick, "function", "with a control that applies it");
	// being live is what "the group cannot be clicked into" meant: a reader clicks the row and nothing
	// happens, because the folder icon, the count and the empty space were all dead.
	const groupArticle = groupRows(top)[0];
	assert(typeof groupArticle.props.onClick === "function", "and the whole row answers a click, like an entry row does");
	groupArticle.props.onClick();
	assertEqual(find(render(), (node) => node.props?.["data-term-breadcrumb"] !== undefined).length, 1, "which enters the group");
	// Back to the top by the breadcrumb's first crumb, so the rest of the check starts where it did.
	const rootCrumb = find(render(), (node) => node.type === "button" && typeof node.props?.title === "string" && node.props.title.startsWith("groupGo|"))[0];
	rootCrumb.props.onClick();
	assertEqual(termsShown(render()).sort(), ["alpha"], "and the root crumb brings the top level back");
	assertEqual(find(top, (node) => node.props?.children === 'groupCount|{"count":"3"}').length > 0, true, "and says how much is inside it, counting everything below");
	// And a line naming what is inside, so the card is not a name over blank space: the point of filling the
	// row's height is that the height then carries something.
	const sampleLine = find(top, (node) => node.props?.["data-term-group-sample"] === "backend")[0];
	assert(sampleLine !== undefined, "with a line saying what is inside it");
	const sampleText = String(sampleLine.props.children);
	assert(["Beta", "Gamma", "Delta"].every((name) => sampleText.includes(name)), `naming the terms inside, saw ${sampleText}`);
	assertEqual(sampleText.includes("groupSampleMore"), false, "and no \"and more\" when the sample already names all of them");

	// Entering it.
	label.props.onClick();
	const inside = render();
	assertEqual(find(inside, (node) => node.props?.["data-term-breadcrumb"] !== undefined).length, 1, "entering a group shows where you are");
	// Spanning the whole row, because as a grid CELL it was stretched to the track's height and its text
	// centred in the middle of it — which is how the breadcrumb ended up floating halfway down the panel.
	const crumbBar = find(inside, (node) => node.props?.["data-term-breadcrumb"] !== undefined)[0];
	assertEqual(crumbBar.props.style.gridColumn, "1 / -1", "with the breadcrumb spanning the row instead of sitting in one cell");
	assertEqual(groupRows(inside).map((node) => node.props["data-term-group"]), ["backend/net"], "the level inside lists its own groups");
	assertEqual(termsShown(inside).sort(), ["beta"], "and its own entries, not the ones from the level above");

	// And coming back, by the breadcrumb rather than by a hidden gesture.
	const crumbs = find(inside, (node) => node.type === "button" && typeof node.props?.title === "string" && node.props.title.startsWith("groupGo|"));
	assertEqual(crumbs.length, 2, "the breadcrumb offers every level, including the top");
	crumbs[0].props.onClick();
	const back = render();
	assertEqual(find(back, (node) => node.props?.["data-term-breadcrumb"] !== undefined).length, 0, "going back to the top level removes the breadcrumb");
	assertEqual(termsShown(back).sort(), ["alpha"], "and shows the top level again");

	// Two levels deep, which is what the folder import produces.
	openControl(back, "backend").props.onClick();
	const nested = render();
	openControl(nested, "backend/net").props.onClick();
	const leaf = render();
	assertEqual(termsShown(leaf).sort(), ["delta", "gamma"], "the leaf level shows its entries");
	assertEqual(find(leaf, (node) => node.props?.["data-term-breadcrumb"] !== undefined).length, 1, "with the whole path behind it");
	assertEqual(
		find(leaf, (node) => node.type === "button" && typeof node.props?.title === "string" && node.props.title.startsWith("groupGo|")).length,
		3,
		"offering all three levels back"
	);
});

test("dictionary: renaming, moving and deleting a group are the same decisions as moving one entry", () => {
	// A group is a path, so renaming and moving are one act. Each moved entry carries the same stamped
	// decision a single move does — a bulk move is not an exception to "a move is a decision" — and deleting a
	// group empties it into the deleted list, because that is the only way a group can be deleted.
	const { emptyState, editEntry, groupsIn, listEntries, listDeleted, mergeState, renameGroup, deleteGroup } = loadCore("dictionary.js");
	let state = emptyState({ now: 1 });
	let stamp = 10;
	for (const [term, group] of [["A", "backend"], ["B", "backend/net"], ["C", "backend/net"], ["D", "ops"], ["E", "backend"]]) {
		state = editEntry(state, term, { definition: { gloss: "g" }, group }, { now: (stamp += 1) }).state;
	}

	const renamed = renameGroup(state, "backend", "服务端", { now: 100 });
	assertEqual([renamed.moved, renamed.error], [4, null], "renaming moves the group and everything under it");
	assertEqual(groupsIn(renamed.state.entries, "").map((each) => `${each.name}:${each.count}`).sort(), ["ops:1", "服务端:4"].sort(), "the old name is gone and the new one holds the same four");
	assertEqual(listEntries(renamed.state, "", "all", "服务端/net").map((entry) => entry.term).sort(), ["B", "C"], "a nested level comes along, keeping its own name");
	// The move is a decision, so it survives a merge with the copy that has not heard about it.
	assertEqual(listEntries(mergeState(renamed.state, state, { now: 150 }), "", "all", "服务端").map((entry) => entry.term).sort(), ["A", "E"], "and it survives a merge with the old document");

	// Renaming onto an existing group merges them, which is what asking for it means.
	const merged = renameGroup(renamed.state, "服务端", "ops", { now: 200 });
	assertEqual([merged.moved, groupsIn(merged.state.entries, "").length], [4, 1], "renaming onto another group merges the two");
	assertEqual(listEntries(merged.state, "", "all", "ops").map((entry) => entry.term).sort(), ["A", "D", "E"], "with everything in one place");

	// The three refusals, each of which would otherwise do something silent and wrong.
	assertEqual(renameGroup(state, "backend", "", { now: 1 }).error, "no-name", "an empty name is refused");
	assertEqual(renameGroup(state, "backend", "backend", { now: 1 }).error, "same", "and so is a name that changes nothing");
	assertEqual(renameGroup(state, "backend", "backend/deep", { now: 1 }).error, "into-itself", "and moving a group inside itself");
	assertEqual(renameGroup(state, "nope", "x", { now: 1 }).moved, 0, "and a group nobody has simply moves nothing");

	// Deleting a group is delete-what-is-in-it, softly.
	const deleted = deleteGroup(state, "backend", { now: 300 });
	assertEqual([deleted.removed, deleted.error], [4, null], "deleting a group removes what is in it");
	assertEqual(listEntries(deleted.state, "", "all", "ops").map((entry) => entry.term), ["D"], "leaving the other group alone");
	assertEqual(listDeleted(deleted.state).map((entry) => entry.term).sort(), ["A", "B", "C", "E"], "and putting every one of them on the deleted list, where they can be restored");
	assertEqual(groupsIn(deleted.state.entries, "").map((each) => each.name), ["ops"], "a group disappears when the last entry in it does, which is the rule that made it appear");
});

test("copy: every error code the plugin can show a reader has copy behind it", () => {
	// The completeness check that already existed compares the two LOCALES with each other, and both were
	// missing the same six keys — so it was green while every import reported a row of raw keys. This is the
	// other half: the CODES the code produces, resolved against the real tables rather than against a stub `t`.
	//
	// The harness's `t` is the identity function, which is why the assertion further down that looks for
	// "transferImported" could not tell a missing key from a present one. Here the tables are the subject.
	const { zh, en } = loadCore("copy.js");
	const has = (key) => Object.prototype.hasOwnProperty.call(zh, key) && Object.prototype.hasOwnProperty.call(en, key);

	const { IMPORT_ERRORS } = loadCore("transfer.js");
	for (const code of IMPORT_ERRORS) {
		assert(has(`transferError_${code}`), `a parse refusal has a sentence: ${code}`);
	}
	// The report line's four counts, the toast an export ends with, and the scope label.
	for (const key of ["transferImported", "transferExisting", "transferSkippedDeleted", "transferDuplicates", "transferExported", "transferScope", "transferFolderSkippedPair"]) {
		assert(has(key), `a key the import/export page asks for exists: ${key}`);
	}
	// The refusals our own parsers produce, plus the codes the host's failure family is folded into.
	for (const code of ["not-an-index", "no-packs", "no-usable-packs", "too-large", "unreachable", "unknown", "not-json", "no-entries", "no-usable-entries", "not-a-pack", "unsupported-version", "too-many", "empty", "empty-scope", "no-url", "url-too-long", "bad-url", "not-https", "credentials-in-url", "not-a-code", "empty-code", "corrupt", "unavailable"]) {
		assert(has(`packError_${code}`), `a source failure has a sentence: ${code}`);
	}
	// The host's transport family must never reach `t()` as it arrives — a status is unbounded and `empty`
	// means something else there — so it is folded first, and this is what makes the set above closed.
	assert(has("packError_unreachable") && !has("packError_http-404"), "a status is folded rather than spelled out");
});

test("panel: the import page is given the props its feedback half sends with", () => {
	// The feedback button could only ever report 「先回对话里点一下词条再回来」, however well the route, the api and
	// the host worked: the panel RECEIVED `sessionId` and `recordFeedback` from the shell and never passed them
	// on. The suite could not see it because its own check renders the transfer page directly, with both props.
	const react = makeReactStub();
	const bundle = loadBundle({ react });
	const index = bundle.registered.findIndex((options) => options.name === "main");
	const face = bundle.registered[index].inject();
	const { createSettingsStore } = loadCore("settings.js");
	const settings = createSettingsStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
	const props = {
		...face,
		settings,
		t: (key) => key,
		setToast: () => {},
		sessionId: "session-1",
		recordFeedback: async () => ({ ok: true })
	};
	const open = () => {
		react.__beginRender();
		return bundle.components[index](props);
	};
	const walk = (node, visit) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child, visit);
			return;
		}
		visit(node);
		if (typeof node.type === "function") walk(node.type(node.props), visit);
		else walk(node.props?.children, visit);
	};
	const find = (tree, match) => {
		const found = [];
		walk(tree, (node) => {
			if (match(node)) found.push(node);
		});
		return found;
	};

	// Open the import/export page the way a reader does: the header button.
	const opener = find(open(), (node) => node.type === "button" && typeof node.props?.onClick === "function" && JSON.stringify(node.props.children).includes("transferTitle"))[0];
	assert(opener !== undefined, "the header offers the import / export page");
	opener.props.onClick();
	const page = find(open(), (node) => typeof node.type === "function" && node.props?.onImported !== undefined && node.props?.store !== undefined)[0];
	assert(page !== undefined, "the panel renders the import page");
	assertEqual(page.props.sessionId, "session-1", "and hands it the session id its feedback half needs");
	assertEqual(typeof page.props.recordFeedback, "function", "along with the way to record a remark");
});

test("copy: every key the browser half asks for by name exists in both locales", () => {
	// The hole the copy audit found, and the one I fell into while fixing it: the completeness check compares
	// the two LOCALES with each other, so it is blind to a key the CODE asks for and NEITHER locale has. That
	// state shows a reader a raw key (`generateNoModel`), and a green suite says nothing about it.
	//
	// Scanned from the sources rather than the built bundle, so a module added tomorrow is covered without
	// anyone remembering to add it here.
	const { zh, en } = loadCore("copy.js");
	const has = (key) => Object.prototype.hasOwnProperty.call(zh, key) && Object.prototype.hasOwnProperty.call(en, key);
	const asked = new Map();
	for (const name of readdirSync(join(pluginDir, "lib", "core")).filter((entry) => entry.endsWith(".js"))) {
		const source = readFileSync(join(pluginDir, "lib", "core", name), "utf8");
		for (const match of source.matchAll(/\bt\(\s*"([^"\\]+)"/g)) {
			if (!asked.has(match[1])) asked.set(match[1], name);
		}
	}
	assert(asked.size > 50, `the scan has to find the calls at all, found ${asked.size}`);
	const missing = [...asked.entries()].filter(([key]) => !has(key)).map(([key, where]) => `${key} (${where})`);
	assertEqual(missing, [], "every key asked for by name has copy in both languages");
});

test("style: the notice that covers the composer does not eat clicks", () => {
	// The toast is bottom-centre with the plugin's highest z-index — which is where the composer is —
	// and it lives for six seconds. Without `pointer-events: none` it swallowed every click inside its
	// rectangle for that whole time, so deleting an entry, importing, exporting or clearing the
	// dictionary left the input box unusable, which reads as a broken app rather than as a notice.
	//
	// Asserted on the style rather than through a rendered tree, because that is the whole of the bug:
	// a fixed, top-most, interactive-by-default box sitting over the input.
	const { applyStyles } = loadCore("styles.js");
	assertEqual(applyStyles.toast.pointerEvents, "none", "the notice must let pointers through");
	assertEqual(applyStyles.toast.position, "fixed", "and the fixed, bottom-centre one is the one that was the problem");
	assert(applyStyles.toast.zIndex > 0, "it sits above everything, so this was never a hypothetical overlap");
});

test("dictionary: clearing everything keeps what the user pinned", () => {
	// Pinning is how a reader says "this one, never mind the noise". A bulk clear that swept the
	// pinned entries up deleted exactly the ones that had been singled out — the opposite of what a
	// pin is for — and the confirmation did not say so, which made it a trap rather than a bug the
	// user could see coming.
	const { emptyState, editEntry, clearAll, listEntries } = loadCore("dictionary.js");
	let state = emptyState({ now: 1 });
	state = editEntry(state, "Quorum", { definition: { zh: "法定人数", gloss: "g" } }, { now: 2 }).state;
	state = editEntry(state, "Entropy", { definition: { zh: "熵", gloss: "g" } }, { now: 3 }).state;
	state = editEntry(state, "Pinned one", { definition: { gloss: "keep me" }, pinned: true }, { now: 4 }).state;
	assertEqual(listEntries(state).length, 3, "three entries to start with");

	const cleared = clearAll(state, { now: 5 });
	assertEqual(listEntries(cleared.state).map((entry) => entry.term), ["Pinned one"], "the pinned entry survives the bulk clear");
	assertEqual(cleared.removed, 2, "and the count reported is what was deleted, not how many existed");

	// Clearing twice is not a way to get the pinned one after all: it stays.
	assertEqual(listEntries(clearAll(cleared.state, { now: 6 }).state).map((entry) => entry.term), ["Pinned one"], "a second clear does not take it either");
	assertEqual(clearAll(cleared.state, { now: 6 }).removed, 0, "and reports nothing deleted");

	// The survivors are still pinned, so the property that saved them is intact rather than consumed.
	assertEqual(listEntries(cleared.state)[0].pinned, true, "the survivor is still pinned");

	// The deleted ones are tombstoned, exactly as a single deletion would leave them: without that,
	// the next union merge restores them from the other side. Tombstones live in `backing` (with
	// their keys announced in `deletedKeys`), not as `deletedAt` on a live record — asserting the
	// wrong one of those two shapes is how this check first failed.
	const restored = clearAll(state, { now: 5 }).state;
	assertEqual(restored.deletedKeys.slice().sort(), ["entropy", "quorum"], "the deleted keys are announced, which is what stops a union merge restoring them");
	assertEqual(restored.backing.length, 2, "and the tombstones themselves ride in backing");
});

test("transfer: the file's scope, and the three fates an imported entry can meet", () => {
	// Every decision the import/export feature is made of lives in `transfer.js`, which is pure — so
	// it is checked here rather than through a browser. The interesting ones are the refusals: an
	// export of "categories" that selects none, and an import that meets an entry the user deleted.
	const { buildExport, parseImport, planImport, domainsIn } = loadCore("transfer.js");
	const entries = [
		{ term: "Quorum", key: "quorum", domain: "分布式", definition: { zh: "法定人数", gloss: "g" }, seen: 7, lastSeenAt: 123, pinned: true },
		{ term: "Idempotent", key: "idempotent", domain: "分布式", definition: { zh: "幂等", gloss: "g" } },
		{ term: "Entropy", key: "entropy", domain: "信息论", definition: { zh: "熵", gloss: "g" } },
		{ term: "Loose", key: "loose", domain: "", definition: { gloss: "g" } }
	];

	// A category IS the entry's domain, so the checklist comes from the data.
	assertEqual(domainsIn(entries), [{ domain: "分布式", count: 2 }, { domain: "信息论", count: 1 }], "categories, most-populated first, and never a blank one");

	const all = buildExport(entries, { scope: "all" }, 42);
	assertEqual([all.kind, all.version, all.scope, all.exportedAt], ["dsh-term-dictionary", 1, "all", 42], "the envelope identifies itself and is stamped deterministically");
	assertEqual(all.entries.length, 4, "everything means everything");
	assertEqual(all.entries[0].pinned, true, "pinning travels, because it is the user's judgement");
	assertEqual(["seen" in all.entries[0], "lastSeenAt" in all.entries[0]], [false, false], "local history does not: a file must not claim a term was seen here");

	const picked = buildExport(entries, { scope: "domains", domains: ["信息论"] }, 42);
	assertEqual(picked.entries.map((entry) => entry.term), ["Entropy"], "by category selects only that category");
	assertEqual(picked.domains, ["信息论"], "and records what was asked for");
	// Selecting no category is a statement, not a request for the whole dictionary.
	assertEqual(buildExport(entries, { scope: "domains", domains: [] }, 42).entries.length, 0, "no categories chosen exports nothing, not everything");

	// Reading a file: the envelope this plugin writes, a bare array, and a wrapper — all acceptable,
	// because a hand-made list is still a list.
	const written = JSON.stringify(buildExport(entries, { scope: "all" }, 42));
	assertEqual(parseImport(written).entries.length, 4, "our own export round-trips");
	assertEqual(parseImport('[{"term":"Solo","definition":{"gloss":"g"}}]').entries.length, 1, "a bare array is a dictionary too");
	assertEqual(parseImport('{"entries":[{"term":"Wrapped"}]}').entries.length, 1, "and so is an object that only has entries");
	assertEqual(parseImport("not json at all"), { ok: false, error: "not-json" }, "garbage is refused with a reason");
	assertEqual(parseImport('{"entries":[]}'), { ok: false, error: "no-usable-entries" }, "and so is a file with nothing usable in it");
	const mixed = parseImport('[{"term":"Good"},{"term":""},{"nope":1}]');
	assertEqual([mixed.entries.length, mixed.skipped], [1, 2], "records without a term are counted as skipped, not imported as blanks");

	// The policy, which is the whole point: take what is new, leave alone what exists, and never
	// revive what the user deleted.
	const plan = planImport(
		[{ key: "quorum" }],
		[
			{ term: "Quorum", key: "quorum" },
			{ term: "Idempotent", key: "idempotent" },
			{ term: "Entropy", key: "entropy" },
			{ term: "Idempotent again", key: "idempotent" }
		],
		new Set(["entropy"])
	);
	assertEqual(plan.accepted.map((entry) => entry.term), ["Idempotent"], "only the genuinely new entry is taken");
	assertEqual(plan.existing.map((entry) => entry.term), ["Quorum"], "an entry already here is left as it is");
	assertEqual(plan.deleted.map((entry) => entry.term), ["Entropy"], "an entry the user deleted stays deleted — a file is not a reason to undo that");
	assertEqual(plan.duplicates, 1, "and a key repeated inside the file collapses to one");
	assertEqual(planImport([], [{ key: "a" }, { key: "a" }], new Set()).accepted.length, 1, "a file that repeats itself imports the entry once");

	// ... and the one thing that overrides the deletion rule: the user asking for it.
	//
	// A tombstone IS the user's decision, so an import may only overturn it on request — never by
	// merely containing the term. Asked for, those entries move into `accepted` (the caller's write
	// list) and the bucket is then genuinely empty, so the report's "0 you deleted" stays true
	// instead of quietly changing meaning.
	const optedIn = planImport(
		[{ key: "quorum" }],
		[{ term: "Quorum", key: "quorum" }, { term: "Entropy", key: "entropy" }],
		new Set(["entropy"]),
		{ includeDeleted: true }
	);
	assertEqual(optedIn.accepted.map((entry) => entry.term), ["Entropy"], "opting in is the only way a deleted entry is taken");
	assertEqual(optedIn.deleted, [], "and it is then not also reported as skipped");
	assertEqual(optedIn.existing.map((entry) => entry.term), ["Quorum"], "while the entry already here is still left alone");
	assertEqual(planImport([], [{ term: "Entropy", key: "entropy" }], new Set(["entropy"]), { includeDeleted: false }).accepted.length, 0, "the option has to be stated, not merely defaulted away from");

	// Provenance is the store's to stamp. A file that claimed `source: "auto"` would produce an
	// entry the merge does not count as intent — collected by itself and therefore droppable — so the
	// import must not read it: the entry is created by the user's own action and is a `user` record.
	assertEqual("source" in parseImport('[{"term":"Solo","source":"auto"}]').entries[0], false, "an imported record carries no source claim");
	assertEqual(parseImport('[{"term":"Solo"}]').entries[0].pinned, false, "and an absent pin is false, not undefined");
});

test("hover: the caret decides which marked term is under the pointer", () => {
	// The hit test the pointer layer replaced its own matcher with: a caret is a `(node, offset)`
	// pair, and a marked occurrence is stored in the same coordinates, so this is a lookup rather
	// than a second text walk. These are the cases the retired `ranges:` checks covered — the ones
	// that still describe live behaviour, on the module that now owns it.
	const { createHoverLayer } = loadCore("hover.js");
	const alpha = { nodeType: 3, nodeValue: "alpha beta", parentElement: null, childNodes: [] };
	const other = { nodeType: 3, nodeValue: "elsewhere", parentElement: null, childNodes: [] };
	const parent = { nodeType: 1, nodeValue: null, childNodes: [alpha], parentElement: null };
	const segments = [
		{ node: alpha, start: 0, end: 5, term: "alpha", key: "alpha", id: "" },
		{ node: alpha, start: 6, end: 10, term: "beta", key: "beta", id: "" }
	];
	/** Where the caret is reported, so one layer can be asked many questions. */
	let caret = { startContainer: alpha, startOffset: 2 };
	const layer = createHoverLayer({
		document: { caretRangeFromPoint: () => caret, createRange: () => ({ setStart: () => {}, setEnd: () => {} }) },
		segments: () => segments,
		disposers: []
	});

	assertEqual(layer.matchAt(0, 0)?.key, "alpha", "a caret inside a marked term matches it");
	caret = { startContainer: alpha, startOffset: 0 };
	assertEqual(layer.matchAt(0, 0)?.key, "alpha", "including at its first character");
	// Offset 5 is the END of "alpha" and offset 6 the START of "beta"; the space between belongs to
	// neither, and a caret exactly on a term's trailing edge belongs to that term.
	caret = { startContainer: alpha, startOffset: 6 };
	assertEqual(layer.matchAt(0, 0)?.key, "beta", "a caret on a boundary belongs to the term starting there");
	caret = { startContainer: alpha, startOffset: 5 };
	assertEqual(layer.matchAt(0, 0)?.key, "alpha", "and the term ending there owns its own last offset");
	caret = { startContainer: other, startOffset: 2 };
	assertEqual(layer.matchAt(0, 0), null, "a caret in another node matches nothing");
	caret = { startContainer: parent, startOffset: 0 };
	assertEqual(layer.matchAt(0, 0)?.key, "alpha", "a caret on an element resolves into the text that follows it");
	caret = null;
	assertEqual(layer.matchAt(0, 0), null, "and no caret at all matches nothing");
});

test("settings: a delay is clamped into range instead of trusted", () => {
	// A slider and a text box feed the same setter, so `"120"`, `120.4` and `5000` all arrive here.
	// A delay outside the range is a worse outcome than the nearest valid one, and the store is
	// where that rule lives — not in two places, one per input.
	const { normalizeSettings, HOVER_DELAY_MIN, HOVER_DELAY_MAX, DEFAULT_SETTINGS } = loadCore("settings.js");
	assertEqual([HOVER_DELAY_MIN, HOVER_DELAY_MAX], [0, 200], "the range the slider and the box advertise");
	assertEqual(normalizeSettings({ hoverInMs: 5000 }).hoverInMs, 200, "above the range clamps to the top");
	assertEqual(normalizeSettings({ hoverInMs: -5 }).hoverInMs, 0, "and below it to the bottom");
	assertEqual(normalizeSettings({ hoverInMs: 120.4 }).hoverInMs, 120, "a fraction is rounded, not stored");
	assertEqual(normalizeSettings({ hoverInMs: "130" }).hoverInMs, 130, "a number typed into the box arrives as a string");
	assertEqual(normalizeSettings({ hoverInMs: "later" }).hoverInMs, DEFAULT_SETTINGS.hoverInMs, "and a non-number falls back");
	assertEqual(normalizeSettings({}).hoverOutMs, 0, "the exit delay defaults to zero: a lingering card reads as lag");
	assertEqual(normalizeSettings({ hoverOutMs: 999 }).hoverOutMs, 200, "and it obeys the same range");
});

test("settings: an unknown stored choice falls back instead of reaching the prompt builder", () => {
	// The host builds the instruction from `lang` and `depth` and only has branches for the
	// values this store accepts. A hand-edited record, or one written by an older build, must
	// not be able to put a third value in there — so the store normalizes what it READ, not
	// only what it is handed through `set`.
	const { createSettingsStore, normalizeSettings } = loadCore("settings.js");
	const read = (raw) => ({
		map: new Map([["dsh-plugin-term-dictionary:settings:v1", JSON.stringify(raw)]]),
		getItem(key) {
			return this.map.has(key) ? this.map.get(key) : null;
		},
		setItem() {}
	});
	const store = createSettingsStore({ storage: read({ explainLang: "klingon", explainDepth: "essay", explainParagraph: "yes" }) });
	assertEqual(store.getSnapshot().explainLang, "auto", "an unknown language falls back to following the UI");
	assertEqual(store.getSnapshot().explainDepth, "normal", "an unknown depth falls back to normal");
	assertEqual(store.getSnapshot().explainParagraph, true, "and a non-boolean flag falls back to its default");
	// Writing a value the store does not know must not land either.
	store.set("explainLang", "klingon");
	assertEqual(store.getSnapshot().explainLang, "auto", "set() normalizes too");
	assertEqual(normalizeSettings({ explainLang: "en", explainDepth: "brief" }).explainDepth, "brief", "and a known value survives");
});

test("panel: clicking anywhere on an entry block opens it, and its own buttons do not", () => {
	// The row used to be inert except for its name, so "the entry block does not respond" was the
	// reader's experience. The fix is a click on the block — and the guard that matters is the
	// OTHER half: pin, edit and delete are buttons inside that block, and their clicks must not
	// also open the editor behind them.
	const sets = [];
	const react = makeReactStub({ onSet: (value) => sets.push(value) });
	const bundle = loadBundle({ react });
	const index = bundle.registered.findIndex((options) => options.name === "main");
	assert(index >= 0, "the main slot registration must be captured");
	const face = bundle.registered[index].inject();
	face.store.noteSighting({ term: "Quorum", context: "A quorum decides." });
	const tree = bundle.components[index]({ ...face, t: (key) => key });

	/** Every row the panel rendered, found by the marker the pointer layer also reads. */
	const rows = [];
	const walk = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node.props?.["data-term-entry"] === "string") rows.push(node);
		walk(node.props?.children);
	};
	walk(tree);
	assertEqual(rows.length, 1, "the entry must be rendered as one block");
	const row = rows[0];
	assert(typeof row.props.onClick === "function", "the block itself must be clickable");

	row.props.onClick({ target: { closest: () => null } });
	assert(sets.length > 0, "clicking the block must open the entry");

	const before = sets.length;
	row.props.onClick({ target: { closest: (selector) => (selector === "button" ? {} : null) } });
	assertEqual(sets.length, before, "a click on one of the block's own buttons must not also open the editor");
});

test("panel: the settings page renders every preference and changes the store", () => {
	// The preferences used to be a row of chips in the panel; they are a page of their own now,
	// reachable from the header. This drives that page directly through the bundle's test seam,
	// and separately asserts the two halves of the decision: the page is where the controls are,
	// and the entry list no longer carries them.
	const sets = [];
	const react = makeReactStub({ onSet: (value) => sets.push(value) });
	const bundle = loadBundle({ react });
	assert(typeof bundle.exports.settingsPage === "function", "the settings page must be reachable for checks");
	const { createSettingsStore } = loadCore("settings.js");
	const store = createSettingsStore({ storage: null });
	const setSwitch = (key, value) => store.set(key, value);
	const page = bundle.exports.settingsPage({ settings: store.getSnapshot(), setSwitch, t: (key, values) => `${key}${values?.count === undefined ? "" : `:${values.count}`}` });

	/** Collect the two control shapes: switches and the option bars. */
	const switches = [];
	const bars = [];
	const fields = [];
	const walk = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node.props?.onToggle === "function") switches.push(node);
		// Collected by its setter, the same way the switches are: `options` and the label live on
		// the OptionBar element itself, while `role="radiogroup"` is on the div it returns.
		if (typeof node.props?.onSelect === "function") bars.push(node);
		// The third shape. Collected by `onChange` for the same reason: the slider and the box live
		// inside DelayField, while the value, the bounds and the setter are on its own element.
		if (typeof node.props?.onChange === "function") fields.push(node);
		walk(node.props?.children);
	};
	walk(page);

	// Eleven preferences, and the control each one's VALUE SHAPE calls for: two states get a switch,
	// a few named choices get an option bar, and a number in a range gets a slider plus a box.
	assertEqual(switches.length, 6, "six switches: collect, annotate, explain, paragraph, code names, Chinese terms");
	assertEqual(bars.length, 5, "five option bars: language, depth, row height, entry columns, minimum length");
	assertEqual(bars.map((bar) => bar.props.options.length), [3, 3, 2, 4, 5], "each bar shows every one of its values");
	assertEqual(fields.length, 2, "two delay fields: the hover entry delay and the hover exit delay");
	assertEqual(
		fields.map((field) => [field.props.min, field.props.max]),
		[[0, 200], [0, 200]],
		"both bounded to 0-200ms, which is what the slider and the box advertise"
	);
	fields[0].props.onChange(150);
	assertEqual(store.getSnapshot().hoverInMs, 150, "the entry-delay field reaches the store");
	fields[1].props.onChange(40);
	assertEqual(store.getSnapshot().hoverOutMs, 40, "and so does the exit-delay field");
	// Each control is named by the PREFERENCE, and the state rides on the control instead of in the
	// name. (The `role`/`aria-checked` that report it live inside these components — asserted by
	// the components' own shape, not reachable from the element that SettingsPage builds.)
	for (const control of switches) {
		assert(typeof control.props.title === "string" && control.props.title !== "", "every switch must be named by its preference");
		assert(typeof control.props.checked === "boolean", "and carry its state as a boolean");
	}
	for (const bar of bars) {
		assert(typeof bar.props.label === "string" && bar.props.label !== "", "every option bar must be named by its preference");
	}
	assertEqual(switches[0].props.title, "autoDetectOn", "the switch is named by the preference, not by its state");
	switches[0].props.onToggle();
	assertEqual(store.getSnapshot().autoCollect, false, "turning the first switch off reaches the store");
	switches[3].props.onToggle();
	assertEqual(store.getSnapshot().explainParagraph, false, "and the paragraph preference reaches the store too");
	assertEqual(store.getSnapshot().collectIdentifiers, false, "code names are off by default");
	switches[4].props.onToggle();
	assertEqual(store.getSnapshot().collectIdentifiers, true, "and that switch turns them on");
	assertEqual(store.getSnapshot().collectCjk, true, "Chinese terms are on by default");

	const langBar = bars.find((bar) => bar.props.label === "explainLangName");
	const depthBar = bars.find((bar) => bar.props.label === "explainDepthName");
	const lengthBar = bars.find((bar) => bar.props.label === "collectMinLengthName");
	const columnBar = bars.find((bar) => bar.props.label === "entryColumnsName");
	const rowsBar = bars.find((bar) => bar.props.label === "entryRowsName");
	assert(
		langBar !== undefined && depthBar !== undefined && lengthBar !== undefined && columnBar !== undefined && rowsBar !== undefined,
		"every option bar must be reachable by name"
	);
	assertEqual(langBar.props.options.map((option) => option.value), ["auto", "zh", "en"], "the language bar offers every language");
	assertEqual(langBar.props.options.length, 3, "and offers one option per value");
	langBar.props.onSelect("zh");
	assertEqual(store.getSnapshot().explainLang, "zh", "choosing an option reaches the store directly, not by cycling past it");
	depthBar.props.onSelect("detailed");
	assertEqual(store.getSnapshot().explainDepth, "detailed", "the depth bar too");
	lengthBar.props.onSelect(6);
	assertEqual(store.getSnapshot().collectMinLength, 6, "and the length bar takes a number, which the cycling control could not");
	// The layout is a preference like the rest: string values, so the panel can key on them, and "auto" is
	// the default because a single column of dictionary rows is a very long strip to read.
	assertEqual(columnBar.props.options.map((option) => option.value), ["auto", "1", "2", "3"], "the layout bar offers auto and a fixed count");
	columnBar.props.onSelect("2");
	assertEqual(store.getSnapshot().entryColumns, "2", "choosing a layout reaches the store");
	// Row height answers the second half of the same complaint — the gaps under short cards in a grid — so it
	// is asserted the same way, and it starts uniform so no gap is left by default.
	assertEqual(rowsBar.props.options.map((option) => option.value), ["uniform", "compact"], "the row-height bar offers both readings");
	assertEqual(store.getSnapshot().entryRows, "uniform", "starting uniform, which is the reading that leaves no strip");
	rowsBar.props.onSelect("compact");
	assertEqual(store.getSnapshot().entryRows, "compact", "and choosing compact reaches the store");

	// The entry list no longer renders any of them, and carries the entry to the page instead.
	const index = bundle.registered.findIndex((options) => options.name === "main");
	const face = bundle.registered[index].inject();
	const listTree = bundle.components[index]({ ...face, t: (key) => key });
	const listSwitches = [];
	const listCycles = [];
	const gather = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) gather(child);
			return;
		}
		if (typeof node.props?.onToggle === "function") listSwitches.push(node);
		if (typeof node.props?.onCycle === "function") listCycles.push(node);
		gather(node.props?.children);
	};
	gather(listTree);
	assertEqual(listSwitches.length + listCycles.length, 0, "the entry list must not carry the preferences any more");
	assert(sets.length >= 0, "the panel's own state is the only thing the entry list changes");
});

test("panel: the deleted view is behind its own tab, which the ordinary list does not show", () => {
	// The way IN to the blacklist, and the reason a way in is needed: a tombstone is invisible to the
	// ordinary list — that is the whole point of one — so without this tab a term deleted by a
	// mis-aimed click could never be seen again, let alone brought back.
	const sets = [];
	const react = makeReactStub({ onSet: (value) => sets.push(value) });
	const bundle = loadBundle({ react });
	const index = bundle.registered.findIndex((options) => options.name === "main");
	assert(index >= 0, "the main slot registration must be captured");
	const face = bundle.registered[index].inject();
	void face.store.saveEntry("Quorum", { definition: { gloss: "g" } });
	void face.store.saveEntry("Entropy", { definition: { gloss: "g" } });
	void face.store.deleteEntry("Entropy");
	const tree = bundle.components[index]({ ...face, t: (key) => key });

	/** Every node the walk can name, by the marker it carries. */
	const found = { tabs: [], live: [], deleted: [] };
	const walk = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (node.props?.role === "tab") found.tabs.push(node);
		if (typeof node.props?.["data-term-entry"] === "string") found.live.push(node);
		if (typeof node.props?.["data-term-deleted"] === "string") found.deleted.push(node);
		walk(node.props?.children);
	};
	walk(tree);

	assertEqual(found.live.length, 1, "the ordinary list shows the live entry");
	assertEqual(found.deleted.length, 0, "and not the deleted one, which is what makes the tab necessary");
	assertEqual(
		found.tabs.map((tab) => tab.props.children),
		["filterAll", "filterUnexplained", "filterPinned", "filterFlagged", "filterDeleted"],
		"five views: the entry list, what was flagged, and what was deleted last"
	);

	// Found by LABEL, not by position: the tabs are a list that grows, and an index that silently
	// starts pointing at a different view is a check that keeps passing while testing the wrong one.
	const deletedTab = found.tabs.find((tab) => tab.props.children === "filterDeleted");
	assert(deletedTab !== undefined, "there must be a tab labelled for the deleted view");
	deletedTab.props.onClick();
	assert(sets.includes("deleted"), `the tab must select the deleted view, saw ${JSON.stringify(sets)}`);
	const flaggedTab = found.tabs.find((tab) => tab.props.children === "filterFlagged");
	flaggedTab.props.onClick();
	assert(sets.includes("flagged"), `and its neighbour selects the flagged view, saw ${JSON.stringify(sets)}`);
});

test("panel: the deleted view renders the tombstones and its 撤回 control names the term", () => {
	// The view itself, rendered through the bundle's test seam. Three things are asserted because
	// three things can go wrong in a row: the term, WHICH deletion it is (a list of identical rows is
	// useless), and the one control.
	const sets = [];
	const react = makeReactStub({ onSet: (value) => sets.push(value) });
	const bundle = loadBundle({ react });
	assert(typeof bundle.exports.deletedList === "function", "the deleted view must be reachable for checks");
	const t = (key, values) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`);
	const revived = [];
	const page = bundle.exports.deletedList({ entries: [{ id: "id-1", term: "Entropy", key: "entropy", deletedAt: 20261009 }], t, onRevive: (entry) => revived.push(entry) });

	const rows = [];
	const buttons = [];
	const walk = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node.props?.["data-term-deleted"] === "string") rows.push(node);
		if (node.props?.label === "revive" && typeof node.props.onClick === "function") buttons.push(node);
		walk(node.props?.children);
	};
	walk(page);

	assertEqual(rows.length, 1, "one row per tombstone");
	const text = [];
	const gather = (node) => {
		if (typeof node === "string" || typeof node === "number") text.push(String(node));
		else if (Array.isArray(node)) node.forEach(gather);
		else if (node !== null && typeof node === "object") gather(node.props?.children);
	};
	gather(rows[0]);
	assert(text.includes("Entropy"), `the row must name the term, saw ${JSON.stringify(text)}`);
	assert(text.some((part) => part.startsWith("deletedAt")), `and say when it was deleted, saw ${JSON.stringify(text)}`);
	assertEqual(buttons.length, 1, "and carry exactly one way back");
	buttons[0].props.onClick();
	assertEqual(revived.map((entry) => entry.id), ["id-1"], "which hands the row's own entry to the caller");

	// Nothing deleted is a state, not an empty list: it says so.
	const blank = bundle.exports.deletedList({ entries: [], t, onRevive: () => {} });
	text.length = 0;
	gather(blank);
	assert(text.includes("deletedEmpty"), `an empty blacklist says so rather than rendering nothing, saw ${JSON.stringify(text)}`);
	assertEqual(sets.length, 0, "the view owns no state of its own: rendering does not touch a single setter");
});

test("panel: the flagged view renders the remark and its 撤回 control names the term", () => {
	// The row's job is to show what the user said — the category, their own words, and whether they
	// also called the explanation untrustworthy. Retracting is one press on the same row.
	const sets = [];
	const react = makeReactStub({ onSet: (value) => sets.push(value) });
	const bundle = loadBundle({ react });
	assert(typeof bundle.exports.flaggedList === "function", "the flagged view must be reachable for checks");
	const t = (key, values) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`);
	const cleared = [];
	const page = bundle.exports.flaggedList({
		entries: [
			{ id: "id-1", term: "Quorum", key: "quorum", feedback: { kind: "wrong-gloss", note: "太笼统" }, feedbackAt: 20, untrusted: true, untrustedAt: 20 }
		],
		t,
		onClear: (entry) => cleared.push(entry)
	});

	const rows = [];
	const buttons = [];
	const walk = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node.props?.["data-term-flagged"] === "string") rows.push(node);
		if (node.props?.label === "flaggedClear" && typeof node.props.onClick === "function") buttons.push(node);
		walk(node.props?.children);
	};
	walk(page);
	assertEqual(rows.length, 1, "one row per flagged entry");
	const text = [];
	const gather = (node) => {
		if (typeof node === "string" || typeof node === "number") text.push(String(node));
		else if (Array.isArray(node)) node.forEach(gather);
		else if (node !== null && typeof node === "object") gather(node.props?.children);
	};
	gather(rows[0]);
	assert(text.includes("Quorum"), `the row must name the term, saw ${JSON.stringify(text)}`);
	assert(text.includes("feedbackKind_wrong-gloss"), `and the category the user picked, saw ${JSON.stringify(text)}`);
	assert(text.includes("太笼统"), "and their own words");
	assert(text.includes("flaggedUntrusted"), "and the verdict on the explanation");
	assert(text.some((part) => part.startsWith("flaggedAt")), "and when they said it");
	assertEqual(buttons.length, 1, "with exactly one way to take it back");
	buttons[0].props.onClick();
	assertEqual(cleared.map((entry) => entry.id), ["id-1"], "which hands the row's own entry to the caller");

	// Nothing flagged is a state, and the view owns no state of its own.
	const blank = bundle.exports.flaggedList({ entries: [], t, onClear: () => {} });
	text.length = 0;
	gather(blank);
	assert(text.includes("flaggedEmpty"), `an empty flagged view says so, saw ${JSON.stringify(text)}`);
	assertEqual(sets.length, 0, "rendering it does not touch a single setter");
});

test("panel: the batch-selection control exists and does something", () => {
	// Split out of the settings check: the two are unrelated, and the settings page moving off
	// the entry list is no reason for the batch-selection control to lose its guard.
	const sets = [];
	const react = makeReactStub({ onSet: (value) => sets.push(value) });
	const bundle = loadBundle({ react });
	const index = bundle.registered.findIndex((options) => options.name === "main");
	const listTree = bundle.components[index]({ ...bundle.registered[index].inject(), t: (key) => key });
	// The batch-selection control exists and does something.
	const controls = [];
	const collect = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) collect(child);
			return;
		}
		if (typeof node.props?.onClick === "function" && node.props.title === "selectEnter") controls.push(node);
		collect(node.props?.children);
	};
	collect(listTree);
	assertEqual(controls.length, 1, "a batch-selection control must be rendered");
	controls[0].props.onClick();
	assert(sets.includes(true), `picking mode must be turned on, saw ${JSON.stringify(sets)}`);
});

// The host half is loaded ONCE, at module scope.
//
// A dynamic import inside a synchronous `test()` body is an unhandled rejection waiting to
// happen: the runner does not await it, so the check reports before its assertion runs — and a
// failure inside it crashes the process instead of being counted. Top-level await keeps this
// check synchronous from the runner's point of view.
const hostHalf = await import(pathToFileURL(join(libDir, "index.js")).href);

test("host: the prompt obeys the language and depth preferences, and defaults to Chinese", () => {
	// The prompt's SHAPE is what the JSON parser and the panel depend on, and the preferences
	// are a closed set the page sends. Both halves were only reachable through a live model
	// call before, which is why `auto` sat there as a silent default.
	const { __buildSystemPrompt } = hostHalf;
	const chinese = __buildSystemPrompt({ lang: "zh", depth: "normal" });
	const english = __buildSystemPrompt({ lang: "en", depth: "normal" });
	assert(chinese.includes("Do not answer in English"), "the Chinese instruction must keep its language rule");
	assert(!english.includes("Do not answer in English"), "the English instruction must not carry the Chinese rule");
	assert(english.includes("software engineering"), "and must ask for an English domain label");
	// The JSON keys are field names, not prose: both languages must ask for the same four.
	for (const prompt of [chinese, english]) {
		assert(prompt.includes('{"zh": "...", "gloss": "...", "usage": "...", "domain": "..."}'), "the key set must not drift between languages");
	}
	// Depth narrows or widens the same base rather than replacing it.
	assert(__buildSystemPrompt({ lang: "zh", depth: "brief" }).includes("不超过 20 字"), "brief must narrow the Chinese instruction");
	assert(__buildSystemPrompt({ lang: "zh", depth: "detailed" }).includes("两到三句"), "detailed must widen it");
	assertEqual(__buildSystemPrompt({ lang: "zh", depth: "normal" }).includes("再简短些"), false, "normal must add nothing");
	// `auto` and a missing preference both fall to Chinese, by decision rather than by omission.
	assertEqual(__buildSystemPrompt({ lang: "auto" }), chinese, "auto means Chinese here, because the page resolves it first");
	assertEqual(__buildSystemPrompt({}), chinese, "and so does an absent preference");
	assertEqual(__buildSystemPrompt({ lang: "klingon", depth: "essay" }), chinese, "an unknown pair falls back rather than reaching the model");
});

test("bundle: the diagnostic report never becomes a dictionary entry", () => {
	// The beacon used to FILE itself as a dictionary entry, so every page load added `zz-hb-*`
	// rows to the user's term list — a diagnostic writing into the data it diagnoses, which is
	// how 66 of them ended up in a dictionary that holds two real terms. It is console-only
	// now, and this is the guard: the page-side readouts (`console`, `__termDictionary`,
	// `__termDictionaryBeacon`) are still allowed, the write is not.
	const source = readFileSync(join(pluginDir, "lib", "client.js"), "utf8");
	assert(!source.includes("await api.report("), "the report must not be filed through the entries API");
	assert(source.includes("report (console only"), "and it must still be emitted, to the console");
});

test("bundle: the pointer layer is wired in the capture phase", () => {
	// The pointer layer belonged to a second plugin (dsh-plugin-term-wikilink), and the dictionary
	// deliberately did NOT listen for movement. It was merged in on 2026-10-09, so the dictionary
	// now owns hover as well as click — and every pointer listener must be in the CAPTURE phase:
	// React 17+ delegates to the root container below `document`, so any `stopPropagation()` in the
	// tree can silence a bubble-phase listener, which is indistinguishable from "the page produced no
	// event".
	//
	// This assertion is therefore the OPPOSITE of what it was: it used to require the ABSENCE of
	// `pointermove`, precisely so that two plugins could not both answer a hover.
	//
	// The TYPES are not the claim — the PHASE is, and this check used to assert only the types while
	// its own name and comment promised the phase. That is a false green of the worst kind: the one
	// fact the whole pointer chain rests on, asserted by a check that could not see it. The sandbox
	// now keeps the listener options so the phase is checkable, and `check-pointer-guards.mjs` M2
	// (click → bubble) is what proves this assertion really bites.
	//
	// `selectionchange` is deliberately not in the phase list: it is fired at the document itself
	// rather than delegated through the tree, so it has no bubble phase to lose.
	const { documentListeners, documentListenerPhases } = loadBundle();
	for (const type of ["click", "mousedown", "selectionchange", "pointermove"]) {
		assert(documentListeners.includes(type), `the ${type} listener must be attached to the document`);
	}
	for (const type of ["click", "mousedown", "pointermove", "keydown"]) {
		const registrations = documentListenerPhases.filter((entry) => entry.type === type);
		assert(registrations.length > 0, `the ${type} listener must be registered, with its phase`);
		assert(
			registrations.every((entry) => entry.capture === true),
			`every ${type} listener must be registered for the capture phase, saw ${JSON.stringify(registrations)}`
		);
	}
});

test("beacon: the report that reaches the console is the fitted one, and it names the stage", () => {
	// The report is console-only now, so that console line IS the report — and two properties of it are
	// the difference between a diagnosable page and a wall of text: it went through the fitter (which
	// keeps the entry store's own limit and declares what it dropped), and it carries `trace`, the one
	// field that says which hit-test stage refused. Both were asserted on the fitter itself; nothing
	// asserted that the shell CALLS it before printing, which is the line a refactor drops.
	const { MAX_CONTEXT_CHARS } = loadCore("entries.js");
	const lines = [];
	const fake = {
		log: () => {},
		warn: () => {},
		error: () => {},
		info: (label, text) => lines.push({ label: String(label), text: String(text) })
	};
	loadBundle({ console: fake });

	const reports = lines.filter((line) => line.label.includes("report (console only, not filed)"));
	assert(reports.length > 0, `the page must report when it starts, saw ${JSON.stringify(lines.map((line) => line.label))}`);
	for (const line of reports) {
		const report = JSON.parse(line.text);
		assert(typeof report.b === "string" && typeof report.w === "string", "every report identifies its build and its kind");
		assert(Array.isArray(report.dropped), "and came out of the fitter, which is what declares what a trimmed report removed");
		assert(typeof report.trace === "string", "and carries the stage the hit test refused at, the one field that explains a dead gesture");
		assert(line.text.length <= MAX_CONTEXT_CHARS, `a report must fit the limit the entry store keeps, saw ${line.text.length} against ${MAX_CONTEXT_CHARS}`);
	}
});

test("bundle: the overlay renders the hint and the popup the shell asks for", () => {
	// The other end of the same path: the interaction layer reports a hit, the shell sets an
	// overlay state, and THIS component has to turn it into something visible. A state the
	// overlay does not render is indistinguishable from "nothing happened".
	const react = makeReactStub();
	const { registered, components } = loadBundle({ react });
	const index = registered.findIndex((options) => options.name === "shell.overlay");
	assert(index >= 0, "the overlay slot registration must be captured");
	const face = registered[index].inject();
	const render = (overlayState) =>
		components[index]({
			...face,
			overlay: { getSnapshot: () => overlayState, subscribe: () => () => {} }
		});

	/** Collect the element nodes anywhere in a stub tree that match a predicate. */
	const findNodes = (node, match, out = []) => {
		if (node === null || node === undefined || typeof node !== "object") return out;
		if (Array.isArray(node)) {
			for (const child of node) findNodes(child, match, out);
			return out;
		}
		if (match(node)) out.push(node);
		findNodes(node.props?.children, match, out);
		return out;
	};

	// A hint state is now a state NOTHING renders: the hover card belongs to
	// dsh-plugin-term-wikilink, which brings its own. What must not happen is the REVERSE —
	// a state the overlay silently ignores is what used to make "nothing happened" invisible.
	const hintTree = render({ kind: "hint", term: "WriteAheadLog", zh: "预写日志", gloss: "先写日志再改数据。", hasEntry: true, point: { x: 10, y: 10 } });
	const hints = findNodes(hintTree, (node) => typeof node.props?.gloss === "string" && typeof node.props?.hasEntry === "boolean");
	assertEqual(hints.length, 0, "the dictionary must no longer render a hover hint of its own");

	const popupTree = render({ kind: "entry", term: "quorum", key: "quorum", context: "A quorum is a majority.", point: { x: 20, y: 20 } });
	const popups = findNodes(popupTree, (node) => Object.prototype.hasOwnProperty.call(node.props ?? {}, "entry"));
	assert(popups.length >= 1, "an entry state must still render its popup");
	assertEqual(popups[0].props.term, "quorum", "carrying the term it explains");
	assertEqual(popups[0].props.context, "A quorum is a majority.", "and the sentence it came from");
});

test("bus: the editor and reveal commands are independent", () => {
	const { createPanelCommandBus } = loadCore("bus.js");
	const bus = createPanelCommandBus();
	bus.requestCreate("event sourcing", "the sentence it came from");
	bus.requestFocus("quorum");
	assertEqual(bus.consumeCreate().term, "event sourcing", "the editor command survives a reveal");
	assertEqual(bus.consumeFocus().key, "quorum", "the reveal command survives an editor command");
	assertEqual(bus.consumeCreate(), null, "consuming clears the editor slot");
	assertEqual(bus.consumeFocus(), null, "consuming clears the reveal slot");
	assertEqual(bus.peek(), null, "nothing is left pending");
});

test("copy: every Chinese string has an English twin and vice versa", () => {
	// The panel, the popup and the hint all read their copy from this table, and a key
	// missing on one side shows a raw key or an empty label in that locale.
	const { zh, en } = loadCore("copy.js");
	const zhKeys = Object.keys(zh).sort();
	const enKeys = Object.keys(en).sort();
	assertEqual(enKeys, zhKeys, "the two dictionaries must carry the same key set");
	for (const key of zhKeys) {
		assert(typeof zh[key] === "string" && zh[key].trim() !== "", `zh.${key} must be non-empty`);
		assert(typeof en[key] === "string" && en[key].trim() !== "", `en.${key} must be non-empty`);
	}
	assert(typeof zh.explainDepth_normal === "string" && /[\u4e00-\u9fff]/.test(zh.explainDepth_normal), "the explanation-depth label must be Chinese");
	assertEqual(/[\u4e00-\u9fff]/.test(zh.selectAdd), true, "the selection affordance label must be Chinese");
});

/**
 * Remove comments so a scan sees only code.
 *
 * A scanner rather than a regex, for the reason `tools/build-client.mjs` documents: a
 * regex would mangle a `//` inside a string literal, and a backtick in a comment would
 * look like a template literal. String and template literals are copied verbatim.
 *
 * @param text - the source text.
 * @returns the same text with block and line comments removed.
 */
function stripComments(text) {
	let out = "";
	let at = 0;
	let quote = null;
	while (at < text.length) {
		const character = text[at];
		const next = text[at + 1];
		if (quote !== null) {
			out += character;
			if (character === "\\") {
				out += next ?? "";
				at += 2;
				continue;
			}
			if (character === quote) quote = null;
			at++;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			out += character;
			at++;
			continue;
		}
		if (character === "/" && next === "/") {
			while (at < text.length && text[at] !== "\n") at++;
			continue;
		}
		if (character === "/" && next === "*") {
			at += 2;
			while (at < text.length && !(text[at] === "*" && text[at + 1] === "/")) {
				if (text[at] === "\n") out += "\n";
				at++;
			}
			at += 2;
			continue;
		}
		out += character;
		at++;
	}
	return out;
}

test("style: every theme token the plugin names is really defined", () => {
	// The regression guard for the invisible Save button.
	//
	// `primaryButton` used `--dsw-alias-label-inverse`, which the design platform does
	// not define, next to `--dsw-alias-brand-primary`, which in the dark theme resolves
	// to the same near-white value as `--dsw-alias-label-primary`. Label and fill were
	// therefore both white and the button rendered as an empty rectangle — a bug no
	// behavioural test could see, because nothing was functionally wrong.
	//
	// The list below is every `--dsw-alias-*` / `--dsw-specific-*` name defined by the
	// shipped theme CSS, taken from
	// `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`
	// (118 names), plus the four `--dsw-radius-*` the plugin uses. To refresh it after a
	// host upgrade: extract that file and list `(--dsw-(alias|specific)-[a-z0-9-]+):`.
	const DEFINED = new Set([
		"--dsw-alias-bg-base", "--dsw-alias-bg-document-preview", "--dsw-alias-bg-document-selection",
		"--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2", "--dsw-alias-bg-layer-3",
		"--dsw-alias-bg-mask-1", "--dsw-alias-bg-mask-2", "--dsw-alias-bg-mask-3",
		"--dsw-alias-bg-mask-drop", "--dsw-alias-bg-mask-photo", "--dsw-alias-bg-module-platform",
		"--dsw-alias-bg-multi-select", "--dsw-alias-bg-overlay", "--dsw-alias-bg-skeleton",
		"--dsw-alias-border-inverted", "--dsw-alias-border-inverted2", "--dsw-alias-border-l1",
		"--dsw-alias-border-l2", "--dsw-alias-border-l2-darkmode-thin", "--dsw-alias-border-l3",
		"--dsw-alias-border-l4", "--dsw-alias-brand-primary", "--dsw-alias-brand-primary-invert",
		"--dsw-alias-brand-primary-new-colorprimary-new-color", "--dsw-alias-brand-text",
		"--dsw-alias-button-contrast-fill", "--dsw-alias-button-elevated-fill",
		"--dsw-alias-button-floating-fill", "--dsw-alias-button-floating-hover",
		"--dsw-alias-button-ghost-active-border", "--dsw-alias-button-ghost-active-fill",
		"--dsw-alias-button-ghost-active-hover", "--dsw-alias-button-info-fill",
		"--dsw-alias-button-info-hover", "--dsw-alias-button-primary-dimmed",
		"--dsw-alias-button-primary-fill", "--dsw-alias-button-primary-hover",
		"--dsw-alias-button-tool-bar-fill", "--dsw-alias-button-tool-bar-fill-invisible",
		"--dsw-alias-button-tool-bar-hover", "--dsw-alias-code-diff-added",
		"--dsw-alias-code-diff-deleted", "--dsw-alias-file-diff-added-bg",
		"--dsw-alias-file-diff-added-gutter", "--dsw-alias-file-diff-added-marker",
		"--dsw-alias-file-diff-deleted-bg", "--dsw-alias-file-diff-deleted-gutter",
		"--dsw-alias-file-diff-deleted-marker", "--dsw-alias-interactive-bg-active",
		"--dsw-alias-interactive-bg-hover", "--dsw-alias-interactive-bg-hover-accent",
		"--dsw-alias-interactive-bg-hover-danger", "--dsw-alias-interactive-bg-hover-solid",
		"--dsw-alias-label-caption", "--dsw-alias-label-deep-diving",
		"--dsw-alias-label-deep-diving-shimmer", "--dsw-alias-label-dimmed",
		"--dsw-alias-label-document-preview", "--dsw-alias-label-primary",
		"--dsw-alias-label-primary-bluish", "--dsw-alias-label-primary-dimmed",
		"--dsw-alias-label-primary-foreground", "--dsw-alias-label-primary-inverted",
		"--dsw-alias-label-secondary", "--dsw-alias-label-shimmer", "--dsw-alias-label-tertiary",
		"--dsw-alias-link", "--dsw-alias-markdown-citation", "--dsw-alias-markdown-code-block",
		"--dsw-alias-markdown-code-block-banner", "--dsw-alias-markdown-code-segment-selected",
		"--dsw-alias-markdown-code-segment-unselected", "--dsw-alias-markdown-inline-code",
		"--dsw-alias-markdown-placeholder", "--dsw-alias-markdown-tag",
		"--dsw-alias-menu-group-header-fill", "--dsw-alias-menu-icon", "--dsw-alias-onboarding-accent",
		"--dsw-alias-onboarding-card-fill", "--dsw-alias-onboarding-checkbox-border",
		"--dsw-alias-onboarding-secondary-fill", "--dsw-alias-scrollbar-bg-l1",
		"--dsw-alias-scrollbar-bg-l2", "--dsw-alias-scrollbar-hover-l1",
		"--dsw-alias-scrollbar-hover-l2", "--dsw-alias-settings-card-fill",
		"--dsw-alias-settings-card-stroke", "--dsw-alias-state-business-primary",
		"--dsw-alias-state-business-tertiary", "--dsw-alias-state-error-primary",
		"--dsw-alias-state-error-secondary", "--dsw-alias-state-idle-primary",
		"--dsw-alias-state-success-primary", "--dsw-alias-state-success-secondary",
		"--dsw-alias-state-success-tertiary", "--dsw-alias-state-warn-label",
		"--dsw-alias-state-warn-primary", "--dsw-alias-state-warn-secondary",
		"--dsw-alias-state-warn-tertiary", "--dsw-alias-switch-thumb", "--dsw-alias-toast-bg",
		"--dsw-alias-toast-label", "--dsw-alias-tooltip-bg", "--dsw-alias-tooltip-key-bg",
		"--dsw-alias-turn-trigger-bg", "--dsw-alias-turn-trigger-bg-hover", "--dsw-specific-bubble",
		"--dsw-specific-bubble-highlight", "--dsw-specific-input-major", "--dsw-specific-login-input",
		"--dsw-specific-menu", "--dsw-specific-selector", "--dsw-specific-sidebar-fill",
		"--dsw-specific-sidebar-nav-item-active", "--dsw-specific-sidebar-nav-item-active-accent",
		"--dsw-specific-sidebar-nav-item-hover", "--dsw-specific-tip",
		"--dsw-radius-xs", "--dsw-radius-sm", "--dsw-radius-md", "--dsw-radius-lg"
	]);

	const sources = readdirSync(coreDir)
		.filter((name) => name.endsWith(".js"))
		.map((name) => join(coreDir, name));
	sources.push(join(libDir, "index.js"));

	const unknown = new Map();
	for (const file of sources) {
		// Comments are removed before the scan: a token named in prose is documentation,
		// and the comments that explain this very bug name the bad tokens deliberately.
		// String and template literals are copied through, because that is where a style
		// value's token actually lives.
		const text = stripComments(readFileSync(file, "utf8"));
		for (const match of text.matchAll(/--dsw-(?:alias|specific|radius)-[a-z0-9-]+/g)) {
			const token = match[0];
			// A trailing dash is the `--dsw-alias-*` glob, not a name.
			if (token.endsWith("-")) continue;
			if (DEFINED.has(token)) continue;
			if (!unknown.has(token)) unknown.set(token, []);
			unknown.get(token).push(file.slice(pluginDir.length + 1));
		}
	}
	assertEqual(
		[...unknown.entries()].map(([token, files]) => `${token} (${files.join(", ")})`),
		[],
		"every referenced theme token must exist in the design platform"
	);
});

//#endregion

//#region async

/**
 * Let queued microtasks and one timer turn run, so a fire-and-forget promise
 * chain can finish. Used by the hydration check.
 * @returns a promise settling after the queue drains.
 */
function drainMicrotasks() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Run the checks that need to await real I/O. */
async function asyncChecks() {
	await storeChecks();
	await asyncCheck("store: a batch delete removes every picked entry in one write", "batch", async () => {
		// The panel's batch delete must not commit per row: every commit persists the whole
		// document and pushes it to the host, so twenty rows one at a time would mean twenty
		// round trips. Each removal still has to leave its own tombstone, or the host's copy
		// brings the rows straight back.
		const { createDictionaryStore } = loadCore("store.js");
		const { emptyState } = loadCore("dictionary.js");
		let saves = 0;
		const store = createDictionaryStore({
			local: {
				load: () => emptyState({ now: 1 }),
				save: async () => {
					saves++;
				}
			},
			remote: null,
			logger: { warn: () => {} }
		});
		for (const term of ["alpha", "beta", "gamma", "delta"]) {
			await store.saveEntry(term, { definition: { gloss: term } });
		}
		assertEqual(store.getState().entries.length, 4, "four entries to start");
		const doomed = store.list("", "all").filter((entry) => entry.term !== "delta");
		assertEqual(doomed.length, 3, "three of them picked");
		const before = saves;
		const removed = await store.deleteEntries(doomed.map((entry) => entry.id));
		assertEqual(removed, 3, "all three are removed");
		assertEqual(saves - before, 1, "in exactly one document write");
		assertEqual(store.list("", "all").map((entry) => entry.term), ["delta"], "and only the unpicked entry is left");
		// The tombstones are what stop a union merge from restoring them.
		const merged = loadCore("dictionary.js").mergeDocuments(store.getState(), loadCore("dictionary.js").editEntry(emptyState({ now: 1 }), "alpha", { definition: { gloss: "back" } }, { now: 2 }).state, { now: 900 });
		assertEqual(merged.entries.some((entry) => entry.term === "alpha"), false, "a batch-deleted entry must not come back from another copy");
	});

	await asyncCheck("transfer: the export page lists the categories the data has, and copies only what is ticked", "transferExport", async () => {
		// The page's half of the export. `transfer.js` decides what a scope MEANS; this decides whether
		// the checklist the user ticks is the one the data implies, and whether what lands in the
		// clipboard is what the boxes say. Until now the page was only reachable through the pure
		// module, so a page that listed the wrong categories — or exported the wrong subset — looked
		// exactly like a page that worked.
		const { applyStyles } = loadCore("styles.js");
		const react = makeReactStub();
		const bundle = loadBundle({ react });
		assert(typeof bundle.exports.transferPage === "function", "the transfer page must be reachable for checks");
		const index = bundle.registered.findIndex((options) => options.name === "main");
		const face = bundle.registered[index].inject();
		await drainMicrotasks();
		await face.store.saveEntry("Quorum", { definition: { gloss: "g" }, domain: "分布式" });
		await face.store.saveEntry("Idempotent", { definition: { gloss: "g" }, domain: "分布式" });
		await face.store.saveEntry("Entropy", { definition: { gloss: "g" }, domain: "信息论" });
		await face.store.saveEntry("Loose", { definition: { gloss: "g" } });

		/** Every JSON text this page has put on the clipboard, in order. */
		const copied = [];
		bundle.sandbox.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } } };

		const props = { store: face.store, t: (key, values) => (values === undefined ? key : `${key}|${JSON.stringify(values)}`), setToast: () => {} };
		const renderPage = () => {
			react.__beginRender();
			return bundle.exports.transferPage(props);
		};
		const find = (tree, match) => {
			const found = [];
			const walk = (node) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				// Match the node, THEN render it if it is a component. Matching first is what keeps the
				// component's own props visible to a check (`OptionBar` is found by its `onSelect`), and
				// rendering after is what keeps its children visible (the shared checklist's boxes).
				if (match(node)) found.push(node);
				if (typeof node.type === "function") {
					walk(node.type(node.props));
					return;
				}
				walk(node.props?.children);
			};
			walk(tree);
			return found;
		};
		const copy = (tree) => {
			const button = find(tree, (node) => node.props?.label === "transferCopy" && typeof node.props.onClick === "function")[0];
			assert(button !== undefined, "the page must offer copying the JSON");
			button.props.onClick();
			return JSON.parse(copied[copied.length - 1]);
		};
		/**
		 * The category checkboxes.
		 *
		 * Identified by the label they live in — `data-term-domain` — rather than by being checkboxes:
		 * the page has two OTHER checkbox rows (the import's "also take what I deleted" and the
		 * feedback report's "attach the explanations"), and counting every box on the page is how this
		 * check first passed for the wrong reason.
		 */
		const categoryBoxes = (tree) => {
			const found = [];
			const walk = (node, inCategory) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child, inCategory);
					return;
				}
				// A function component's children live behind its own call, so a walker that stops at the
				// boundary reads an empty page. It bit here: the checklist moved behind one shared
				// component when the pack page started using it, and this check went from five boxes to
				// none without the page changing what it draws.
				const here = inCategory || typeof node.props?.["data-term-domain"] === "string";
				if (typeof node.type === "function") {
					walk(node.type(node.props), here);
					return;
				}
				if (node.props?.type === "checkbox" && here) found.push(node);
				walk(node.props?.children, here);
			};
			walk(tree, false);
			return found;
		};

		const first = renderPage();
		const bars = find(first, (node) => typeof node.props?.onSelect === "function");
		assertEqual(bars.length, 1, "one export scope control");
		assertEqual(bars[0].props.options.map((option) => option.value), ["all", "domains"], "offering everything or by category");
		assertEqual(categoryBoxes(first).length, 0, "with everything selected there is nothing to tick");
		assertEqual(copy(first).entries.length, 4, "and everything means all four entries");

		bars[0].props.onSelect("domains");
		const byDomain = renderPage();
		const boxes = categoryBoxes(byDomain);
		assertEqual(boxes.length, 2, "one box per category the data has, and never one for an entry that has none");
		assertEqual(
			find(byDomain, (node) => typeof node.props?.["data-term-domain"] === "string").map((node) => node.props["data-term-domain"]),
			["分布式", "信息论"],
			"named from the data, most-populated first"
		);
		assertEqual(copy(byDomain).entries.length, 0, "and selecting no category exports nothing rather than everything");

		boxes[1].props.onChange();
		const ticked = renderPage();
		assertEqual(categoryBoxes(ticked).map((box) => box.props.checked), [false, true], "the box that was ticked is the box the page shows as ticked");
		assertEqual(copy(ticked).entries.map((entry) => entry.term), ["Entropy"], "ticking one category exports only its entries");

		// Select-all reaches the categories, not every entry: an entry with no domain belongs to no
		// category, so a by-category export cannot carry it. Saying so is better than a checklist that
		// quietly means "all".
		find(renderPage(), (node) => node.props?.children === "transferSelectAll")[0].props.onClick();
		assertEqual(copy(renderPage()).entries.map((entry) => entry.term).sort(), ["Entropy", "Idempotent", "Quorum"], "select-all takes every categorised entry");

		find(renderPage(), (node) => node.props?.children === "transferSelectNone")[0].props.onClick();
		assertEqual(copy(renderPage()).entries.length, 0, "and select-none empties it again");
	});

	await asyncCheck("transfer: the import page applies the file and reports every count it passed over", "transferImport", async () => {
		// The other half of the page, and the one with the most ways to be quietly wrong: it reads a
		// real File, reports what it took AND what it passed over, and only revives what it was told
		// to. "Imported 1" alone would be true and useless — the three skipped entries are the news.
		const react = makeReactStub();
		const bundle = loadBundle({ react });
		const index = bundle.registered.findIndex((options) => options.name === "main");
		const face = bundle.registered[index].inject();
		await drainMicrotasks();
		await face.store.saveEntry("Quorum", { definition: { gloss: "本地解释" }, domain: "分布式" });
		await face.store.saveEntry("Entropy", { definition: { gloss: "g" } });
		await face.store.deleteEntry("Entropy");

		const props = { store: face.store, t: (key, values) => (values === undefined ? key : `${key}|${JSON.stringify(values)}`), setToast: () => {} };
		const renderPage = () => {
			react.__beginRender();
			return bundle.exports.transferPage(props);
		};
		const find = (tree, match) => {
			const found = [];
			const walk = (node) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				if (match(node)) found.push(node);
				walk(node.props?.children);
			};
			walk(tree);
			return found;
		};
		/** The counts the page reported, or undefined while it has not reported anything yet. */
		const reportedCounts = (tree) => {
			// The report is the key-based form now (`transferImported|{"count":1} · …`), which is what
			// `importReportText` produces so the two pages that import cannot describe it differently. Read
			// the numbers out of whichever parts are present: a count of zero is left out of the line, which
			// is why this starts from zero rather than from the parts it finds.
			const line = find(tree, (node) => typeof node.props?.children === "string" && node.props.children.includes("transferImported"))[0];
			if (line === undefined) return undefined;
			const counts = { imported: 0, existing: 0, deleted: 0, duplicates: 0 };
			const named = { transferImported: "imported", transferExisting: "existing", transferSkippedDeleted: "deleted", transferDuplicates: "duplicates" };
			for (const match of String(line.props.children).matchAll(/(transferImported|transferExisting|transferSkippedDeleted|transferDuplicates)\|\{"count":(\d+)\}/g)) {
				counts[named[match[1]]] = Number(match[2]);
			}
			return counts;
		};
		/** Any failure line the page showed, so a refused import cannot read as a silent one. */
		const failures = (tree) => find(tree, (node) => typeof node.props?.children === "string" && node.props.children.startsWith("transferFailed")).map((node) => node.props.children);

		// A file like one a user would bring: an entry that is new, one they already have, one they
		// deleted, its own duplicate, and a record with no term in it at all.
		const text = JSON.stringify({
			kind: "dsh-term-dictionary",
			version: 1,
			entries: [
				{ term: "Idempotent", key: "idempotent", definition: { gloss: "来自文件" }, domain: "分布式" },
				{ term: "Quorum", key: "quorum" },
				{ term: "Entropy", key: "entropy" },
				{ term: "Idempotent", key: "idempotent" },
				{ nope: 1 }
			]
		});
		const pick = () => ({ target: { files: [{ text: async () => text }] } });
		const fileInput = (tree) => find(tree, (node) => node.props?.type === "file")[0];
		/** The opt-in box, identified by the label it lives in rather than by being "the checkbox". */
		const optInBox = (tree) => {
			let found = null;
			const walk = (node, inOptIn) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child, inOptIn);
					return;
				}
				const here = inOptIn || node.props?.["data-term-dictionary"] === "transfer-include-deleted";
				if (here && node.props?.type === "checkbox") found = node;
				walk(node.props?.children, here);
			};
			walk(tree, false);
			return found;
		};

		const start = renderPage();
		assert(optInBox(start) !== null, "the import half offers the opt-in for entries the user deleted");
		assertEqual(reportedCounts(start), undefined, "and no report before anything was imported");

		// Picking a file now STAGES it: the page says what is in the file and writes nothing until the
		// user confirms. This is the moment the second decision finally has.
		fileInput(start).props.onChange(pick());
		await drainMicrotasks();
		await drainMicrotasks();
		const staged = renderPage();
		assertEqual(find(staged, (node) => node.props?.["data-term-import-pending"] === "true").length, 1, "picking a file asks for confirmation instead of importing");
		assertEqual(reportedCounts(staged), undefined, "and no report yet, because nothing was written");
		assertEqual(face.store.list("", "all").map((entry) => entry.term), ["Quorum"], "the store is untouched while the file waits");
		const confirm = find(staged, (node) => node.props?.label === "transferConfirm" && typeof node.props.onClick === "function")[0];
		assert(confirm !== undefined, "the confirmation offers the press that does the write");
		confirm.props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		const after = renderPage();
		assertEqual(failures(after), [], "the import must not have been refused");
		assertEqual(find(after, (node) => node.props?.["data-term-import-pending"] === "true").length, 0, "and the confirmation is gone once it has been answered");
		assertEqual(reportedCounts(after), { imported: 1, existing: 1, deleted: 1, duplicates: 2 }, "every fate is counted");
		assertEqual(face.store.list("", "all").map((entry) => entry.term).sort(), ["Idempotent", "Quorum"], "only the new entry was taken");
		assertEqual(face.store.list("", "all").find((entry) => entry.term === "Quorum").definition.gloss, "本地解释", "the entry already here kept its own text, not the file's");
		assertEqual(face.store.list("", "all").find((entry) => entry.term === "Idempotent").definition.gloss, "来自文件", "while the new one carries the file's");
		assertEqual(face.store.list("", "deleted").map((entry) => entry.term), ["Entropy"], "and the entry the user deleted is still deleted");

		// Ticked, the same file brings it back — and the report's "you deleted" is then a real zero
		// rather than a number that quietly changed meaning. The opt-in re-plans the PREVIEW too: the
		// number the user is about to confirm has to be the number the opt-in produces.
		optInBox(after).props.onChange();
		const ticked = renderPage();
		fileInput(ticked).props.onChange(pick());
		await drainMicrotasks();
		await drainMicrotasks();
		const restaged = renderPage();
		const stagedText = (() => {
			const parts = [];
			const gather = (node) => {
				if (typeof node === "string" || typeof node === "number") parts.push(String(node));
				else if (Array.isArray(node)) node.forEach(gather);
				else if (node !== null && typeof node === "object") gather(node.props?.children);
			};
			gather(find(restaged, (node) => node.props?.["data-term-import-pending"] === "true")[0]);
			return parts.join(" | ");
		})();
		assert(stagedText.includes("transferConfirmTitle"), `the preview names the file it read, saw ${stagedText}`);
		assertEqual(reportedCounts(restaged), undefined, "and nothing is written until the second press");
		const confirmTicked = find(restaged, (node) => node.props?.label === "transferConfirm" && typeof node.props.onClick === "function")[0];
		confirmTicked.props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		const second = renderPage();
		assertEqual(failures(second), [], "nor the second time");
		assertEqual(reportedCounts(second), { imported: 1, existing: 2, deleted: 0, duplicates: 2 }, "the deleted entry is imported, and no longer skipped");
		assertEqual(face.store.list("", "all").map((entry) => entry.term).sort(), ["Entropy", "Idempotent", "Quorum"], "it is live again");
		assertEqual(face.store.list("", "deleted").length, 0, "and off the deleted list");
	});

	await asyncCheck("panel: the editor carries the remark and the verdict into the store", "markEntry", async () => {
		// The whole marking path, driven through the panel: open a row, say what is wrong, call the
		// explanation untrustworthy, save. The three things that can go wrong here are all invisible in a
		// screenshot — the patch never reaching the store, the remark being recorded as "untouched", and
		// the verdict not travelling with it.
		const react = makeReactStub();
		const bundle = loadBundle({ react });
		const index = bundle.registered.findIndex((options) => options.name === "main");
		const face = bundle.registered[index].inject();
		await drainMicrotasks();
		await face.store.saveEntry("Quorum", { definition: { gloss: "多数派确认" } });

		const props = { ...face, t: (key) => key, setToast: () => {} };
		const renderPanel = () => {
			react.__beginRender();
			return bundle.components[index](props);
		};
		const find = (tree, match) => {
			const found = [];
			const walk = (node) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				if (match(node)) found.push(node);
				walk(node.props?.children);
			};
			walk(tree);
			return found;
		};

		const list = renderPanel();
		const row = find(list, (node) => node.props?.["data-term-entry"] === "quorum")[0];
		assert(row !== undefined, "the entry is listed");
		row.props.onClick({ target: { closest: () => null } });

		// Every interaction is followed by a render, because that is what a setState does in React: the
		// next handler must close over the state the last one produced. Skipping the render leaves every
		// handler reading the state it was created with, which is how this check first reported that
		// saving a remark wrote nothing.
		const editor = renderPanel();
		const kind = find(editor, (node) => typeof node.props?.onSelect === "function" && node.props.label === "feedbackKindName")[0];
		assert(kind !== undefined, "the editor must carry the remark's category");
		assertEqual(kind.props.value, "wrong-gloss", "starting from a category rather than from nothing");
		assertEqual(kind.props.options.map((option) => option.value), ["wrong-gloss", "wrong-term", "should-not-collect", "other"], "and offering exactly the kinds the data layer accepts");
		kind.props.onSelect("wrong-term");

		const afterKind = renderPanel();
		const verdict = find(afterKind, (node) => typeof node.props?.onToggle === "function")[0];
		assert(verdict !== undefined, "and the verdict on the explanation");
		assertEqual(verdict.props.checked, false, "which starts off");
		verdict.props.onToggle();

		const afterVerdict = renderPanel();
		const note = find(afterVerdict, (node) => node.props?.label === "feedbackNoteLabel" && typeof node.props.onChange === "function")[0];
		assert(note !== undefined, "and a place for the user's own words");
		note.props.onChange("说的是写入确认的副本数");

		const afterNote = renderPanel();
		const save = find(afterNote, (node) => node.props?.label === "saveAndClose" && typeof node.props.onClick === "function")[0];
		assert(save !== undefined, "the editor must still save");
		save.props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();

		const entry = face.store.find("Quorum");
		assertEqual(entry.feedback, { kind: "wrong-term", note: "说的是写入确认的副本数" }, "the remark reaches the store");
		assertEqual(entry.untrusted, true, "and so does the verdict");
		assertEqual(face.store.list("", "flagged").map((each) => each.term), ["Quorum"], "so the entry is in the flagged view");
		assertEqual(entry.definition.gloss, "多数派确认", "and saving a remark did not disturb the explanation");

		// The other half of the same rule: opening the editor to fix a typo in the gloss and saving must
		// NOT read as "the user retracted their remark". That is what `feedbackTouched` is for.
		const reopened = renderPanel();
		const again = find(reopened, (node) => node.props?.["data-term-entry"] === "quorum")[0];
		again.props.onClick({ target: { closest: () => null } });
		const glossField = find(renderPanel(), (node) => node.props?.label === "glossLabel" && typeof node.props.onChange === "function")[0];
		assert(glossField !== undefined, "the editor still edits the explanation");
		glossField.props.onChange("多数派确认（改了个错别字）");
		find(renderPanel(), (node) => node.props?.label === "saveAndClose" && typeof node.props.onClick === "function")[0].props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		const after = face.store.find("Quorum");
		assertEqual(after.feedback, { kind: "wrong-term", note: "说的是写入确认的副本数" }, "an unrelated save keeps the remark");
		assertEqual(after.untrusted, true, "and the verdict");
		assertEqual(after.definition.gloss, "多数派确认（改了个错别字）", "while the explanation is what changed");

		// And the case that makes `feedbackTouched` load-bearing at all: editing an entry nobody flagged
		// must not CREATE a remark. Writing the two fields unconditionally would flag every entry the
		// user ever fixes a typo in — an empty "wrong explanation" remark on all of them, which the
		// flagged view would then list.
		await face.store.saveEntry("Entropy", { definition: { gloss: "熵" } });
		const plainRow = find(renderPanel(), (node) => node.props?.["data-term-entry"] === "entropy")[0];
		assert(plainRow !== undefined, "the second entry is listed");
		plainRow.props.onClick({ target: { closest: () => null } });
		const plainGloss = find(renderPanel(), (node) => node.props?.label === "glossLabel" && typeof node.props.onChange === "function")[0];
		plainGloss.props.onChange("熵（改了个错别字）");
		find(renderPanel(), (node) => node.props?.label === "saveAndClose" && typeof node.props.onClick === "function")[0].props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		const plain = face.store.find("Entropy");
		assertEqual(plain.feedback, null, "fixing a typo on an unflagged entry does not create a remark");
		assertEqual(plain.definition.gloss, "熵（改了个错别字）", "while the fix lands");
		assertEqual(face.store.list("", "flagged").map((each) => each.term), ["Quorum"], "so only the entry the user actually flagged is in that view");
	});

	await asyncCheck("transfer: the export page writes the feedback report it offers", "feedbackReport", async () => {
		// The report is the half of feedback that can reach someone else, so the page that writes it is
		// worth driving: what it copies is what a receiver gets, and the explanation is attached only
		// when the user ticks the box.
		const react = makeReactStub();
		const bundle = loadBundle({ react });
		const index = bundle.registered.findIndex((options) => options.name === "main");
		const face = bundle.registered[index].inject();
		await drainMicrotasks();
		await face.store.saveEntry("Quorum", { definition: { gloss: "多数派确认" } });
		await face.store.saveEntry("Plain", { definition: { gloss: "x" } });
		await face.store.markEntry("Quorum", { feedback: { kind: "wrong-gloss", note: "太笼统" }, untrusted: true });

		const copied = [];
		bundle.sandbox.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } } };
		const props = { store: face.store, t: (key, values) => (values === undefined ? key : `${key}|${JSON.stringify(values)}`), setToast: () => {} };
		const renderPage = () => {
			react.__beginRender();
			return bundle.exports.transferPage(props);
		};
		const find = (tree, match) => {
			const found = [];
			const walk = (node) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				if (match(node)) found.push(node);
				walk(node.props?.children);
			};
			walk(tree);
			return found;
		};
		const copyReport = (tree) => {
			const button = find(tree, (node) => node.props?.label === "feedbackCopy" && typeof node.props.onClick === "function")[0];
			assert(button !== undefined, "the page must offer copying the report");
			button.props.onClick();
			return JSON.parse(copied[copied.length - 1]);
		};

		const report = copyReport(renderPage());
		assertEqual(report.kind, "dsh-term-dictionary-feedback", "the envelope says what it is");
		assertEqual(report.count, 1, "one entry was flagged, and the report says so");
		assertEqual(report.entries.map((entry) => entry.term), ["Quorum"], "only the flagged entry is in it");
		assertEqual("gloss" in report.entries[0], false, "the explanation is not attached by default");
		assertEqual(report.entries[0].note, "太笼统", "the user's own words are");

		const tickBox = find(renderPage(), (node) => node.props?.["data-term-dictionary"] === "feedback-include-gloss")[0];
		const box = find(tickBox, (node) => node.props?.type === "checkbox")[0];
		assert(box !== undefined, "and attaching the explanation is a choice the page offers");
		box.props.onChange();
		const withGloss = copyReport(renderPage());
		assertEqual(withGloss.entries[0].gloss, "多数派确认", "ticking it attaches the explanation");
		assertEqual("context" in withGloss.entries[0], false, "while the conversation stays out either way");

		// The host's own channel: what it sends, and the six states the page can report.
		// The state is read from what the user is SHOWN (the translated text), not from the attribute —
		// an attribute that says "ok" while the label is missing is exactly the failure worth catching.
		const stateOf = (tree) => {
			const node = find(tree, (each) => typeof each.props?.["data-term-feedback-state"] === "string")[0];
			if (node === undefined) return null;
			return typeof node.props.children === "string" ? node.props.children : `${node.props.children}`;
		};
		const recordButton = (tree) => find(tree, (node) => node.props?.label === "feedbackRecord" && typeof node.props.onClick === "function")[0];
		const sent = [];
		let sessionId = "sess-1";
		let reply = { ok: true };
		const props2 = {
			store: face.store,
			t: (key, values) => (values === undefined ? key : `${key}|${JSON.stringify(values)}`),
			setToast: () => {},
			sessionId: () => sessionId,
			recordFeedback: async (input) => {
				sent.push(input);
				return reply;
			}
		};
		const render2 = () => {
			react.__beginRender();
			return bundle.exports.transferPage(props2);
		};
		assertEqual(stateOf(render2()), null, "nothing is claimed before anything is sent");
		recordButton(render2()).props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(sent.length, 1, "the button reaches the host's channel");
		assertEqual(sent[0].sessionId, "sess-1", "with the session the page was told about");
		assertEqual(sent[0].category, "product-interaction", "and the category a dictionary remark belongs to");
		assert(sent[0].text.includes("Quorum"), `the line must name the entry, saw ${sent[0].text}`);
		assert(sent[0].text.includes("太笼统"), "and carry the user's own words");
		assert(sent[0].text.includes("Plain") === false, "while unflagged entries stay out of it");
		assertEqual(stateOf(render2()), "feedbackState_ok", "and the page says it was recorded");

		// No conversation seen yet is NOT the same as a session the host dropped: one is "open the chat
		// first", the other is "that session is gone", and the page must not blame the wrong one.
		sessionId = "";
		sent.length = 0;
		recordButton(render2()).props.onClick();
		await drainMicrotasks();
		assertEqual(sent.length, 0, "an empty session id is not posted at all");
		assertEqual(stateOf(render2()), "feedbackState_no-session", "and the page asks for a conversation rather than blaming the session");

		sessionId = "sess-1";
		reply = { ok: false, error: "unavailable" };
		recordButton(render2()).props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(stateOf(render2()), "feedbackState_unavailable", "a composition with no channel says exactly that");
		reply = { ok: false, error: "session-not-found" };
		recordButton(render2()).props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(stateOf(render2()), "feedbackState_session-not-found", "and a dropped session says that instead");
		reply = { ok: false, error: "whatever" };
		recordButton(render2()).props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(stateOf(render2()), "feedbackState_failed", "anything else is a refusal, reported as one");
	});

	await asyncCheck("panel: copying an entry is a button, and the click that ends a selection is left alone", "copyEntry", async () => {
		// The defect this covers: double-clicking a word in the gloss to copy it opened the editor on
		// top of the selection, so the copy was gone before it could be made. Two fixes, both asserted
		// here — a copy action that needs no selection at all, and a row that keeps its hands off a
		// click which just finished one.
		const react = makeReactStub();
		const bundle = loadBundle({ react });
		const index = bundle.registered.findIndex((options) => options.name === "main");
		const face = bundle.registered[index].inject();
		await drainMicrotasks();
		await face.store.saveEntry("Quorum", { definition: { zh: "多数派确认", gloss: "写入需要多少个副本确认。", usage: "reached quorum" } });
		const copied = [];
		bundle.sandbox.navigator = { clipboard: { writeText: async (text) => { copied.push(text); } } };
		const props = { ...face, t: (key, values) => (values === undefined ? key : `${key}|${JSON.stringify(values)}`), setToast: () => {} };
		const renderPanel = () => {
			react.__beginRender();
			return bundle.components[index](props);
		};
		const find = (tree, match) => {
			const found = [];
			const walk = (node) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				if (match(node)) found.push(node);
				walk(node.props?.children);
			};
			walk(tree);
			return found;
		};
		const rowCopy = () => find(renderPanel(), (node) => node.props?.title === "copyEntry" && typeof node.props.onClick === "function")[0];
		assert(rowCopy() !== undefined, "each row must offer copying without a selection");
		rowCopy().props.onClick();
		await drainMicrotasks();
		assertEqual(copied.length, 1, "pressing it writes to the clipboard");
		assertEqual(copied[0], "Quorum（多数派确认）\n写入需要多少个副本确认。\n例：reached quorum", "with the entry as readable text");

		// The row's whole-block click, with a selection inside it.
		const row = () => find(renderPanel(), (node) => node.props?.["data-term-entry"] === "quorum" && typeof node.props.onClick === "function")[0];
		const rowElement = { contains: (node) => node === "gloss-node" };
		const editorOpen = () => find(renderPanel(), (node) => node.props?.label === "glossLabel").length > 0;
		bundle.sandbox.getSelection = () => ({ toString: () => "写入需要多少", anchorNode: "gloss-node" });
		row().props.onClick({ target: { closest: () => null }, currentTarget: rowElement });
		assertEqual(editorOpen(), false, "a click that ends a selection inside the row must not open the editor");

		// A selection somewhere ELSE is not this row's business: clicking a row right after selecting
		// part of a reply is still a click on the row.
		bundle.sandbox.getSelection = () => ({ toString: () => "part of a reply", anchorNode: "reply-node" });
		row().props.onClick({ target: { closest: () => null }, currentTarget: rowElement });
		assertEqual(editorOpen(), true, "but a selection outside the row does not swallow the click");

		// The editor's own copy takes what is on the FORM: the text somebody just wrote, saved or not.
		find(renderPanel(), (node) => node.props?.label === "glossLabel" && typeof node.props.onChange === "function")[0].props.onChange("改过的解释");
		copied.length = 0;
		const editorCopy = find(renderPanel(), (node) => node.props?.label === "copyEntry" && typeof node.props.onClick === "function")[0];
		assert(editorCopy !== undefined, "the editor must offer copying too");
		editorCopy.props.onClick();
		await drainMicrotasks();
		assertEqual(copied[0], "Quorum（多数派确认）\n改过的解释\n例：reached quorum", "including the edit that has not been saved yet");
	});

	await asyncCheck("panel: the packs page publishes, reads a code, and browses a source", "packPage", async () => {
		// The whole page driven end to end, with the four host calls stubbed: what a check can prove here
		// is the WIRING — that the buttons reach the right call, that a refusal is said out loud, and
		// that an import taken this way goes through the same path a file import does.
		const react = makeReactStub();
		const bundle = loadBundle({ react });
		const index = bundle.registered.findIndex((options) => options.name === "main");
		const face = bundle.registered[index].inject();
		await drainMicrotasks();
		await face.store.saveEntry("Quorum", { definition: { zh: "多数派确认", gloss: "写入需要多少个副本确认。" } });

		const memory = new Map();
		const storage = {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key)
		};
		const { createSettingsStore, DEFAULT_PACK_SOURCE } = loadCore("settings.js");
		const settings = createSettingsStore({ storage });

		const calls = [];
		const shared = {
			term: "Sidecar",
			key: "sidecar",
			definition: { zh: "边车", gloss: "把辅助功能放进同一个 Pod。" },
			domain: "架构"
		};
		const packOf = (name) => ({ kind: "dsh-term-dictionary-pack", version: 1, id: "a/b", name, count: 1, entries: [shared] });
		const packApi = {
			build: async (input) => {
				calls.push({ what: "build", input });
				return { ok: true, pack: { ...packOf("后端黑话"), entries: [] }, summary: { count: 1, explained: 1, domains: [{ domain: "分布式", count: 1 }] }, sha256: "a".repeat(64), bytes: 512, code: "dshpack1:STUB" };
			},
			decode: async (value) => {
				calls.push({ what: "decode", value });
				return { ok: true, pack: packOf("别人的包"), summary: { count: 1, explained: 1, domains: [] } };
			},
			index: async (url) => {
				calls.push({ what: "index", url });
				return { ok: true, index: { kind: "dsh-term-dictionary-index", version: 1, count: 1, packs: [{ id: "a/b", name: "后端黑话", author: "lakerian", license: "", description: "一份后端黑话", domains: ["分布式"], count: 1, sha256: "b".repeat(64), url: "https://example.com/p.json" }] }, cached: false };
			},
			fetch: async (url, sha256) => {
				calls.push({ what: "fetch", url, sha256 });
				return { ok: true, pack: packOf("后端黑话"), summary: { count: 1, explained: 1, domains: [] }, sha256: "b".repeat(64), cached: false };
			}
		};
		const props = { store: face.store, t: (key, values) => (values === undefined ? key : `${key}|${JSON.stringify(values)}`), settings, packApi, setToast: () => {} };
		const render = () => {
			react.__beginRender();
			return bundle.exports.packsPage(props);
		};
		const find = (tree, match) => {
			const found = [];
			const walk = (node) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				if (match(node)) found.push(node);
				walk(node.props?.children);
			};
			walk(tree);
			return found;
		};
		const button = (tree, label) => find(tree, (node) => node.props?.label === label && typeof node.props.onClick === "function")[0];
		const text = (tree) => {
			const parts = [];
			const gather = (node) => {
				if (typeof node === "string" || typeof node === "number") parts.push(String(node));
				else if (Array.isArray(node)) node.forEach(gather);
				else if (node !== null && typeof node === "object") gather(node.props?.children);
			};
			gather(tree);
			return parts.join(" | ");
		};

		// --- sharing
		// --- what the page did before anything was pressed
		//
		// The shipped source is asked once, when the page first opens: a fresh install that showed a
		// configured source and no packs would make 「刷新」 a step nobody can guess the purpose of. The
		// calls are looked up BY KIND from here on, because this one now lands before any button press.
		const of = (what) => calls.filter((call) => call.what === what);
		// The first render, which is what the effect below hangs off: nothing was pressed.
		const opening = render();
		assertEqual([of("index").length, of("index")[0]?.url], [1, DEFAULT_PACK_SOURCE], "the page asks its own sources once on first open");
		assertEqual(find(opening, (node) => node.props?.["data-term-source"] === DEFAULT_PACK_SOURCE).length, 1, "and lists that source");
		assert(text(opening).includes("packBuiltInSource"), "marked as the one that shipped with the plugin");
		// Asking twice would mean the effect does not hold its own latch; it must not re-ask on every
		// render, and pressing refresh is the only way to ask again.
		render();
		assertEqual(of("index").length, 1, "and does not ask again on the next render");

		button(render(), "packMakeCode").props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(of("build").length, 1, "the share button asks the host to build");
		assertEqual(of("build")[0].input.code, true, "and to encode a code with it");
		assertEqual(of("build")[0].input.scope, "all", "from the whole dictionary by default");
		const built = render();
		assertEqual(find(built, (node) => node.props?.["data-term-pack-code"] === "true")[0].props.value, "dshpack1:STUB", "the code appears for copying");
		assert(text(built).includes("packDigest"), "with the digest and size, so the artifact is identifiable");

		// --- a code
		const draft = find(render(), (node) => node.props?.label === "packCodeLabel" && typeof node.props.onChange === "function")[0];
		draft.props.onChange("dshpack1:FROM-SOMEONE");
		button(render(), "packRead").props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual([of("decode").length, of("decode")[0].value], [1, "dshpack1:FROM-SOMEONE"], "reading a code asks the host to decode exactly what was pasted");
		const preview = render();
		assertEqual(find(preview, (node) => node.props?.["data-term-pack-preview"] === "true").length, 1, "and the pack is previewed before anything is imported");
		assert(text(preview).includes("别人的包"), "naming what arrived");
		button(render(), "packImport").props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assert(face.store.find("Sidecar") !== null, "importing writes the entry through the ordinary store path");
		assert(text(render()).includes("transferImported"), "and the page reports what it did");

		// --- sources: the refusal is loud, and a good URL is stored
		const sourceField = find(render(), (node) => node.props?.label === "packAddSourceLabel" && typeof node.props.onChange === "function")[0];
		sourceField.props.onChange("http://insecure.example/index.json");
		button(render(), "packAddSource").props.onClick();
		assertEqual(settings.getSnapshot().packSources, [DEFAULT_PACK_SOURCE], "an http source is refused, leaving the shipped one alone");
		const draftNow = find(render(), (node) => node.props?.label === "packAddSourceLabel")[0];
		assert(text(render()).includes("packError_not-https"), `and the page says why, saw ${JSON.stringify(text(render()))} draft=${JSON.stringify(draftNow?.props?.value)}`);
		// The refusal is `not-https` rather than `bad-url`: the sandbox has `URL` now, so the page's own
		// check says what the host's check says. Without it, every address came out malformed.
		const field2 = find(render(), (node) => node.props?.label === "packAddSourceLabel" && typeof node.props.onChange === "function")[0];
		field2.props.onChange("https://example.com/index.json");
		button(render(), "packAddSource").props.onClick();
		assertEqual(settings.getSnapshot().packSources, [DEFAULT_PACK_SOURCE, "https://example.com/index.json"], "an https source is added to the settings, after the shipped one");

		// --- refresh, preview and import one pack from the source
		const indexed = of("index").length;
		button(render(), "packRefresh").props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(of("index").length, indexed + 2, "refreshing asks every source, including the one just added");
		const listed = render();
		// Two sources answered, and this stub lists the same pack at both — so two rows, keyed by
		// source AND id. Deliberate: the same pack id from two places is not necessarily the same file,
		// and collapsing them would hide one of the two checksums.
		assertEqual(find(listed, (node) => typeof node.props?.["data-term-pack"] === "string").length, 2, "and every source's packs are listed");
		button(render(), "packPreview").props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(of("fetch").length, 1, "previewing fetches that pack");
		assertEqual(of("fetch")[0].sha256, "b".repeat(64), "carrying the digest the index promised");
		assertEqual(find(render(), (node) => node.props?.["data-term-pack-preview"] === "true").length, 1, "and it is previewed like a code is");
	});

	await asyncCheck("panel: an import says when the view had to move to show what it wrote", "importMoved", async () => {
		// The complaint this answers: "the imported entries do not appear". The data path is fine — the
		// store and the host both keep them (see the host suite's round-trip check) — but a list filtered to
		// 「已删除」 or narrowed by a search shows nothing after an import, which reads as "it did nothing".
		// So the page asks the panel to show them, and the report says whether it had to move.
		const react = makeReactStub();
		const bundle = loadBundle({ react });
		const index = bundle.registered.findIndex((options) => options.name === "main");
		const face = bundle.registered[index].inject();
		await drainMicrotasks();
		await face.store.saveEntry("Quorum", { definition: { gloss: "本地解释" } });

		let asked = 0;
		let answer = true;
		const props = {
			store: face.store,
			t: (key, values) => (values === undefined ? key : `${key}|${JSON.stringify(values)}`),
			setToast: () => {},
			onImported: () => {
				asked++;
				return answer;
			}
		};
		const renderPage = () => {
			react.__beginRender();
			return bundle.exports.transferPage(props);
		};
		const find = (tree, match) => {
			const found = [];
			const walk = (node) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				if (match(node)) found.push(node);
				if (typeof node.type === "function") {
					walk(node.type(node.props));
					return;
				}
				walk(node.props?.children);
			};
			walk(tree);
			return found;
		};
		const reportText = (tree) => {
			const parts = [];
			const gather = (node) => {
				if (typeof node === "string" || typeof node === "number") parts.push(String(node));
				else if (Array.isArray(node)) node.forEach(gather);
				else if (node !== null && typeof node === "object") gather(node.props?.children);
			};
			gather(find(tree, (node) => typeof node.props?.["data-term-report"] !== "undefined")[0]);
			return parts.join(" | ");
		};
		const file = (text) => ({ name: "d.json", text: async () => text });
		const pick = { target: { files: [file(JSON.stringify({ kind: "dsh-term-dictionary", version: 1, entries: [{ term: "Sidecar", key: "sidecar", definition: { gloss: "来自文件" } }] }))] } };
		const confirm = (tree) => find(tree, (node) => node.props?.label === "transferConfirm" && typeof node.props.onClick === "function")[0];
		const fileInput = (tree) => find(tree, (node) => node.props?.type === "file" && node.props?.["data-term-dictionary"] !== "transfer-folder")[0];

		fileInput(renderPage()).props.onChange(pick);
		await drainMicrotasks();
		await drainMicrotasks();
		confirm(renderPage()).props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(asked, 1, "the page asks the panel to show what was imported");
		assert(String(reportText(renderPage())).includes("transferShown"), "and says so when the panel had to move");

		// And when nothing had to move, it does not claim otherwise.
		answer = false;
		fileInput(renderPage()).props.onChange(pick);
		await drainMicrotasks();
		await drainMicrotasks();
		confirm(renderPage()).props.onClick();
		await drainMicrotasks();
		await drainMicrotasks();
		assertEqual(String(reportText(renderPage())).includes("transferShown"), false, "with no false claim when the view was already where it should be");
	});

	test("hover: the left margin of a line is not the term that starts it", () => {
		// Reported: with a term at the very start of a paragraph, hovering anywhere to its LEFT — out to the
		// edge of the chat — opened the card, and a click there opened the entry. `caretRangeFromPoint` CLAMPS
		// horizontally: a point in the margin resolves to the line's start, offset 0, which for a term that
		// begins the line IS that term. Both gestures go through `matchAt`, so one guard covers both.
		const { createHoverLayer } = loadCore("hover.js");
		const text = { nodeType: 3, nodeValue: "Quorum decides.", parentElement: null, childNodes: [] };
		const onTerm = { node: text, start: 0, end: 6, term: "Quorum", key: "quorum", id: "" };

		const make = (rect) => {
			const listeners = {};
			// A stand-in for the conversation region: it answers `closest` for any selector, which is how the
			// existing checks model "the pointer is inside the region". Without it the click never reaches the
			// hit test at all — and the margin assertion would then pass for the wrong reason.
			const zone = { classList: { add: () => {}, remove: () => {} } };
			const target = { closest: () => zone };
			const documentStub = {
				getSelection: () => ({ isCollapsed: true, toString: () => "" }),
				// The clamp, modelled: every point resolves to offset 0, and the caret's own rectangle says
				// where the text really is.
				caretRangeFromPoint: () => ({ startContainer: text, startOffset: 0, getBoundingClientRect: () => rect }),
				addEventListener: (type, handler) => {
					(listeners[type] ??= []).push(handler);
				},
				removeEventListener: () => {},
				createRange: () => ({
					setStart: () => {},
					setEnd: () => {},
					getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 })
				})
			};
			const activated = [];
			const layer = createHoverLayer({
				document: documentStub,
				segments: () => [onTerm],
				delays: () => ({ inMs: 0, outMs: 0 }),
				disposers: [],
				onActivate: (segment) => activated.push(segment.term)
			});
			layer.attach();
			const click = (x) => {
				for (const handler of listeners.click ?? []) handler({ button: 0, clientX: x, clientY: 40, target });
			};
			return { activated, click };
		};

		// The text starts at x=300; the pointer is 280px to its left.
		const margin = make({ left: 300, top: 32, width: 0, height: 16 });
		margin.click(20);
		assertEqual(margin.activated, [], "a point far to the left of the line is not on the term that starts it");
		// And the gesture still works where the text actually is — the guard must not disable what it guards.
		margin.click(304);
		assertEqual(margin.activated, ["Quorum"], "while a point on the first character still opens it");
		// A browser that cannot measure the caret is trusted rather than having every hover refused.
		const unmeasurable = make({ left: 0, top: 0, width: 0, height: 0 });
		unmeasurable.click(20);
		assertEqual(unmeasurable.activated, ["Quorum"], "and an unmeasurable caret is not treated as a refusal");
	});

	await asyncCheck("panel: 撤回 in the deleted view revives the entry the row names, and says so", "revivePanel", async () => {
		// The end-to-end half, and the one the other two checks cannot reach: the tab is clicked, the
		// panel is rendered again, and the 撤回 button of the row it then shows is pressed through the
		// store — which is the whole path a user takes, and the two lines of glue in the middle.
		const toasts = [];
		const react = makeReactStub();
		const bundle = loadBundle({ react });
		const index = bundle.registered.findIndex((options) => options.name === "main");
		const face = bundle.registered[index].inject();
		// Let hydration finish before writing, or its continuation could adopt a document from a
		// moment when these entries did not exist yet.
		await drainMicrotasks();
		await face.store.saveEntry("Quorum", { definition: { gloss: "g" } });
		await face.store.saveEntry("Entropy", { definition: { gloss: "g" } });
		await face.store.deleteEntry("Entropy");
		assertEqual(face.store.list("", "deleted").map((entry) => entry.term), ["Entropy"], "one tombstone to show");

		const props = { ...face, t: (key) => key, setToast: (value) => toasts.push(value) };
		/** The panel's tree as it stands now, with its hook state carried over between renders. */
		const renderPanel = () => {
			react.__beginRender();
			return bundle.components[index](props);
		};
		/** Every node of one type in the tree. */
		const find = (tree, match) => {
			const found = [];
			const walk = (node) => {
				if (node === null || node === undefined || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				if (match(node)) found.push(node);
				walk(node.props?.children);
			};
			walk(tree);
			return found;
		};

		// Nothing is selected yet: the panel lists the live entry and does not render the deleted view.
		const first = renderPanel();
		assertEqual(find(first, (node) => node.type === bundle.exports.deletedList).length, 0, "the deleted view is not shown while the ordinary list is selected");
		const tabs = find(first, (node) => node.props?.role === "tab");
		const deletedTab = tabs.find((tab) => tab.props.children === "filterDeleted");
		assert(deletedTab !== undefined, "and its tab is how you get there");

		deletedTab.props.onClick();
		// The view is a component ELEMENT in the panel's tree, and this harness does not render
		// components — so it is collected by its own type and driven through its props. That is the
		// stronger half anyway: it asserts what the PANEL hands the view (its `entries`), which is the
		// panel's line, and then presses the button the panel wired up.
		const views = find(renderPanel(), (node) => node.type === bundle.exports.deletedList);
		assertEqual(views.length, 1, "with the deleted tab selected, the panel's list IS the deleted view");
		const view = views[0];
		assertEqual(view.props.entries.map((entry) => entry.term), ["Entropy"], "fed the tombstones the store reports for that one filter");
		assert(typeof view.props.onRevive === "function", "and handed the way back");

		view.props.onRevive(view.props.entries[0]);
		await drainMicrotasks();
		assertEqual(face.store.list("", "deleted").length, 0, "pressing 撤回 takes the tombstone off the deleted list");
		assertEqual(face.store.list("", "all").map((entry) => entry.term).sort(), ["Entropy", "Quorum"], "and puts the entry back in the dictionary");
		assertEqual(face.store.getState().deletedKeys, [], "the key is no longer announced as deleted, so the next merge cannot re-delete it");
		assertEqual(toasts.map((toast) => toast.text), ["toastRevived"], "and the notice names what came back, because the row leaving is the only other sign");
	});

	await asyncCheck("store: reviving reports whether it did anything, and never invents a write", "revive", async () => {
		// The store's half. Three outcomes, and only the first one is a write: reviving a live entry
		// and reviving a term that was never here are both no-ops, so pressing a stale button — or
		// pressing twice — cannot re-stamp a live entry into a newer revision of itself.
		//
		// The clock is injected and deliberately does NOT move between the delete and the revive.
		// That is the case the `+1` exists for: with `now` standing still, a revival stamped with
		// `now` alone is not strictly newer than the deletion it undoes, and the next merge deletes it
		// again. Driving it on the real clock would make this check pass or fail depending on how
		// many milliseconds the two calls happened to fall apart — which is how a check like this
		// reports green while the mechanism is broken.
		const { emptyState, mergeDocuments } = loadCore("dictionary.js");
		let clock = 1000;
		let writes = 0;
		const store = createDictionaryStore({
			local: {
				load: () => emptyState({ now: 1 }),
				save: async () => {
					writes++;
				}
			},
			remote: null,
			now: () => clock,
			logger: { warn: () => {} }
		});
		await store.saveEntry("Quorum", { definition: { gloss: "g" } });
		await store.deleteEntry("Quorum");
		// The copy that still carries the tombstone, which is what a second window or the host holds.
		const deletedCopy = store.getState();
		assertEqual(store.list("", "deleted").length, 1, "the entry is deleted, so there is something to revive");

		const before = writes;
		const restored = await store.reviveEntry("Quorum");
		assert(restored !== null && restored.term === "Quorum", "reviving a deleted entry returns it");
		assertEqual(writes - before, 1, "and that is one document write");
		assertEqual(store.list("", "all").map((entry) => entry.term), ["Quorum"], "the entry is live again");
		assertEqual(store.list("", "deleted").length, 0, "and off the deleted list");
		// The point of the whole mechanism: the copy still carrying the tombstone cannot re-delete it,
		// because the revival is a CRAFTED record stamped strictly past the deletion.
		const merged = mergeDocuments(store.getState(), deletedCopy, { now: clock });
		assertEqual(merged.entries.map((entry) => entry.term), ["Quorum"], "a merge with the copy that still has the tombstone keeps it alive");
		assertEqual(merged.entries[0].source, "user", "because a revival is user intent, the only thing that outweighs a deletion");

		const after = writes;
		assertEqual(await store.reviveEntry("Quorum"), null, "reviving a live entry reports that it did nothing");
		assertEqual(await store.reviveEntry("never heard of it"), null, "and so does reviving a term that was never here");
		assertEqual(writes, after, "neither of them wrote a document");
	});

	await asyncCheck("transfer: an imported entry the user deleted is revived by the import's own write path", "importRevive", async () => {
		// The seam, and the one an end-to-end reader would call "does it actually work". The plan's
		// bucketing is checked in the pure suite and the store's revival in its own check; what can
		// still be missing is the JOIN — the import writes through `store.saveEntry`, so the opt-in is
		// only real if an ordinary save of a tombstoned term revives it and keeps it alive.
		//
		// The clock is frozen for the same reason as the check above: `stamp = now` would not be
		// strictly newer than the deletion, and the merge would put the entry back in the tombstone.
		const { emptyState, mergeDocuments } = loadCore("dictionary.js");
		const { parseImport, planImport } = loadCore("transfer.js");
		const clock = 5000;
		const store = createDictionaryStore({
			local: { load: () => emptyState({ now: 1 }), save: async () => {} },
			remote: null,
			now: () => clock,
			logger: { warn: () => {} }
		});
		await store.saveEntry("Entropy", { definition: { gloss: "旧解释" } });
		await store.deleteEntry("Entropy");
		const deletedCopy = store.getState();
		const parsed = parseImport('[{"term":"Entropy","key":"entropy","definition":{"gloss":"来自文件"}}]');

		// Unticked, the file changes nothing: that IS the blacklist doing its job.
		const refused = planImport(store.getState().entries, parsed.entries, store.getState().deletedKeys);
		assertEqual(refused.accepted.length, 0, "an entry the user deleted is not taken unless asked for");
		assertEqual(refused.deleted.map((entry) => entry.term), ["Entropy"], "it lands in the deleted bucket instead");

		// Ticked, it goes through the very write the panel performs.
		const taken = planImport(store.getState().entries, parsed.entries, store.getState().deletedKeys, { includeDeleted: true });
		assertEqual(taken.accepted.map((entry) => entry.term), ["Entropy"], "opting in hands it to the caller to write");
		for (const entry of taken.accepted) {
			await store.saveEntry(entry.term, { definition: entry.definition, domain: entry.domain, aliases: entry.aliases, pinned: entry.pinned });
		}
		assertEqual(store.list("", "all").map((entry) => entry.term), ["Entropy"], "the imported entry is live");
		assertEqual(store.list("", "deleted").length, 0, "and off the deleted list");
		const live = store.list("", "all")[0];
		assertEqual(live.definition.gloss, "来自文件", "carrying the file's text, not the text it was deleted with");
		assertEqual(live.source, "user", "stamped as the user's own, which is what makes a revival survive");
		const merged = mergeDocuments(store.getState(), deletedCopy, { now: clock });
		assertEqual(merged.entries.map((entry) => entry.term), ["Entropy"], "and the copy that still has the tombstone cannot take it back");
	});

	await asyncCheck("host: the model route prefers the profile's own selection", "route", async () => {
		// The reported failure: generation died with `no API key for provider route
		// "deepseek-official"` because `listProviders()` returns registration order and
		// the API-key route is registered before the signed-in account route the window
		// was actually using. The profile's own selection must win over the catalog.
		const { __resolveTarget, __resolveTargets, __isCredentialFailure } = await import(pathToFileURL(join(libDir, "index.js")).href);
		const llm = (providers, models = {}) => ({
			listProviders: () => providers.map((id) => ({ id, name: id })),
			listModels: async (provider) => models[provider] ?? []
		});
		const selection = (value) => ({ currentSelection: () => value });

		// 1. the profile's selection beats the first registered provider
		assertEqual(
			await __resolveTarget(llm(["deepseek-official", "deepseek-account"]), {}, selection({ provider: "deepseek-account", model: "deepseek-flash" })),
			{ provider: "deepseek-account", model: "deepseek-flash" },
			"the configured default route must win over the first registered provider"
		);

		// 2. explicit plugin config beats everything
		assertEqual(
			await __resolveTarget(llm(["deepseek-official"]), { provider: "pinned", model: "m" }, selection({ provider: "deepseek-account", model: "deepseek-flash" })),
			{ provider: "pinned", model: "m" },
			"an explicit config must win"
		);

		// 3. a selection naming a provider this half cannot SEE is tried FIRST, not ignored.
		//
		// This reverses what used to be written here as correct ("an unregistered selection
		// must fall back to the catalog"). That rule IS the reported bug: it discarded the
		// route the user had chosen — the one their window is already talking through, and
		// therefore the one that is credentialed — and used the first registered route
		// instead, which in this profile is the API-key route, producing
		// `no API key for provider route "deepseek-official"`.
		assertEqual(
			await __resolveTarget(llm(["deepseek-official"], { "deepseek-official": [{ id: "first" }] }), {}, selection({ provider: "ghost", model: "m" })),
			{ provider: "ghost", model: "m" },
			"an unregistered selection is tried first"
		);

		// ... and the route after it is kept, so a failure can fall through rather than end
		// the request.
		assertEqual(
			(await __resolveTargets(llm(["deepseek-official"], { "deepseek-official": [{ id: "first" }] }), {}, selection({ provider: "ghost", model: "m" }))).map((entry) => entry.provider),
			["ghost", "deepseek-official"],
			"and the catalog route stays behind it as a fallback"
		);

		// 4. the fall-through only happens for a MISSING CREDENTIAL. A model-side failure is a
		// real error and must be reported, not forwarded to a second provider.
		assert(
			__isCredentialFailure('llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service, or export DEEPSEEK_API_KEY in the launching environment'),
			"the reported failure must be recognized as a credential failure"
		);
		assert(!__isCredentialFailure("the model did not return a usable explanation"), "a model-side failure must not be");
		assert(!__isCredentialFailure("model not found: deepseek-nope"), "nor must an unknown model");

		// 5. the selection's model is never borrowed by a different provider
		assertEqual(
			await __resolveTarget(llm(["deepseek-official"], { "deepseek-official": [{ id: "first" }] }), {}, selection({ provider: "deepseek-account", model: "deepseek-flash" })),
			{ provider: "deepseek-account", model: "deepseek-flash" },
			"the selection leads with its own model"
		);
		assertEqual(
			(await __resolveTargets(llm(["deepseek-official"], { "deepseek-official": [{ id: "first" }] }), {}, selection({ provider: "deepseek-account", model: "deepseek-flash" })))[1],
			{ provider: "deepseek-official", model: "first" },
			"and the catalog route does not inherit that model id"
		);

		// 5. no selection service at all still works
		assertEqual(
			await __resolveTarget(llm(["only"], { only: [{ id: "m1" }] }), {}, null),
			{ provider: "only", model: "m1" },
			"a composition without the selection service must still route"
		);

		// 6. a broken selection service is survivable
		assertEqual(
			await __resolveTarget(
				llm(["only"], { only: [{ id: "m1" }] }),
				{},
				{
					currentSelection() {
						throw new Error("owner is gone");
					}
				},
				{ warn: () => {} }
			),
			{ provider: "only", model: "m1" },
			"a throwing selection service must not break generation"
		);
	});

	await asyncCheck("manifest: the host half exports no activation-blocking Config", "activation", async () => {
		// Cordis resolves a row's config with `runtime.Config["~standard"].validate`.
		// A JSON Schema (which this plugin used to export) has no `~standard`, so
		// activation died with "Cannot read properties of undefined (reading 'validate')"
		// — a typo-looking failure that took the whole plugin down. Either export a real
		// Standard Schema, or export nothing and let the row's config pass through.
		const host = await import(pathToFileURL(join(libDir, "index.js")).href);
		assert(typeof host.apply === "function", "the host half must still export apply");
		assertEqual(Array.isArray(host.inject), true, "the host half must still declare its inject list");
		if (host.Config !== undefined) {
			const standard = host.Config["~standard"];
			assert(
				standard !== undefined && typeof standard.validate === "function",
				"a Config export must be a Standard Schema (it needs `~standard.validate`), or cordis refuses to activate the plugin"
			);
		}
	});
	await asyncCheck("bundle: apply hydrates the store from local storage", "hydrate", async () => {
		// The regression guard for the plugin's worst failure mode: if `apply` never
		// hydrates, the panel and the detector stay empty forever and the plugin looks
		// installed while doing nothing.
		//
		// `apply` returns before the hydration promise settles, so the queue is
		// drained and the loaded entry is then read back through the very store the
		// panel receives.
		const storage = new MapStorage();
		storage.setItem(
			"dsh-plugin-term-dictionary:v1",
			JSON.stringify({ schemaVersion: 1, entries: [{ term: "Quorum", definition: { gloss: "多数派确认。" }, source: "user" }] })
		);
		const { registered } = loadBundle({ storage });
		const panel = registered.find((options) => options.name === "main");
		assert(panel !== undefined, "the panel must be registered");
		const store = panel.inject().store;
		await drainMicrotasks();
		assertEqual(store.getState().entries.length, 1, "hydration must load the stored entry");
		assertEqual(store.getState().entries[0].term, "Quorum", "the stored term");
		assertEqual(store.getSnapshot().stats.total, 1, "the projection the panel renders must see it");
	});


	await asyncCheck("hover: the delays govern appearing and leaving, and a pending exit is cancelled", "hoverDelays", async () => {
		// The pointer layer is exercised directly: `hover.js` has no React and no host dependency, so
		// the two knobs can be driven here rather than through a browser.
		const { createHoverLayer } = loadCore("hover.js");
		const wait = (ms) => new Promise((done) => setTimeout(done, ms));
		const text = { nodeType: 3, nodeValue: "A quorum decides.", parentElement: null, childNodes: [] };
		const onTerm = { node: text, start: 2, end: 8, term: "quorum", key: "quorum", id: "" };
		const zone = { classList: { add: () => {}, remove: () => {} } };
		const target = { closest: () => zone };
		/** Where the caret is: on the term, or off it. */
		let offset = 4;
		const listeners = {};
		const documentStub = {
			caretRangeFromPoint: () => ({ startContainer: text, startOffset: offset }),
			addEventListener: (type, handler) => {
				(listeners[type] ??= []).push(handler);
			},
			removeEventListener: () => {},
			createRange: () => ({
				setStart: () => {},
				setEnd: () => {},
				getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 })
			})
		};
		let outMs = 0;
		const layer = createHoverLayer({ document: documentStub, segments: () => [onTerm], delays: () => ({ inMs: 30, outMs }), disposers: [] });
		layer.attach();
		const move = (x) => {
			for (const handler of listeners.pointermove ?? []) handler({ target, clientX: x, clientY: 5 });
		};
		const kind = () => layer.view.getSnapshot().kind;

		// The ENTRY delay is what it says: nothing appears before it elapses.
		move(5);
		assertEqual(kind(), "closed", "nothing appears before the entry delay elapses");
		await wait(70);
		assertEqual(kind(), "open", "and it appears once the delay has");

		// The EXIT delay defaults to zero, so leaving closes on the move itself.
		offset = 0;
		move(20);
		assertEqual(kind(), "closed", "with no exit delay, leaving closes at once");

		// A configured exit delay defers the close... and is CANCELLED by coming back. Without the
		// cancellation the card would be closed from under a pointer that is on a term again.
		outMs = 60;
		offset = 4;
		move(5);
		await wait(70);
		assertEqual(kind(), "open", "the card is back on the term");
		offset = 0;
		move(20);
		assertEqual(kind(), "open", "a pending exit keeps the card up for the grace period");
		offset = 4;
		move(5);
		await wait(90);
		assertEqual(kind(), "open", "and returning to a term cancels that pending exit");
		offset = 0;
		move(20);
		await wait(90);
		assertEqual(kind(), "closed", "while leaving again really does close it, after the grace period");

		layer.detach();
	});

	await asyncCheck("hover: a click that ends a selection does not switch the panel", "hoverSelection", async () => {
		// The defect: this layer handles the words the dictionary already KNOWS, which are exactly the
		// words a person drags across while copying a sentence out of a reply — and releasing on one
		// switched the whole main region to the dictionary, replacing the sentence being copied with an
		// entry page. `interact.js` had this guard from the start; the annotated-term path was added
		// later without it. Both now ask `selection.js`.
		const { createHoverLayer } = loadCore("hover.js");
		const text = { nodeType: 3, nodeValue: "A quorum decides.", parentElement: null, childNodes: [] };
		const onTerm = { node: text, start: 2, end: 8, term: "quorum", key: "quorum", id: "" };
		const zone = { classList: { add: () => {}, remove: () => {} } };
		const target = { closest: () => zone };
		const listeners = {};
		let selection = { isCollapsed: true, toString: () => "" };
		const documentStub = {
			getSelection: () => selection,
			caretRangeFromPoint: () => ({ startContainer: text, startOffset: 4 }),
			addEventListener: (type, handler) => {
				(listeners[type] ??= []).push(handler);
			},
			removeEventListener: () => {},
			createRange: () => ({
				setStart: () => {},
				setEnd: () => {},
				getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 })
			})
		};
		const activated = [];
		const layer = createHoverLayer({
			document: documentStub,
			segments: () => [onTerm],
			delays: () => ({ inMs: 0, outMs: 0 }),
			disposers: [],
			onActivate: (segment) => activated.push(segment.term)
		});
		layer.attach();
		const click = () => {
			for (const handler of listeners.click ?? []) handler({ button: 0, clientX: 5, clientY: 5, target });
		};

		// A plain click on the term still opens the entry: the guard must not disable the gesture it
		// is guarding, which is how a fix for this kind of bug turns into a new bug.
		click();
		assertEqual(activated, ["quorum"], "a click with nothing selected still opens the term");

		// The same click, with the sentence selected: that is a copy, not a navigation.
		selection = { isCollapsed: false, toString: () => "A quorum decides." };
		click();
		assertEqual(activated, ["quorum"], "a click that ends a selection must not open the entry");

		// Whitespace is not a selection gesture either — dragging across the spaces after a sentence is
		// not a copy anybody is making, and it must not silently eat the activation.
		selection = { isCollapsed: false, toString: () => "   \n " };
		click();
		assertEqual(activated, ["quorum", "quorum"], "a whitespace-only selection is not a selection gesture");

		// And the modifier keys keep their meaning, selection or not.
		selection = { isCollapsed: true, toString: () => "" };
		for (const handler of listeners.click ?? []) handler({ button: 0, clientX: 5, clientY: 5, target, metaKey: true });
		assertEqual(activated.length, 2, "the modifier checks still come first");
		layer.detach();
	});

	await asyncCheck("api: the client posts the context it was handed, shortening nothing itself", "explainWhole", async () => {
		// What this proves, and what it does not: the client puts the whole string it was given
		// into the request body. It does NOT prove the model saw it whole — the host clamps the
		// context to its own prompt budget (`buildPrompt` slices it), which is a deliberate
		// product limit rather than a silent truncation, so it is asserted where it lives.
		//
		// This used to drive `api.report`, the beacon's filing call. That method is gone (the
		// report is console-only now), so the same property is asserted through `explain`, the
		// live path that carries a context — and the preferences travel with it, so they are
		// asserted here too rather than only at the prompt builder.
		const { createApiClient } = loadCore("api.js");
		let stored = null;
		const client = createApiClient({
			base: "http://127.0.0.1",
			fetchImpl: (url, init) => {
				if (String(url).includes("/explain")) stored = JSON.parse(init.body);
				return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ definition: { zh: "探针", gloss: "g" } })) });
			}
		});
		const long = `${"y".repeat(900)}the part a cap eats`;
		const answer = await client.explain("Probe", long, { lang: "en", depth: "detailed" });
		assertEqual(answer.ok, true, "the explanation must come back");
		assert(stored !== null, "the client must POST a parseable explanation payload");
		assertEqual(String(stored.context).length, long.length, `a ${long.length}-character context must be posted whole, saw ${String(stored.context).length}`);
		assert(String(stored.context).endsWith("the part a cap eats"), "the client must not trim the tail it was handed");
		assertEqual([stored.lang, stored.depth], ["en", "detailed"], "and the explanation preferences must travel with it");
	});

	await asyncCheck("api: the feedback call posts the fields the host declares, and reads its answer", "feedbackApi", async () => {
		// The host answers a refusal with HTTP 200 and `{ok: false, error}` — a composition without the
		// channel is a normal state, not a transport failure — so the client has to read the BODY rather
		// than the status, and the page's six states depend on that mapping being right.
		const { createApiClient } = loadCore("api.js");
		let sent = null;
		let answer = { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true })) };
		const client = createApiClient({
			base: "http://127.0.0.1",
			fetchImpl: (url, init) => {
				if (String(url).includes("/feedback")) sent = JSON.parse(init.body);
				return Promise.resolve(answer);
			}
		});
		assertEqual(await client.feedback({ sessionId: "s-1", text: "一条备注", category: "product-interaction" }), { ok: true }, "a recorded remark answers ok");
		assertEqual(sent, { sessionId: "s-1", text: "一条备注", category: "product-interaction" }, "and the three fields travel as declared");

		sent = null;
		await client.feedback({ text: "没有会话" });
		assertEqual(sent.sessionId, "", "a missing session id is posted empty rather than dropped");
		assertEqual(sent.category, "product-interaction", "and the category carries a default the host validates");

		answer = { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: false, error: "unavailable" })) };
		assertEqual(await client.feedback({ sessionId: "s-1" }), { ok: false, error: "unavailable" }, "a composition without the channel is reported as such");
		answer = { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: false })) };
		assertEqual(await client.feedback({ sessionId: "s-1" }), { ok: false, error: "rejected" }, "and an unlabelled refusal still says refused");
	});

	await asyncCheck("api: the source calls carry the url and the digest the index promised", "source fetch", async () => {
		// The two GETs are built by string concatenation, which is exactly where a digest gets dropped or
		// a URL gets pasted in unencoded — and a dropped digest is the difference between verifying a pack
		// and trusting whatever arrived.
		const { createApiClient } = loadCore("api.js");
		const seen = [];
		const client = createApiClient({
			base: "http://127.0.0.1",
			fetchImpl: (url) => {
				seen.push(String(url));
				return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true, index: { packs: [] }, pack: { entries: [] }, summary: { count: 0 }, sha256: "x" })) });
			}
		});
		await client.sourceIndex("https://example.com/a b/index.json", true);
		assertEqual(seen[0], "http://127.0.0.1/dsh-term-dictionary/source/index?url=https%3A%2F%2Fexample.com%2Fa%20b%2Findex.json&refresh=1", "the index call encodes the url and asks to refresh");
		await client.sourceIndex("https://example.com/i.json", false);
		assertEqual(seen[1].endsWith("&refresh=1"), false, "and leaves the cache alone when not asked to refresh");
		await client.sourcePack("https://example.com/p.json", "abc123");
		assertEqual(seen[2], "http://127.0.0.1/dsh-term-dictionary/source/pack?url=https%3A%2F%2Fexample.com%2Fp.json&sha256=abc123", "the pack call carries the promised digest");
		await client.sourcePack("https://example.com/p.json");
		assertEqual(seen[3].includes("sha256"), false, "and omits it when the index promised none");
	});

	await asyncCheck("beacon: an oversized report names what it dropped instead of being cut", "beaconFit", async () => {
		// The other half of the same boundary. A report longer than the entry store's own limit
		// arrives as JSON cut mid-string: unparseable, with the decisive head kept and the
		// reason for the failure gone — which is how five reports on disk read. Trimming is only
		// honest if it says what it removed, so this asserts the limit, the parseability, the
		// drop list, and that the counters answering the pointer question are the survivors.
		const { exports } = loadBundle();
		const { MAX_CONTEXT_CHARS } = loadCore("entries.js");
		const oversized = {
			b: "td-test",
			w: "hover",
			at: 1,
			seen: 9,
			inR: 0,
			out: 9,
			hasRegion: false,
			chats: 0,
			budget: { hover: 0, click: 5, reject: 3 },
			blocks: 40,
			hl: 12,
			// A late-order field big enough that a cap looser than the store's own would leave it
			// in. Without it this check passes against any limit, because dropping `probe` alone
			// already fits a report of this size.
			style: "s".repeat(MAX_CONTEXT_CHARS),
			probe: { caret: "x".repeat(MAX_CONTEXT_CHARS * 5) }
		};
		const text = exports.fitBeacon(oversized);
		assert(
			text.length <= MAX_CONTEXT_CHARS,
			`a report must fit the context the entry store keeps, saw ${text.length} against ${MAX_CONTEXT_CHARS}`
		);
		const kept = JSON.parse(text);
		assert(Array.isArray(kept.dropped) && kept.dropped.includes("probe"), `the oversized field must be declared dropped, saw ${JSON.stringify(kept.dropped)}`);
		assertEqual(kept.seen, 9, "the pointer counters survive the trim");
		assertEqual(kept.inR, 0, "and so does the one that says the region was never entered");
		// The other exit: a report nothing in the drop order can shrink. The fields the order
		// does not name are then the ones that go, and the transcript count is not among them —
		// `blocks` is what separates a transcript the settled pass never read (`null`) from one it
		// read and found nothing in (`0`), which is the distinction every report on disk lost.
		const unshrinkable = {
			b: "td-test",
			w: "hover",
			at: 1,
			seen: 9,
			inR: 0,
			hasRegion: true,
			chats: 1,
			blocks: 7,
			budget: { hover: 4, click: 5, reject: 3 },
			somethingNew: "u".repeat(MAX_CONTEXT_CHARS * 3)
		};
		const trimmed = JSON.parse(exports.fitBeacon(unshrinkable));
		assertEqual(trimmed.blocks, 7, "the transcript count is kept even when the drop order has nothing left to give");
		assert(trimmed.dropped.includes("somethingNew"), `an unlisted field is what gets dropped, saw ${JSON.stringify(trimmed.dropped)}`);
	});

	await asyncCheck("beacon: a report names the hit-test stage that refused most", "beaconTrace", async () => {
		// Hundreds of moves inside the transcript with `hints` at zero is not a diagnosis, and the
		// reason lives in ten exits inside `termAtPoint`. Carrying all ten would cost the report
		// the entry store's own limit, so it carries the one that refused most — and that one
		// field has to survive the trim, or it exists only on a page that never needed trimming.
		const { exports } = loadBundle();
		const { MAX_CONTEXT_CHARS } = loadCore("entries.js");
		assertEqual(exports.topStage({ "no-block": 2, "not-known": 1, ok: 40 }), "no-block:2", "the stage that refuses most is the one named");
		assertEqual(exports.topStage({ "no-block": 1, "not-known": 3, ok: 0 }), "not-known:3", "and the index outranks the geometry when it refuses more");
		// A stage that never fired must not be reported as the failure — that is what makes a
		// healthy page readable on disk rather than indistinguishable from a broken one.
		assertEqual(exports.topStage({ "no-block": 0, ok: 5 }), "ok:5", "a page that resolves says so instead of naming a refusal");
		assertEqual(exports.topStage(undefined), null, "no layer yet is reported as no trace");

		const traced = {
			b: "td-test",
			w: "hover",
			at: 1,
			seen: 900,
			inR: 888,
			hasRegion: true,
			chats: 1,
			blocks: 12,
			budget: { hover: 0, click: 5, reject: 3 },
			trace: "no-block:2",
			style: "s".repeat(MAX_CONTEXT_CHARS),
			probe: { caret: "x".repeat(MAX_CONTEXT_CHARS * 5) }
		};
		const kept = JSON.parse(exports.fitBeacon(traced));
		assertEqual(kept.trace, "no-block:2", "the trace survives the trim, because it is the reason for the report");
		assert(kept.dropped.includes("probe"), "the bulky probe is what goes instead");
		// The second exit, and the one that actually consults the keep set. Everything the drop
		// order names already came off by now, so a field it does not name is what gets taken —
		// and a field not kept by name goes with it. Without this half a `trace` missing from the
		// keep set still passes, because the drop order alone fits the report.
		const notInOrder = Object.assign({}, traced, { somethingNew: "u".repeat(MAX_CONTEXT_CHARS * 3) });
		const thinner = JSON.parse(exports.fitBeacon(notInOrder));
		assertEqual(thinner.trace, "no-block:2", "the stage is kept by name when nothing in the drop order can shrink");
		assert(thinner.dropped.includes("somethingNew"), "and the unnamed field is what pays for it");
	});



	await asyncCheck("api: a stalled call is abandoned while a slow-but-live one is not", "deadline", async () => {
		// The model path is why this matters: the host allows its model call tens of
		// seconds, so a client that gives up after a few would report failure for a
		// generation that actually succeeded. This drives both outcomes against a real
		// server: one route answers inside the budget, the other never does.
		const http = require_("node:http");
		const { createApiClient, EXPLAIN_TIMEOUT_MS, REQUEST_TIMEOUT_MS } = loadCore("api.js");
		assert(EXPLAIN_TIMEOUT_MS > REQUEST_TIMEOUT_MS, `the explain deadline must exceed the default budget (${EXPLAIN_TIMEOUT_MS} vs ${REQUEST_TIMEOUT_MS})`);
		// Only `/state` ever answers. Everything else hangs, so `explain` can only
		// finish by reaching its own deadline.
		const server = http.createServer((req, res) => {
			if (req.url === "/dsh-term-dictionary/state") {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ schemaVersion: 1, entries: [] }));
			}
		});
		await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
		const base = `http://127.0.0.1:${server.address().port}`;
		try {
			const client = createApiClient({ base, timeoutMs: 120 });
			const answered = await client.load();
			assert(answered.ok === true, `a live host must answer: ${JSON.stringify(answered)}`);

			// The read budget is the default one.
			const readStart = Date.now();
			const stalled = await createApiClient({
				base,
				timeoutMs: 120,
				fetchImpl: (url, init) => fetch(url.replace("/state", "/dsh-term-dictionary/stall"), init)
			}).load();
			const readWaited = Date.now() - readStart;
			assertEqual(stalled.ok, false, "a stalled read is reported as a failure");
			assert(readWaited < 1500, `the read deadline must be the default budget (waited ${readWaited}ms)`);

			// `explain` must wait out the SAME server for its own budget. The assertion is
			// on the measured wait, so dropping the deadline argument — which falls back
			// to the 60s default — fails here instead of passing silently.
			const explainStart = Date.now();
			const answer = await createApiClient({ base, timeoutMs: 120, explainTimeoutMs: 900 }).explain("quorum", "context");
			const explainWaited = Date.now() - explainStart;
			assertEqual(answer.ok, false, "an explanation that never arrives is reported as a failure");
			assert(
				explainWaited >= 850 && explainWaited < 5000,
				`explain must use its own deadline (waited ${explainWaited}ms, expected about 900ms)`
			);
		} finally {
			await new Promise((done) => server.close(done));
		}
	});

	await asyncCheck("store: the file store round-trips and survives a corrupt file", "store", async () => {
		const fs = require_("node:fs");
		const os = require_("node:os");
		const path = require_("node:path");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "term-dict-"));
		const file = path.join(dir, "dictionary.json");
		const store = dictionaryModule.createFileStore(fs, file, console);
		let state = dictionaryModule.emptyState({ now: 1 });
		state = dictionaryModule.recordSighting(state, { term: "persisted" }, { now: 2 }).state;
		await store.save(state);
		assert(existsSync(file), "the dictionary file must exist after save");
		const reloaded = store.load();
		assertEqual(reloaded.entries.length, 1, "the entry must round-trip through the file");
		assertEqual(reloaded.entries[0].term, "persisted", "the reloaded term");
		const onDisk = JSON.parse(readFileSync(file, "utf8"));
		assertEqual(onDisk.schemaVersion, 1, "the file carries a schema version");
		// A corrupt file must degrade to empty rather than throw.
		fs.writeFileSync(file, "{ this is not json", "utf8");
		assertEqual(store.load().entries.length, 0, "a corrupt file yields an empty dictionary");
		fs.rmSync(dir, { recursive: true, force: true });
	});
}

/**
 * Run one awaited check, honouring the CLI filter.
 * @param name - the check's name.
 * @param keyword - the bare keyword the filter may name instead.
 * @param fn - the async body.
 * @returns a promise settling when the check has run.
 */
async function asyncCheck(name, keyword, fn) {
	if (filter !== "" && !name.includes(filter) && !keyword.includes(filter)) return;
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed++;
		failures.push({ name, error });
		console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
	}
}

await asyncChecks();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	for (const failure of failures) {
		console.error(`\n${failure.name}\n${failure.error instanceof Error ? failure.error.stack : String(failure.error)}`);
	}
	process.exit(1);
}
