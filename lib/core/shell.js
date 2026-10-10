"use strict";

/**
 * The plugin shell: wiring for the browser half.
 *
 * It owns the four moving parts and nothing else —
 *  - the dictionary store, hydrated from local storage and the host;
 *  - the detector, rebuilt whenever the dictionary changes;
 *  - the conversation interaction layer (auto-collection, click, selection);
 *  - the three registered surfaces: the sidebar panel row, the center panel, and
 *    the overlay that carries the popup, the selection affordance and the toast.
 */

const React = require("react");
const core = require("./core.js");
const copy = require("./copy.js");
const { TermDetector } = require("./terms.js");
const { createDictionaryStore } = require("./store.js");
const { createBrowserStore } = require("./dictionary.js");
const { createApiClient } = require("./api.js");
const { MAX_CONTEXT_CHARS } = require("./entries.js");
const { createSettingsStore } = require("./settings.js");
const { createInteractionLayer, readRegion } = require("./interact.js");
const { createTermHighlighter } = require("./highlight.js");
const { createPanelCommandBus } = require("./bus.js");
const { DictionaryGlyph, DictionaryPanel, DeletedList, FlaggedList, PacksPage, SettingsPage, TransferPage } = require("./views.js");
const { TermPopup, SelectionAffordance, Toast, HighlighterStyle } = require("./overlay.js");
const { createHoverLayer } = require("./hover.js");
const { HoverCard, HoverStyle } = require("./hovercard.js");

/** Built-in glossaries. A missing pair degrades the detector, never breaks it. */
const LEXICON_EN = safeRequire("./lexicon.en.js");
/** Chinese jargon the detector knows with no dictionary entry. */
const LEXICON_ZH = safeRequire("./lexicon.zh.js");
/** Words the detector must never treat as jargon on their own. */
const STOPWORDS = (() => {
	const loaded = safeRequire("./stopwords.js");
	return { EN: Array.isArray(loaded.EN) ? loaded.EN : [], ZH: Array.isArray(loaded.ZH) ? loaded.ZH : [] };
})();

/**
 * Require an optional data module.
 * @param spec - a relative specifier.
 * @returns the module's exports, or an empty object.
 */
function safeRequire(spec) {
	try {
		return require(spec) ?? {};
	} catch (error) {
		console.error(`[term-dictionary] optional data module ${spec} is unavailable:`, error);
		return {};
	}
}

const h = React.createElement;

/** Locale namespace owned by this plugin. */
const NS = "termDictionary";

/**
 * Services required by the browser half.
 *
 * `layout` is what selects the Dictionary panel, so it is declared rather than
 * probed: a Cordis context throws on reading an undeclared service, and declaring
 * it keeps the plugin inactive in a composition that has no layout owner instead
 * of failing at the first click.
 */
const inject = ["slots", "locale", "layout"];

/** The panel id: the sidebar row's id, the `main` slot key and the layout's selection key. */
const PANEL_ID = "term-dictionary";

/** Panel row order in the sidebar list, before the host's own panels. */
const PANEL_ORDER = 40;

/** How long a notice stays on screen. */
const TOAST_MS = 6000;

/** How many explanations may be in flight at once. */
const MAX_PARALLEL_EXPLAINS = 2;

/** How many explanations may wait in the queue before new ones are dropped. */
const MAX_EXPLAIN_QUEUE = 6;

/**
 * Identifies the build in the diagnostic output.
 *
 * Bumped by hand on every change to the browser half while the pointer path is being
 * diagnosed. It is also what the sidebar row shows, because that is the one report the
 * page can make about its own bundle without using any of the channels under test.
 */
const BUILD_TAG = "td-beacon-2";

/** Sequence number behind the report names, so two reports in one millisecond still land. */
let reportSeq = 0;

/**
 * A term name no earlier report could have used.
 *
 * `recordSighting` never rewrites the context of an entry that already exists, and refuses
 * one that was deleted outright. Both rules make a working report indistinguishable from a
 * missing one, so every report has to arrive under a name nobody has filed anything under.
 *
 * @param kind - which report this is.
 * @returns the term to file it under.
 */
function reportTerm(kind) {
	reportSeq++;
	return `zz-${kind}-${BUILD_TAG}-${String(Date.now()).slice(-6)}-${String(reportSeq)}`;
}

/**
 * Characters a beacon may occupy.
 *
 * Derived from the store's own limit rather than written out, because the number is the fact
 * here: an entry's `context` is clamped by `clampText` inside `createEntry`, on a path both
 * halves share, and the route answers `created` either way. So anything longer arrives as JSON
 * cut mid-string — unparseable, with the decisive head kept and the reason for the failure gone.
 * Five of the reports already on disk are exactly that length and end in an ellipsis. The margin
 * is for the `dropped` list itself growing while the payload shrinks.
 */
const MAX_BEACON_CHARS = MAX_CONTEXT_CHARS - 20;

/**
 * Beacon fields least useful for the pointer question, dropped earliest.
 *
 * `probe` goes first despite being the most detailed field: it is the largest by a wide margin,
 * and the page already holds it — `diagnose` writes it to `__termDictionary.last` and prints it
 * before this runs. Dropping it last would instead cost `blocks`, which is the one field that
 * separates "the settled pass never read a transcript" (`null`) from "it read one with no terms"
 * (`0`) — the distinction every report on disk was too short to make.
 */
const BEACON_DROP_ORDER = ["probe", "origin", "ready", "style", "sw", "hints", "transport", "attached", "caret", "hl"];

/** Fields a report must keep: without these a shortened report says nothing about the pointer. */
const BEACON_KEEP = new Set([
	"b",
	"w",
	"at",
	"seen",
	"inR",
	"out",
	"blocked",
	"adopts",
	"clicks",
	"hasRegion",
	"chats",
	"blocks",
	"trace",
	"budget",
	"dropped"
]);

/**
 * The hit-test stage that refuses most, as `name:count`, or `ok:n` when nothing does.
 *
 * A gesture report can say the pointer was inside the transcript hundreds of times while no hint
 * ever appeared, and the reason lives in ten separate stages. Carrying all ten would cost the
 * report its own limit, so this carries the one that answers the question — the tally it is read
 * against is `__termDictionary.stats().hitStages`, which is on the page.
 *
 * @param stages - the layer's stage tally, or undefined.
 * @returns the compact trace, or null when there is no layer yet.
 */
function topStage(stages) {
	if (stages === null || stages === undefined) return null;
	let name = "";
	let count = 0;
	for (const [key, value] of Object.entries(stages)) {
		if (key === "ok" || !(value > count)) continue;
		name = key;
		count = value;
	}
	return count === 0 ? `ok:${stages.ok ?? 0}` : `${name}:${count}`;
}

/**
 * Trim a beacon until the entry store will keep all of it.
 *
 * The payload declares its fields decisive-first, so every drop costs real information; that is
 * why this records what went rather than silently shrinking. A payload that still cannot fit
 * after everything droppable is gone returns the smallest honest report instead of a truncated
 * one, so an oversized probe cannot put the whole heartbeat out of reach.
 *
 * @param payload - the beacon's fields, mutated in place.
 * @returns JSON that fits {@link MAX_BEACON_CHARS}.
 */
function fitBeacon(payload) {
	payload.dropped = [];
	const render = () => JSON.stringify(payload);
	if (render().length <= MAX_BEACON_CHARS) return render();
	for (const key of BEACON_DROP_ORDER) {
		if (!(key in payload)) continue;
		delete payload[key];
		payload.dropped.push(key);
		if (render().length <= MAX_BEACON_CHARS) return render();
	}
	// Whatever a later report bolted on that the drop list does not name.
	for (const key of Object.keys(payload)) {
		if (BEACON_KEEP.has(key)) continue;
		delete payload[key];
		payload.dropped.push(key);
		if (render().length <= MAX_BEACON_CHARS) return render();
	}
	return JSON.stringify({ b: payload.b, w: payload.w, at: payload.at, seen: payload.seen, inR: payload.inR, over: true });
}

/**
 * Build a detector over the current dictionary.
 * @param state - the dictionary document.
 * @returns a detector.
 */
function buildDetector(state) {
	return new TermDetector({
		lexicon: Object.assign({}, LEXICON_EN, LEXICON_ZH),
		entries: state.entries,
		stopwords: STOPWORDS
	});
}

/** The bundle's entry point. */
function apply(ctx) {
	const t = ctx.locale.bind(NS);
	const storage = globalThis.localStorage;
	const api = createApiClient({});

	const store = createDictionaryStore({
		local: createBrowserStore(storage, console),
		remote: api.available() ? { load: () => api.load(), save: (state) => api.save(state) } : null,
		logger: console
	});
	const settings = createSettingsStore({ storage, logger: console });

	/** The live detector generation, replaced after every dictionary change. */
	let detector = buildDetector(store.getState());
	let interaction = null;
	/** The conversation region the last settled pass walked, for the annotation layer. */
	let transcriptRegion = null;
	const highlighter = createTermHighlighter({ document: globalThis.document, detector, logger: console });
	const bus = createPanelCommandBus();

	const panelProps = {
		store,
		bus,
		settings,
		explain: (term, context, options) => api.explain(term, explainContext(term, context), explainOptions(options)),
		/**
		 * The id of the conversation on screen.
		 *
		 * The host's feedback channel takes one, and the transcript that carries it is unmounted while
		 * this panel holds the main region — so the id comes from the pointer layer, which reads it
		 * whenever there IS a transcript to read it from. Empty means "never seen one", which the panel
		 * reports rather than sending a remark the host would refuse.
		 */
		sessionId: () => (typeof interaction?.sessionId === "function" ? interaction.sessionId() : ""),
		recordFeedback: (input) => api.feedback(input),
		/**
		 * The pack layer's four calls, grouped.
		 *
		 * The page asks for a pack, a share code, an index or one pack from a source — and never touches
		 * the transport itself, which is what keeps the https rule, the disk cache and the checksum on
		 * the host's side of the boundary.
		 */
		packApi: {
			build: (input) => api.pack({ action: "build", ...input }),
			decode: (value) => api.pack({ action: "decode", code: value }),
			index: (url, refresh) => api.sourceIndex(url, refresh),
			fetch: (url, sha256) => api.sourcePack(url, sha256)
		}
	};

	/** The overlay's view state, kept outside React so the interaction layer can drive it. */
	let overlayState = { kind: "closed" };
	const overlayListeners = new Set();
	const setOverlay = (next) => {
		overlayState = next;
		for (const listener of [...overlayListeners]) listener();
	};

	/** The transient notice's view state. */
	let toastState = null;
	let toastTimer = null;
	const toastListeners = new Set();
	const setToast = (next) => {
		toastState = next;
		if (toastTimer !== null) clearTimeout(toastTimer);
		if (next !== null) {
			toastTimer = setTimeout(() => {
				toastState = null;
				toastTimer = null;
				for (const listener of [...toastListeners]) listener();
			}, TOAST_MS);
		}
		for (const listener of [...toastListeners]) listener();
	};

	/** The selection affordance's view state. */
	let selectionState = null;
	const selectionListeners = new Set();
	const setSelection = (next) => {
		selectionState = next;
		for (const listener of [...selectionListeners]) listener();
	};

	/**
	 * Open the explanation popup for one term at one point.
	 * @param hit - `{ term, key, context, known }` from the interaction layer.
	 * @param point - viewport coordinates of the pointer.
	 */
	const openPopup = (hit, point) => {
		// A click that lands on a selection must not fight the affordance.
		setSelection(null);
		setOverlay({ kind: "entry", term: hit.term, key: hit.key, context: hit.context, point });
	};

	/**
	 * Open the explanation popup for an unknown term, or take the user to the entry
	 * that a known one already has.
	 *
	 * The hint already carries the explanation, so a click on a collected term is a
	 * navigation: select the panel and let it reveal the row. A glossary term has no
	 * row to reveal, so it keeps the popup.
	 *
	 * @param hit - the clicked term.
	 * @param point - viewport coordinates of the pointer.
	 */
	const activate = (hit, point) => {
		const entry = store.find(hit.key);
		if (entry === null) {
			openPopup(hit, point);
			return;
		}
		setSelection(null);
		setOverlay({ kind: "closed" });
		ctx.layout.selectPanel(PANEL_ID);
		bus.requestFocus(entry.key);
	};

	/** Open the editor in the panel, prefilled, and select the panel. */
	const startCreate = (term, context) => {
		setSelection(null);
		setOverlay({ kind: "closed" });
		// `layout` is declared in `inject`, so this throws rather than silently
		// no-ops if the panel selection service is genuinely absent — and in a
		// deployment without ui-layout the plugin never activates at all.
		ctx.layout.selectPanel(PANEL_ID);
		bus.requestCreate(term, context);
	};

	/** Persist a sighting and refresh the detector when the dictionary grew. */
	const noteSighting = async (sighting) => {
		const key = typeof sighting.key === "string" && sighting.key !== "" ? sighting.key : core.normalizeTerm(sighting.term);
		const result = await store.noteSighting({ ...sighting, glossary: detector.glossaryOf(key) });
		if (result.created) rebuildDetector();
		return result;
	};

	/** Rebuild the detector from the current dictionary. */
	function rebuildDetector() {
		detector = buildDetector(store.getState());
		interaction?.setDetector(detector);
		// The annotation layer scans with the same generation, so a new or deleted
		// entry appears or disappears in the transcript at the same moment it does in
		// the panel.
		highlighter.setDetector(detector);
		syncAnnotation();
	}

	/** Paint or clear the transcript marking, according to the switch. */
	function syncAnnotation() {
		if (settings.getSnapshot().autoAnnotate) highlighter.refresh(transcriptRegion);
		else highlighter.clear();
	}

	//#region diagnostic beacon

	/** The last report's outcome, for the console and for `__termDictionary`. */
	let beaconOutcome = { state: "pending", at: 0, detail: "" };

	/**
	 * Tell the host what this page can see, without waiting for anyone to interact.
	 *
	 * TEMPORARY, and CONSOLE-ONLY. It used to file itself into the dictionary, which filled the
	 * user's term list with `zz-hb-*` rows on every reload — a diagnostic writing into the data
	 * it diagnoses. The outcome is still kept where it can be read: `console.info` below,
	 * `globalThis.__termDictionary` and `globalThis.__termDictionaryBeacon`.
	 *
	 * The fields that measured the hover gesture are gone with it: `seen`, `inR`, `out`,
	 * `blocked` and `hints` counted a pointer path this plugin no longer has, and a field that
	 * can only ever read `null` is worse than no field — it reads as "the counters are broken"
	 * rather than "the counters are gone".
	 *
	 * @param label - which call this is.
	 * @param extra - fields only a later report can carry.
	 * @returns the report's outcome.
	 */
	async function beacon(label, extra) {
		const term = reportTerm(`hb-${label}`);
		let answer;
		let text = "";
		try {
			const stats = typeof interaction?.stats === "function" ? interaction.stats() : {};
			const current = settings.getSnapshot();
			const payload = {
				b: BUILD_TAG,
				w: label,
				at: Date.now(),
				adopts: stats.regionAdoptions ?? null,
				clicks: stats.clickSeen ?? null,
				budget: stats.budget ?? null,
				hasRegion: typeof interaction?.hasRegion === "function" ? interaction.hasRegion() : null,
				chats: typeof interaction?.regionCount === "function" ? interaction.regionCount() : null,
				blocks: transcriptRegion === null ? null : readRegion(transcriptRegion).blocks.length,
				// Which hit-test stage a CLICK resolved at. The reason a gesture produced
				// nothing is one of several exits inside `termAtPoint`, and the counters alone
				// cannot tell them apart — they say "the pointer was there and nothing
				// happened" and nothing more.
				trace: topStage(stats.hitStages),
				hl: highlighter.count(),
				attached: stats.attached ?? null,
				caret: stats.caretApi ?? null,
				transport: api.available(),
				style:
					typeof globalThis.document?.querySelector === "function"
						? globalThis.document.querySelector('style[data-term-dictionary="highlight-style"]') !== null
						: null,
				sw: [current.autoCollect, current.autoAnnotate, current.autoExplain],
				ready: globalThis.document?.readyState ?? null,
				origin: globalThis.location?.origin ?? null,
				...extra
			};
			text = fitBeacon(payload);
		} catch (error) {
			// Assembling the report used to be outside the try, so an error there was thrown
			// into a `void beacon(...)` with no rejection handler: the heartbeat stopped
			// without a trace, in exactly the generation whose region had finally been found.
			// A failure now belongs to the report rather than replacing it.
			answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		// Console-only ON PURPOSE.
		//
		// This report used to be filed as a dictionary entry, which is what filled the user's
		// term list with `zz-hb-*` rows on every reload — a diagnostic that writes into the
		// data it is diagnosing. The readouts that actually matter survive: this console line,
		// `globalThis.__termDictionary` and `globalThis.__termDictionaryBeacon`. The user's
		// dictionary stays theirs.
		const detail = "console-only";
		beaconOutcome = { state: "ok", at: Date.now(), detail };
		globalThis.__termDictionaryBeacon = beaconOutcome;
		console.info(`[term-dictionary ${BUILD_TAG}] ${label} report (console only, not filed)`, text);
		return beaconOutcome;
	}

	//#endregion

	//#region auto-explain

	/** Explanations waiting for a model call. */
	const explainQueue = [];
	/** How many model calls are in flight. */
	let explaining = 0;
	/**
	 * Set once the host says it cannot explain anything.
	 *
	 * A failure is not per-term: the usual cause is a provider route with no credentials,
	 * which will fail identically for the next term. Without this, every collected term
	 * would retry the same broken route for the rest of the session.
	 */
	let explainDisabled = false;

	/**
	 * Queue an explanation for a term automatic collection just created.
	 *
	 * Bounded on purpose: one settled message can create several entries, and firing a
	 * model call per entry at once would stack requests the user never asked for.
	 *
	 * @param item - `{ term, key, context }`.
	 */
	/**
	 * The user's explanation preferences, with `auto` resolved to a concrete language.
	 *
	 * The host builds the prompt, so it is told the language rather than asked to guess it:
	 * `auto` means "match the interface", and only the page knows which one that is.
	 *
	 * @param options - `retry` for a second attempt at an explanation the user rejected.
	 * @returns `{ lang, depth, retry }`.
	 */
	function explainOptions(options) {
		const current = settings.getSnapshot();
		let lang = current.explainLang;
		if (lang === "auto") {
			let active = "";
			try {
				active = ctx.locale?.getSnapshot?.()?.active ?? "";
			} catch (error) {
				void error;
			}
			lang = String(active).toLowerCase().startsWith("en") ? "en" : "zh";
		}
		return { lang, depth: current.explainDepth, retry: options?.retry === true };
	}

	/**
	 * The context to hand the model: the term's sentence, or the whole paragraph it sat in.
	 *
	 * The layer hands over one sentence, which is right for the popup and thin for a model
	 * that is being asked what a term MEANS: a definition often lives in the sentences
	 * around it. When the setting is on, the containing block is used instead — it is the
	 * same text the annotation layer already reads, so nothing new is measured, and the host
	 * clamps it to its own prompt budget.
	 *
	 * @param term - the term being explained.
	 * @param sentence - the layer's context.
	 * @returns the context to send.
	 */
	function explainContext(term, sentence) {
		const base = typeof sentence === "string" ? sentence : "";
		if (settings.getSnapshot().explainParagraph !== true) return base;
		const region = transcriptRegion;
		if (region === null || region === undefined) return base;
		const needle = typeof term === "string" ? term.trim().toLowerCase() : "";
		if (needle === "") return base;
		try {
			for (const block of readRegion(region).blocks) {
				const text = typeof block.text === "string" ? block.text : "";
				if (text === "" || !text.toLowerCase().includes(needle)) continue;
				// Only ever widen: a block that reads shorter than the sentence is not a
				// paragraph the model benefits from.
				return text.length > base.length ? text : base;
			}
		} catch (error) {
			warn("reading the paragraph for the explanation failed", error);
		}
		return base;
	}

	function requestExplanation(item) {
		if (explainDisabled || !settings.getSnapshot().autoExplain) return;
		const entry = store.find(item.key);
		// Already explained — by the glossary, by the user, or by an earlier pass.
		if (entry !== null && (entry.definition.gloss !== "" || entry.definition.zh !== "")) return;
		// The user said this entry's explanation is not to be trusted, so do not spend a model call on
		// one that would be thrown away. The RULE itself lives in `recordSighting` — this is only the
		// cheaper half of it, and the data layer stays the authority because every automatic writer
		// goes through there.
		if (entry !== null && entry.untrusted === true) return;
		if (explainQueue.length >= MAX_EXPLAIN_QUEUE) return;
		explainQueue.push(item);
		void pumpExplanations();
	}

	/** Run queued explanations, at most {@link MAX_PARALLEL_EXPLAINS} at a time. */
	async function pumpExplanations() {
		if (explaining >= MAX_PARALLEL_EXPLAINS) return;
		const next = explainQueue.shift();
		if (next === undefined) return;
		explaining++;
		try {
			const answer = await api.explain(next.term, explainContext(next.term, next.context), explainOptions());
			if (answer.ok === true && answer.definition !== null && typeof answer.definition === "object") {
				// The same path the popup's "用模型生成解释" uses, so a generated explanation
				// carries the same provenance and the same revival authority.
				await noteSighting({
					term: next.term,
					key: next.key,
					context: next.context,
					definition: answer.definition,
					source: "llm",
					confidence: 0.9
				});
			} else {
				explainDisabled = true;
				explainQueue.length = 0;
				setToast({ kind: "auto", text: t("toastExplainUnavailable", { message: answer.error ?? "" }), undoable: false });
			}
		} catch (error) {
			explainDisabled = true;
			explainQueue.length = 0;
			console.warn("[term-dictionary] auto-explanation failed:", error);
		} finally {
			explaining--;
			void pumpExplanations();
		}
	}

	//#endregion

	// The store is the single source of dictionary truth, so the detector follows
	// it rather than being invalidated by each mutation site.
	ctx.effect(() => store.subscribe(() => rebuildDetector()), "term-dictionary: detector follows the dictionary");

	// The switches reach the two layers that act on them. `interaction` may not exist yet
	// when this first runs (it is registered further down), which is why its own effect
	// pushes the current value in as soon as it is built.
	ctx.effect(() => {
		const apply = () => {
			const current = settings.getSnapshot();
			interaction?.setAutoCollect(current.autoCollect);
			syncAnnotation();
		};
		apply();
		return settings.subscribe(apply);
	}, "term-dictionary: the switches reach the layers");

	// Hydration is what loads the dictionary at all: local storage first, then the
	// host's file when the Web carrier is reachable. Nothing else reads storage, so
	// a plugin that never calls this shows an empty panel forever.
	ctx.effect(() => {
		let alive = true;
		void store
			.hydrate()
			.then(() => {
				if (alive) rebuildDetector();
			})
			.catch((error) => {
				console.error("[term-dictionary] hydration failed:", error);
			});
		return () => {
			alive = false;
		};
	}, "term-dictionary: hydrate the dictionary");

	ctx.effect(
		() =>
			ctx.locale.register(NS, {
				zh: copy.zh,
				en: copy.en
			}),
		"term-dictionary: dictionaries"
	);

	// Rebuild the detector after a locale change so the panel's own copy and any
	// locale-dependent label read fresh values; the lexicons themselves are fixed.
	ctx.effect(() => {
		const off = ctx.locale.subscribe(() => rebuildDetector());
		return () => off();
	}, "term-dictionary: detector follows the locale");

	//#region the pointer layer

	/** Listeners and timers the hover layer owns, so one effect can dispose of them. */
	const hoverDisposers = [];

	/**
	 * What the hover card shows for one marked term.
	 *
	 * The user's own entry wins; a term with an entry but no explanation yet falls back to the
	 * built-in glossary, so hovering a half-finished entry still says something rather than
	 * nothing.
	 *
	 * @param key - the entry key.
	 * @param term - the term as it appears in the text.
	 * @returns `{ key, term, zh, gloss, usage, domain }`.
	 */
	function hoverEntryFor(key, term) {
		const entry = typeof store?.find === "function" ? store.find(key) : null;
		const glossary = typeof detector?.glossaryOf === "function" ? detector.glossaryOf(key) : null;
		if (entry !== null && entry !== undefined) {
			return {
				key,
				term: entry.term,
				zh: entry.definition.zh !== "" ? entry.definition.zh : (glossary?.zh ?? ""),
				gloss: entry.definition.gloss !== "" ? entry.definition.gloss : (glossary?.gloss ?? ""),
				usage: entry.definition.usage ?? "",
				domain: entry.domain ?? ""
			};
		}
		if (glossary === undefined || glossary === null) return { key, term, zh: "", gloss: "", usage: "", domain: "" };
		return { key, term, zh: glossary.zh ?? "", gloss: glossary.gloss ?? "", usage: glossary.usage ?? "", domain: "" };
	}

	/**
	 * The pointer layer.
	 *
	 * Its INPUT is the annotation layer's own segment list — the occurrences that are already
	 * marked — so the hit test cannot disagree with the marking about what a marked term is.
	 */
	const hover = createHoverLayer({
		document: globalThis.document,
		logger: console,
		segments: () => highlighter.segments(),
		// The two hover delays, read fresh per gesture so a knob takes effect on the next hover
		// rather than on the next reload.
		delays: () => {
			const current = settings.getSnapshot();
			return { inMs: current.hoverInMs, outMs: current.hoverOutMs };
		},
		// A click on a marked term is a navigation: open its entry in the panel this plugin owns.
		onActivate: (segment) => {
			try {
				activate({ term: segment.term, key: segment.key, id: segment.id, context: "" });
			} catch (error) {
				console.warn("term-dictionary: opening the hovered entry failed:", error instanceof Error ? error.message : error);
			}
		},
		disposers: hoverDisposers
	});

	ctx.effect(() => {
		hover.attach();
		return () => {
			hover.detach();
			for (const dispose of hoverDisposers.splice(0)) {
				try {
					dispose();
				} catch (error) {
					void error;
				}
			}
		};
	}, "term-dictionary: the pointer layer");

	//#endregion

	//#region surfaces

	ctx.slots.inject("sidebar.panellist", () =>
		ctx.slots.register(
			{
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: PANEL_ORDER,
				label: () => t("nav"),
				locale: NS
			},
			DictionaryGlyph
		)
	);

	ctx.slots.inject("main", () =>
		ctx.slots.register(
			{
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => panelProps
			},
			DictionaryPanel
		)
	);

	ctx.slots.inject("shell.overlay", () =>
		ctx.slots.register(
			{
				name: "shell.overlay",
				id: "term-dictionary-overlay",
				order: 60,
				locale: NS,
				inject: () => ({
					store,
					api,
					t,
					hover: hover.view,
					hoverEntry: hoverEntryFor,
					overlay: {
						getSnapshot: () => overlayState,
						subscribe: (listener) => {
							overlayListeners.add(listener);
							return () => overlayListeners.delete(listener);
						}
					},
					selection: {
						getSnapshot: () => selectionState,
						subscribe: (listener) => {
							selectionListeners.add(listener);
							return () => selectionListeners.delete(listener);
						}
					},
					toast: {
						getSnapshot: () => toastState,
						subscribe: (listener) => {
							toastListeners.add(listener);
							return () => toastListeners.delete(listener);
						}
					},
					close: () => setOverlay({ kind: "closed" }),
					startCreate,
					setToast,
					noteSighting,
					rebuildDetector
				})
			},
			TermOverlay
		)
	);

	//#endregion

	//#region interaction

	ctx.effect(() => {
		interaction = createInteractionLayer({
			detector,
			store,
			isWordCharacter: core.isWordCharacter,
			// The layer collects; the shell owns the switches. Handed over as a thunk so a flip
			// takes effect on the next settled message rather than on the next page load.
			collectSettings: () => settings.getSnapshot(),
			logger: console,
			onExplain: (hit, point) => openPopup(hit, point),
			onActivate: (hit, point) => activate(hit, point),
			onSettled: (region) => {
				transcriptRegion = region;
				syncAnnotation();
			},
			// Automatic collection reports what it created, so the shell can ask the model
			// for the explanations. The layer collects; the shell is what owns the API.
			onCollected: (items) => {
				for (const item of items) requestExplanation(item);
			},
			onSelection: (next) => setSelection(next === null ? null : { term: next.text, context: next.context, rect: next.rect }),
			// An explanation card sits over the transcript with nothing else to dismiss it:
			// the pointer moving away only closes a hint, and the card is in the layer's own
			// blocked set, so hovering it is refused and hovering past it reaches nothing behind
			// it. Pressing anywhere that is not ours closes it, which is what makes the next hover
			// reachable again. A selection affordance is left alone — it belongs to the selection.
			onPressOutside: () => {
				if (overlayState.kind === "entry") setOverlay({ kind: "closed" });
			},
			// Diagnostic: a page where the pointer gestures do nothing cannot say why from
			// the outside. This prints the pipeline's own reading for the first few gestures of
			// each kind — hover, click, and the rejections that used to be silent — and files it
			// under the same transport as the heartbeat. It is not part of the feature and is
			// removed once the pointer path is confirmed.
			diagnose: (kind, record) => {
				try {
					globalThis.__termDictionary.last = { kind, record };
					console.info(`[term-dictionary ${BUILD_TAG}] ${kind}`, JSON.stringify(record));
					// The same channel as the boot report, so a probe that cannot be delivered
					// says so instead of going quiet.
					void beacon(kind, { probe: record });
				} catch (error) {
					console.warn("[term-dictionary] the diagnostic failed:", error);
				}
			},
			onToast: (notice) => {
				if (notice?.count > 0) {
					setToast({ kind: "auto", text: t("toastAutoAdded", { count: String(notice.count) }), undoable: false });
					rebuildDetector();
				}
			}
		});
		// The console handle is installed here rather than from inside `diagnose`, so it exists
		// whether or not a gesture has ever been reported. When it lived behind the diagnostic
		// gate, the page that was failing had no `__termDictionary` to inspect at all: the tool
		// that would have answered "is the layer attached" was itself one of the things under
		// test, and `stats()` is precisely the answer that separates "no events reached us" from
		// "events reached us, there was no region".
		globalThis.__termDictionary = {
			build: BUILD_TAG,
			last: null,
			probe: (x, y) => interaction?.probe?.(x, y) ?? null,
			stats: () => interaction?.stats?.() ?? null,
			hasRegion: () => interaction?.hasRegion?.() ?? null,
			regionCount: () => interaction?.regionCount?.() ?? null,
			beacon: () => beaconOutcome
		};
		interaction.attach();
		// The layer is built with collection ON, so a switch that is already off has to be
		// pushed into it here — the settings effect ran before the layer existed.
		interaction.setAutoCollect(settings.getSnapshot().autoCollect);
		// Diagnostic: the layer's own counters, reported the moment it exists rather than on a
		// timer that a hidden page or a re-run of this effect could cancel.
		void beacon("layer");
		return () => {
			interaction?.detach();
			interaction = null;
			transcriptRegion = null;
			// The registry entry outlives the region it pointed at, so it is dropped with
			// the layer rather than left marking whatever the page shows next.
			highlighter.clear();
		};
	}, "term-dictionary: conversation interaction");

	//#endregion

	// Diagnostic: the page says it is here, before anything it depends on has a chance to
	// stay quiet. This is the last statement of activation, so if `apply` ran at all the
	// report was attempted — and `beacon` makes the attempt's own failure visible.
	void beacon("boot");

	ctx.effect(() => () => {
		store.dispose();
		settings.dispose();
		explainQueue.length = 0;
		if (toastTimer !== null) clearTimeout(toastTimer);
	}, "term-dictionary: teardown");
}

exports.apply = apply;
exports.inject = inject;

/**
 * The single overlay surface: the explanation popup, the selection affordance and
 * the transient notice. They share one registration because they are one layer —
 * all three are fixed-position elements owned by the page rather than by the
 * conversation's own tree.
 *
 * @param props - injected stores, the API client, and the callbacks the layer.
 * @returns the layer's elements.
 */
function TermOverlay(props) {
	const { store, api, t } = props;
	const view = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	const overlay = React.useSyncExternalStore(props.overlay.subscribe, props.overlay.getSnapshot, props.overlay.getSnapshot);
	const selection = React.useSyncExternalStore(props.selection.subscribe, props.selection.getSnapshot, props.selection.getSnapshot);
	const toast = React.useSyncExternalStore(props.toast.subscribe, props.toast.getSnapshot, props.toast.getSnapshot);
	const hover = React.useSyncExternalStore(props.hover.subscribe, props.hover.getSnapshot, props.hover.getSnapshot);
	const [pending, setPending] = React.useState(null);
	const entry = overlay.kind === "entry" ? store.find(overlay.term) : null;
	// What the hover card says, resolved from the pointer layer's own state: the segment names the
	// term, this plugin's store and glossary name the explanation.
	const hovered = hover.kind === "open" ? props.hoverEntry(hover.segment.key, hover.segment.term) : null;

	return h(
		React.Fragment,
		null,
		// The annotation layer's stylesheet. Mounted with the overlay so it cannot
		// outlive the plugin.
		h(HighlighterStyle, { key: "highlight-style" }),
		// The pointer layer's stylesheet: the hovered term's emphasis and the pointer cursor.
		h(HoverStyle, { key: "hover-style" }),
		hovered === null ? null : h(HoverCard, { key: "hover-card", entry: hovered, anchor: hover.anchor, t }),
		selection === null
			? null
			: h(SelectionAffordance, {
				selection,
				label: t("selectAdd"),
				title: t("selectAddTitle", { term: selection.term }),
				onAdd: () => props.startCreate(selection.term, selection.context),
				onClose: () => props.setSelection?.(null)
			}),
		overlay.kind === "entry"
			? h(TermPopup, {
				term: overlay.term,
				entry,
				context: overlay.context,
				point: overlay.point,
				t,
				pending,
				onCreate: () => props.startCreate(overlay.term, overlay.context),
				onClose: () => props.close(),
				onGenerate: async () => {
					setPending({ phase: "running" });
					const answer = await api.explain(overlay.term, explainContext(overlay.term, overlay.context ?? ""), explainOptions());
					if (answer.ok) {
						await props.noteSighting({
							term: overlay.term,
							key: core.normalizeTerm(overlay.term),
							context: overlay.context ?? "",
							definition: answer.definition,
							source: "llm",
							confidence: 0.9,
							// The user pressed the button, so this write is allowed to land on an entry they
							// had called untrustworthy — the one way past the data layer's refusal.
							overridesUntrusted: true
						});
						setPending(null);
						props.rebuildDetector();
					} else {
						setPending({ phase: "failed", message: answer.error });
					}
				}
			})
			: null,
		toast === null
			? null
			: h(Toast, {
				text: toast.text,
				actionLabel: toast.undoable ? t("toastUndo") : null,
				onAction: toast.onAction,
				onClose: () => props.setToast(null)
			})
	);
}

exports.apply = apply;
exports.inject = inject;
// Exported so the check on a beacon's size can call it. The entry store clamps an entry's
// context without saying so, which makes "this report was trimmed" a fact about this function
// rather than about anything observable at the call site.
exports.fitBeacon = fitBeacon;
// Not part of the platform contract either. The preferences moved behind the panel's own page
// state, so a check that only saw the bundle's surfaces could no longer reach them by rendering
// the panel — and a check that has to simulate a click first is a check that tests the click.
exports.settingsPage = SettingsPage;
// And the packs page: reached from the header as well, and it is where the pack layer's four routes,
// the source list and the shared import path meet.
exports.packsPage = PacksPage;
// And the deleted view, for the same reason: it is reached through a tab, so a check that could only
// render the panel would have to simulate the tab click to see a single tombstone row.
exports.deletedList = DeletedList;
// And the flagged view, for the same reason once more: it is reached through a tab, and its rows are
// about a remark rather than about the entry.
exports.flaggedList = FlaggedList;
// And the import/export page. Its decisions are pure (`transfer.js`) and checked there, but the page
// is where the two halves meet: the category checklist the user ticks, the file they pick, and the
// report they read. Reached only through the header button, so a check that rendered just the panel
// could not see any of it.
exports.transferPage = TransferPage;
// Exported for the same reason as `fitBeacon`: the trace a report carries is the one field that
// names the refusing stage, and a check cannot reach it through a page that has no layout.
exports.topStage = topStage;
