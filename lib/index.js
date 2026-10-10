/**
 * Host half of the term dictionary.
 *
 * It owns three things the page cannot own by itself:
 *  1. the durable dictionary file, under `$DSH_HOME/dsh-plugin-term-dictionary/`;
 *  2. an HTTP surface on the Web carrier's server, which the page reads and
 *     writes through relative `fetch` calls;
 *  3. an optional model call that writes a term's explanation.
 *
 * The merge rules are not re-implemented here: `lib/dictionary.js` is loaded
 * through `createRequire` so the host and the page apply exactly the same
 * normalization and merge, and an edit made offline in the page cannot be
 * mangled when it reaches the file.
 *
 * Only `node:` built-ins are imported. A workspace bundle is installed as a link
 * with no `node_modules` of its own, so a bare `@deepseek-ai/*` import would fail
 * to resolve — and the model, when it is needed, is reached through the
 * injected `llm` service rather than through a package import.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodePackCode, encodePackCode, sha256Hex } from "./pack-code.js";

/**
 * The package's own CommonJS core, shared verbatim with the browser half.
 *
 * Every core file lives under `lib/core/`, whose own package.json declares
 * `"type": "commonjs"`. That scope marker is load-bearing twice over: the parent
 * package is ESM (so a plain `.js` here would be parsed as a module and this
 * host half's `import` would fail), and the browser bundle's module table needs
 * callable `module.exports` values. The host half stays ESM, so it reaches the
 * core through `createRequire`.
 */
const require = createRequire(import.meta.url);
const dictionary = require("./core/dictionary.js");
const entries = require("./core/entries.js");
const packCore = require("./core/pack.js");

/** Route prefix owned by this plugin. The browser half spells the same string. */
const ROUTE_PREFIX = "/dsh-term-dictionary";

/** Largest accepted request body. A dictionary is small; anything larger is a bug. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Deadline for one explanation call. */
const EXPLAIN_TIMEOUT_MS = 45_000;

/** Upper bound on the explanation the model may return. */
const EXPLAIN_MAX_TOKENS = 700;

/**
 * The categories the host's feedback API accepts, spelled exactly as the host declares them.
 *
 * A closed set here too: the host validates its own, and passing an id it does not know would fail a
 * remark for a reason the user cannot see. `product-interaction` is the default because that is what a
 * dictionary entry's remark is about.
 */
const FEEDBACK_CATEGORIES = [
	"other",
	"task-result",
	"instruction-following",
	"product-interaction",
	"service-stability",
	"resource-cost",
	"security-privacy-permission"
];

/** Upper bound on one feedback remark: it is a line or two, not a document. */
const MAX_FEEDBACK_CHARS = 500;

/** How long a fetched index is reused before a source is asked again. */
const INDEX_TTL_MS = 60 * 60 * 1000;

/** How long a fetched pack is reused. Longer, because a pack is content rather than a listing. */
const PACK_TTL_MS = 24 * 60 * 60 * 1000;

/** Size caps on what a source may hand back, so one URL cannot fill the disk or the heap. */
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_PACK_BYTES = 4 * 1024 * 1024;

/** How long one fetch may take. Shorter than the model call: a static file is not thinking. */
const FETCH_TIMEOUT_MS = 15_000;

/** Test seam: injected by the tests, absent in the real host. */
let runtimeOverrides = null;

/**
 * The plugin's own version, for the packs it publishes.
 *
 * Read from the package rather than written here, so a published pack names the generation that built
 * it without a second place to keep the number in step. Best effort: a profile that cannot read its
 * own package.json still builds packs, they just do not name a build.
 *
 * @returns the version, or "".
 */
let cachedVersion = null;
function pluginVersion() {
	if (cachedVersion !== null) return cachedVersion;
	cachedVersion = "";
	try {
		const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		if (typeof parsed?.version === "string") cachedVersion = parsed.version;
	} catch (error) {
		void error;
	}
	return cachedVersion;
}

/**
 * Load the shared dictionary core. Indirection through `createRequire` keeps the
 * browser-facing file free of build tooling while giving the host the same code.
 * @returns the dictionary module.
 */
function core() {
	return runtimeOverrides?.dictionary ?? dictionary;
}

/**
 * Resolve the directory plugin-owned data lives in.
 *
 * The configured path wins. Otherwise the first candidate that can actually be
 * created and written to is used, because `$DSH_HOME` is not always writable —
 * an installation directory under a protected root, or a sandboxed process, can
 * refuse it. Falling back keeps the dictionary working instead of failing every
 * save, and the chosen path is reported to the page so the user can see where the
 * data went.
 *
 * @param configured - a path from the plugin config, when the user set one.
 * @param logger - optional warning sink.
 * @returns `{ directory, writable, candidates }`.
 */
function resolveDataDirectory(configured, logger) {
	const home = (process.env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
	const primary = typeof configured === "string" && configured.trim() !== "" ? configured.trim() : join(home, "dsh-plugin-term-dictionary");
	const candidates = configured !== undefined && configured !== null && configured !== ""
		? [primary]
		: [primary, join(tmpdir(), "dsh-plugin-term-dictionary")];
	for (const directory of candidates) {
		try {
			mkdirSync(directory, { recursive: true });
			const probe = join(directory, ".write-probe");
			writeFileSync(probe, "", "utf8");
			rmSync(probe, { force: true });
			return { directory, writable: true, candidates };
		} catch (error) {
			logger?.warn?.(
				`term-dictionary: ${directory} is not writable (${error instanceof Error ? error.message : String(error)}); trying the next location`
			);
		}
	}
	// Nothing was writable: report it and keep the dictionary in memory so the
	// session still works, rather than throwing during activation.
	logger?.warn?.(`term-dictionary: no writable data directory among ${candidates.join(", ")}; the dictionary will not persist`);
	return { directory: primary, writable: false, candidates };
}

/** The file system surface `lib/dictionary.js` expects. */
const fileSystem = { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync };

/**
 * Read a request body with a hard size ceiling.
 * @param req - the incoming request.
 * @returns the decoded UTF-8 body.
 * @throws {Error} when the body exceeds {@link MAX_BODY_BYTES}.
 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param payload - a JSON-serializable value.
 */
function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}

/**
 * Parse a JSON request body.
 * @param req - the incoming request.
 * @returns the parsed value, or null when the body is not a JSON object.
 */
async function readJson(req) {
	const text = await readBody(req);
	if (text.trim() === "") return null;
	const value = JSON.parse(text);
	return value !== null && typeof value === "object" ? value : null;
}

/**
 * Ask the model service for one term's explanation.
 *
 * The prompt is deliberately narrow: the model answers with a single JSON object,
 * and every field is re-validated here, so a chatty or malformed answer degrades
 * to "no explanation" instead of polluting the dictionary.
 *
 * @param llm - the model service; the caller proves it is mounted before calling.
 * @param config - the resolved plugin config (`provider`, `model`).
 * @param selection - the profile's default model service, when mounted.
 * @param term - the term to explain.
 * @param context - the sentence the term appeared in.
 * @param logger - optional warning sink.
 * @returns the definition fields, or throws with a readable message.
 */
async function explainTerm(llm, config, selection, term, context, logger, preferences) {
	const targets = await resolveTargets(llm, config, selection, logger);
	let lastError = null;
	for (let at = 0; at < targets.length; at++) {
		const target = targets[at];
		try {
			return await streamExplanation(llm, target, term, context, logger, preferences);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// A route that cannot authenticate is not a dead end. The next candidate is
			// precisely what the user means by "the model I am already signed in to", and
			// reporting the credential error instead is what produced a failure message that
			// named a route the user never chose.
			if (!isCredentialFailure(message) || at === targets.length - 1) throw error;
			logger?.warn?.(`term-dictionary: route ${target.provider} cannot authenticate (${message}); trying the next route`);
			lastError = error;
		}
	}
	throw lastError ?? new Error("no model route could be used");
}

/**
 * Stream one explanation through one already-chosen route.
 *
 * Split out of {@link explainTerm} so that a credential failure can be caught per route:
 * the retry has to wrap the whole call, including stream iteration, because the adapter
 * reports a missing key as a terminal `finish` chunk rather than by throwing at dispatch.
 *
 * @param llm - the model service.
 * @param target - the route, from {@link resolveTargets}.
 * @param term - the term to explain.
 * @param context - the text the term appeared in.
 * @param logger - optional warning sink.
 * @param preferences - the user's `{ lang, depth, retry }`.
 * @returns the definition fields, or throws with a readable message.
 */
async function streamExplanation(llm, target, term, context, logger, preferences) {
	const controller = typeof AbortController === "function" ? new AbortController() : null;
	const timer = controller === null ? null : setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT_MS);
	try {
		const stream = llm.stream({
			provider: target.provider,
			model: target.model,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildPrompt(term, context) }]
				}
			],
			system: buildSystemPrompt(preferences),
			temperature: 0.2,
			maxTokens: EXPLAIN_MAX_TOKENS,
			...(controller === null ? {} : { signal: controller.signal })
		});
		let text = "";
		let failure = null;
		for await (const chunk of stream) {
			if (chunk === null || typeof chunk !== "object") continue;
			if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
			else if (chunk.type === "finish") failure = finishFailure(chunk.reason);
		}
		if (failure !== null) throw new Error(failure);
		const parsed = parseExplanation(text);
		if (parsed === null) throw new Error("the model did not return a usable explanation");
		return parsed;
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
}

/**
 * Decide which provider/model pair to call.
 *
 * The order of preference is the whole point of this function:
 *
 *  1. the plugin's own `config.provider` / `config.model`, when set;
 *  2. **the profile's own default model selection** (`agentDefaultModel`), which is
 *     the route the agent in this window is already talking through — so it is a route
 *     that is known to be configured and credentialed in *this* deployment;
 *  3. the first registered provider, with the first model it advertises.
 *
 * Step 2 exists because step 3 alone picked the wrong adapter. `listProviders()`
 * returns providers in registration order, and in this profile the official
 * API-key route (`deepseek-official`) is registered before the signed-in account
 * route (`deepseek-account`). Generating an explanation therefore failed with
 *
 *   llm-deepseek: no API key for provider route "deepseek-official";
 *   store DEEPSEEK_API_KEY through the credentials service
 *
 * while the window itself was happily using `deepseek-account` — the profile's
 * configured provider. Asking the deployment what it uses is the only way to be right
 * about which route can actually answer.
 *
 * @param llm - the model service.
 * @param config - resolved plugin config.
 * @param selection - the profile's default model service, when one is mounted.
 * @param logger - optional warning sink.
 * @returns every route to try, best first.
 * @throws {Error} when nothing can be routed.
 */
async function resolveTargets(llm, config, selection, logger) {
	const configured = typeof config.provider === "string" ? config.provider.trim() : "";
	const preferred = readSelection(selection, logger);
	const providers = typeof llm.listProviders === "function" ? llm.listProviders() : [];
	const order = [];
	/** Add a route once, ignoring blanks and duplicates. */
	const push = (provider) => {
		const name = typeof provider === "string" ? provider.trim() : "";
		if (name !== "" && !order.includes(name)) order.push(name);
	};
	if (configured !== "") {
		// An explicit configuration tries ONE route. Falling through to another would ignore
		// the operator's choice, and its failure is theirs to see.
		push(configured);
	} else {
		// The selection is tried even when the catalog does not list it: a route this half
		// cannot see is still the best available answer to "which model is this window using",
		// and the old visibility test is exactly what threw it away and picked the API-key
		// route instead.
		if (preferred !== null) push(preferred.provider);
		if (Array.isArray(providers)) for (const entry of providers) push(entry?.id);
	}
	if (order.length === 0) throw new Error("no model provider is available");
	const targets = [];
	for (const provider of order) {
		const own = preferred !== null && preferred.provider === provider ? preferred.model : "";
		targets.push(await targetFor(llm, config, provider, own));
	}
	return targets;
}

/**
 * Whether a failure says "this route has no credential".
 *
 * Only this kind of failure is worth another route. A missing API key is a property of the
 * ROUTE, not of the request, so the next candidate can legitimately succeed; every other
 * failure (a refused request, an unknown model, a timeout) would be a real error sent to a
 * second provider for no reason, so it is reported as it is.
 *
 * @param message - the failure text.
 * @returns true when trying the next route is justified.
 */
function isCredentialFailure(message) {
	return /no api key|api key|apikey|credential|unauthoriz|unauthoris|unauthorized|not authenticated/i.test(String(message ?? ""));
}

/**
 * Read the profile's default model selection, defensively.
 *
 * An unmounted owner, a service that throws, or a half-filled selection all yield null so the
 * caller falls through to the catalog rather than failing the call.
 *
 * @param selection - the `agentDefaultModel` service, when mounted.
 * @param logger - optional warning sink.
 * @returns `{ provider, model }`, or null.
 */
function readSelection(selection, logger) {
	if (selection === null || selection === undefined) return null;
	try {
		const current = typeof selection.currentSelection === "function" ? selection.currentSelection() : null;
		if (current !== null && typeof current === "object" && typeof current.provider === "string" && current.provider.trim() !== "") {
			return {
				provider: current.provider.trim(),
				model: typeof current.model === "string" && current.model.trim() !== "" ? current.model.trim() : ""
			};
		}
	} catch (error) {
		logger?.warn?.(`term-dictionary: reading the default model selection failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return null;
}

/**
 * Choose a model for one provider.
 *
 * @param llm - the model service.
 * @param config - the resolved plugin config.
 * @param provider - the route.
 * @param preferredModel - the selection's model, when this IS the selection's route.
 * @returns `{ provider, model }`.
 */
async function targetFor(llm, config, provider, preferredModel) {
	if (typeof config.model === "string" && config.model.trim() !== "") return { provider, model: config.model.trim() };
	// A selection's model applies only to the selection's own provider: taking it across
	// providers would ask one adapter for another's model id.
	if (typeof preferredModel === "string" && preferredModel !== "") return { provider, model: preferredModel };
	let models = [];
	try {
		models = await llm.listModels(provider);
	} catch (error) {
		models = [];
	}
	const model = Array.isArray(models) && typeof models[0]?.id === "string" ? models[0].id : "deepseek-flash";
	return { provider, model };
}

/** The first route to try, for callers that take a single target. @returns the route. */
async function resolveTarget(llm, config, selection, logger) {
	return (await resolveTargets(llm, config, selection, logger))[0];
}

/** The instruction the model answers. */
const SYSTEM_PROMPT = [
	"You are building a glossary for a Chinese reader who is a software engineer.",
	"Explain the given term as it is used in the given context.",
	"Answer with ONE JSON object and nothing else, with exactly these keys:",
	'{"zh": "...", "gloss": "...", "usage": "...", "domain": "..."}',
	"- zh: the term's Chinese name, 2-8 Chinese characters.",
	'- gloss: one or two Chinese sentences explaining what it means and why it matters.',
	"- usage: one short Chinese sentence showing it in use, or an empty string.",
	"- domain: one Chinese domain label such as 软件工程 / 人工智能 / 数据 / 网络 / 安全 / 运维.",
	"Do not use markdown fences. Do not add keys. Do not answer in English.",
].join("\n");

/**
 * The system instruction for one explanation, given the user's preferences.
 *
 * The base prompt is kept and only narrowed or widened by a clause, because it is the text
 * whose output shape the parser and the tests already agree on — rewriting it per depth would
 * be four prompts to keep in sync. The English case is the exception: the base prompt ends with
 * "Do not answer in English", so it cannot be reused, and English gets its own instruction
 * while the JSON KEYS stay the same (they are field names, not prose).
 *
 * @param preferences - `{ lang, depth, retry }` as sent by the page.
 * @returns the instruction.
 */
function buildSystemPrompt(preferences) {
	const depth = preferences?.depth === "brief" ? "brief" : preferences?.depth === "detailed" ? "detailed" : "normal";
	// A second attempt at an entry the user called wrong. The sentence is FIXED and says nothing about
	// what they objected to: their note is their own text, and feeding it to a model would turn a
	// remark into an instruction. What the model can act on is simply that the last answer was
	// rejected — which is the one thing the user's verdict does establish.
	const retry = preferences?.retry === true;
	const retryZh = retry ? "\n注意：上一个解释被使用者否掉了，请换一个更具体的说法，不要重复套话。" : "";
	// `lang` is a CLOSED set here: exactly `en` selects the English instruction, and everything
	// else — `zh`, `auto`, absent, unrecognized — produces the Chinese one.
	//
	// `auto` deliberately still means Chinese rather than "follow the UI": the page resolves
	// `auto` against the active locale BEFORE sending, because only the page knows which locale
	// is active. A request arriving with `auto` therefore comes from something other than this
	// plugin's own client, and an interface language cannot be guessed at this end. Spelling
	// that out is the point: the old `!== "en"` test made the same decision but read as an
	// accident, which is how a closed set turns into a silent default nobody can find.
	if (preferences?.lang !== "en") {
		if (depth === "brief") return `${SYSTEM_PROMPT}\n再简短些：gloss 只写一句不超过 20 字的话，usage 留空。${retryZh}`;
		if (depth === "detailed") return `${SYSTEM_PROMPT}\n再充实些：gloss 写两到三句，说明它是什么、怎么工作、为什么重要；usage 给一个完整例句。${retryZh}`;
		return `${SYSTEM_PROMPT}${retryZh}`;
	}
	const gloss =
		depth === "brief"
			? "one English sentence, at most 20 words."
			: depth === "detailed"
				? "two or three English sentences covering what it is, how it works, and why it matters."
				: "one or two English sentences explaining what it means and why it matters.";
	const usage = depth === "brief" ? "an empty string." : "one short English sentence showing it in use, or an empty string.";
	return [
		"Explain the given term as it is used in the given context.",
		"Answer with ONE JSON object and nothing else, with exactly these keys:",
		'{"zh": "...", "gloss": "...", "usage": "...", "domain": "..."}',
		"- zh: the term's short Chinese name, 2-8 Chinese characters. This field stays Chinese.",
		`- gloss: ${gloss}`,
		`- usage: ${usage}`,
		"- domain: one short English label such as software engineering / AI / data / networking / security / operations.",
		"Do not use markdown fences. Do not add keys.",
		// Same fixed sentence as the Chinese branch, in the language the answer is written in.
		...(retry ? ["Note: the previous explanation was rejected by the user. Take a different, more specific angle rather than restating the obvious."] : [])
	].join("\n");
}

/** The per-term instruction. */
function buildPrompt(term, context) {
	const trimmed = typeof context === "string" ? context.trim() : "";
	return trimmed === ""
		? `术语：${term}`
		: `术语：${term}\n它出现的上下文：${trimmed.slice(0, 600)}`;
}

/**
 * Translate a terminal `finish` reason into a failure message.
 * @param reason - the finish payload.
 * @returns a message, or null when the stream ended normally.
 */
function finishFailure(reason) {
	if (reason === null || typeof reason !== "object") return null;
	if (reason.kind === "error" || reason.kind === "aborted") {
		const message = reason.failure !== null && typeof reason.failure === "object" && typeof reason.failure.message === "string"
			? reason.failure.message
			: "the model call failed";
		return message;
	}
	return null;
}

/**
 * Pull the explanation object out of a model answer.
 *
 * The answer is untrusted: it may carry fences, prose, or a truncated object, so
 * the first balanced `{...}` run is tried and every field is validated.
 *
 * @param text - the model's raw answer.
 * @returns the four definition fields, or null when nothing usable is present.
 */
function parseExplanation(text) {
	if (typeof text !== "string" || text.trim() === "") return null;
	const cleaned = text.replace(/```(?:json)?/gi, "").trim();
	for (const candidate of balancedObjects(cleaned)) {
		let parsed;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const gloss = typeof parsed.gloss === "string" ? parsed.gloss.trim() : "";
		if (gloss === "") continue;
		return {
			zh: typeof parsed.zh === "string" ? parsed.zh.trim().slice(0, 60) : "",
			gloss: gloss.slice(0, entries.MAX_DEFINITION_CHARS),
			usage: typeof parsed.usage === "string" ? parsed.usage.trim().slice(0, entries.MAX_DEFINITION_CHARS) : "",
			domain: typeof parsed.domain === "string" ? parsed.domain.trim().slice(0, 24) : ""
		};
	}
	return null;
}

/**
 * Every top-level `{...}` run in a string, longest first.
 * @param text - the text to scan.
 * @returns candidate JSON objects as text.
 */
function balancedObjects(text) {
	const found = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{") {
			if (depth === 0) start = index;
			depth++;
			continue;
		}
		if (character === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				found.push(text.slice(start, index + 1));
				start = -1;
			}
		}
	}
	return found.sort((left, right) => right.length - left.length);
}

/**
 * Plugin entry. Registers the dictionary file store and the HTTP routes.
 *
 * @param ctx - the host plugin context.
 * @param config - the resolved plugin config.
 */
export function apply(ctx, config) {
	const resolved = config ?? {};
	const logger = ctx.logger;
	const location = resolveDataDirectory(resolved.dataDir, logger);
	const file = join(location.directory, "dictionary.json");
	const store = dictionary.createFileStore(fileSystem, file, location.writable ? logger : null);
	let state = store.load();

	/** Persist the current document, in the background. */
	function persist() {
		void store.save(state).catch((error) => {
			logger?.warn?.(`term-dictionary: saving failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	/**
	 * Run one mutating operation and persist only when it changed something.
	 * @param operation - a function from document to `{ state, ... }`.
	 * @returns the operation's result.
	 */
	function mutate(operation) {
		const result = operation(state);
		if (result !== null && typeof result === "object" && result.state !== undefined && result.state !== state) {
			state = result.state;
			persist();
		}
		return result;
	}

	ctx.effect(() => () => {
		// Nothing owns an open handle, but persisting on unload keeps a queued write
		// from being lost when the fiber is disposed mid-edit.
		persist();
	}, "term-dictionary: final flush");

	// The model is optional. Declaring it in the root `inject` would keep the whole
	// plugin dormant in a profile with no adapter — including the dictionary routes,
	// which need no model at all. A child context gets the service when it appears
	// and is torn down when it leaves, so the buttons that need a model simply
	// report that none is mounted.
	let model = null;
	ctx.inject(["llm"], (llmCtx) => {
		model = llmCtx.llm;
		ctx.effect(() => () => {
			model = null;
		}, "term-dictionary: model service detached");
	});

	// The profile's own default model route, used to pick a provider that is actually
	// configured and credentialed here. Optional for the same reason `llm` is: a
	// composition without it must still serve the dictionary.
	let defaultModel = null;
	ctx.inject(["agentDefaultModel"], (selectionCtx) => {
		defaultModel = selectionCtx.agentDefaultModel;
		ctx.effect(() => () => {
			defaultModel = null;
		}, "term-dictionary: default model service detached");
	});

	// The host's own feedback channel, optional for the same reason `llm` is.
	//
	// `remote.sessionFeedback` is the CLIENT-side projection of this service, and asking the page for
	// it would mean listing it in the client half's `inject` — where a service that never arrives parks
	// the WHOLE package (the panel, the underlines, every gesture) waiting for it. A live desktop
	// profile was measured with no `remote` service at all, so that inject would have killed the
	// plugin on the machine it was written on. The optional child context is the runtime's own answer:
	// the page talks to its own route, and a composition without the channel reports that it has none.
	let feedback = null;
	ctx.inject(["sessionFeedback"], (feedbackCtx) => {
		feedback = feedbackCtx.sessionFeedback;
		ctx.effect(() => () => {
			feedback = null;
		}, "term-dictionary: feedback channel detached");
	});

	const prefix = { kind: "prefix", path: ROUTE_PREFIX };

	ctx.effect(
		() =>
			ctx.webServer.register({
				...prefix,
				handler: async (req, res) => {
					try {
						await route(req, res);
					} catch (error) {
						sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}),
		`term-dictionary: routes under ${ROUTE_PREFIX}`
	);

	/**
	 * Dispatch one request inside the plugin's prefix.
	 * @param req - the incoming request.
	 * @param res - the response to own.
	 */
	async function route(req, res) {
		const path = new URL(req.url ?? "/", "http://dsh.invalid").pathname.slice(ROUTE_PREFIX.length) || "/";
		if (path === "/state" || path === "/") {
			if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			// `serializeState` emits only what a reader may see: live entries, the
			// keys of deleted ones, and no tombstone bodies. The page needs the keys
			// so a window that never held the tombstone still learns about the
			// deletion, and `location` so a fallback directory or a read-only profile
			// is visible rather than silent.
			return sendJson(res, 200, {
				...dictionary.serializeState(dictionary.seal(state)),
				location: { directory: location.directory, writable: location.writable, model: model !== null }
			});
		}
		if (path === "/entries") {
			if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
			const body = await readJson(req);
			if (body === null) return sendJson(res, 400, { error: "a JSON object body is required" });
			return handleEntries(res, body);
		}
		if (path === "/explain") {
			if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
			const body = await readJson(req);
			if (body === null) return sendJson(res, 400, { error: "a JSON object body is required" });
			return handleExplain(res, body);
		}
		if (path === "/feedback") {
			if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
			const body = await readJson(req);
			if (body === null) return sendJson(res, 400, { error: "a JSON object body is required" });
			return handleFeedback(res, body);
		}
		if (path === "/pack") {
			if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
			const body = await readJson(req);
			if (body === null) return sendJson(res, 400, { error: "a JSON object body is required" });
			return handlePack(res, body);
		}
		if (path === "/source/index") {
			if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			return handleSourceIndex(res, new URL(req.url ?? "/", "http://dsh.invalid").searchParams);
		}
		if (path === "/source/pack") {
			if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			return handleSourcePack(res, new URL(req.url ?? "/", "http://dsh.invalid").searchParams);
		}
		return sendJson(res, 404, { error: `unknown route ${path}` });
	}

	/**
	 * `POST /entries` — the page's write path.
	 *
	 * Three actions: `replace` (the page's whole document, merged term by term),
	 * `record` (one sighting), and `remove`.
	 *
	 * @param res - the response to own.
	 * @param body - the parsed request body.
	 */
	function handleEntries(res, body) {
		const action = typeof body.action === "string" ? body.action : "replace";
		if (action === "replace") {
			if (body.state === undefined) return sendJson(res, 400, { error: "action replace requires state" });
			state = core().mergeState(state, body.state);
			persist();
			return sendJson(res, 200, core().serializeState(core().seal(state)));		}
		if (action === "record") {
			if (typeof body.term !== "string" || body.term.trim() === "") return sendJson(res, 400, { error: "action record requires term" });
			const result = mutate((current) =>
				core().recordSighting(
					current,
					{
						term: body.term,
						context: typeof body.context === "string" ? body.context : "",
						glossary: body.glossary !== null && typeof body.glossary === "object" ? body.glossary : undefined,
						sessionId: typeof body.sessionId === "string" ? body.sessionId : ""
					},
					{ now: Date.now() }
				)
			);
			return sendJson(res, 200, { ok: true, created: result.created === true, entry: result.entry ?? null });
		}
		if (action === "remove") {
			const target = typeof body.id === "string" && body.id !== "" ? body.id : typeof body.term === "string" ? body.term : "";
			if (target === "") return sendJson(res, 400, { error: "action remove requires id or term" });
			const result = mutate((current) => core().removeEntry(current, target, { now: Date.now() }));
			return sendJson(res, 200, { ok: true, removed: result.removed === true });
		}
		if (action === "update") {
			if (typeof body.term !== "string" || body.term.trim() === "") return sendJson(res, 400, { error: "action update requires term" });
			const result = mutate((current) =>
				core().editEntry(
					current,
					body.term,
					{
						definition: body.definition !== null && typeof body.definition === "object" ? body.definition : undefined,
						domain: typeof body.domain === "string" ? body.domain : undefined,
						aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
						pinned: typeof body.pinned === "boolean" ? body.pinned : undefined
					},
					{ now: Date.now() }
				)
			);
			return sendJson(res, 200, { ok: true, entry: result.entry ?? null });
		}
		return sendJson(res, 400, { error: `unknown action ${action}` });
	}

	/**
	 * `POST /explain` — ask the model for one term's explanation and store it.
	 * @param res - the response to own.
	 * @param body - the parsed request body.
	 */
	async function handleExplain(res, body) {
		const term = typeof body.term === "string" ? body.term.trim() : "";
		if (term === "") return sendJson(res, 400, { error: "term is required" });
		if (model === null) return sendJson(res, 503, { error: "no model service is mounted in this profile" });
		let definition;
		try {
			definition = await explainTerm(model, resolved, defaultModel, term, typeof body.context === "string" ? body.context : "", logger, {
					lang: typeof body.lang === "string" ? body.lang : "auto",
					depth: typeof body.depth === "string" ? body.depth : "normal",
					// Strictly `true`, like every other field the page sends: a truthy string from some
					// other caller must not be able to change the instruction.
					retry: body.retry === true
				});
		} catch (error) {
			return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
		}
		const result = mutate((current) =>
			core().editEntry(current, term, { definition, domain: definition.domain }, { now: Date.now() })
		);
		return sendJson(res, 200, {
			ok: true,
			definition,
			source: "llm",
			entry: result.entry ?? null
		});
	}

	/**
	 * `POST /feedback` — record one remark into the host's own session feedback log.
	 *
	 * What this channel is: the host keeps the remark in THIS machine's session log, where it never
	 * enters a model's context. What it is NOT: a way to reach the plugin's author — nothing leaves the
	 * machine — which is exactly why the plugin also exports a report the user can send themselves.
	 *
	 * `unavailable` comes back as a 200 with `ok: false`, not as an HTTP error: a composition without
	 * the feedback channel is a normal state, and the page distinguishes "this build cannot" from "that
	 * session is gone" and from "the host refused".
	 *
	 * @param res - the response to own.
	 * @param body - the parsed request body.
	 */
	async function handleFeedback(res, body) {
		if (feedback === null) return sendJson(res, 200, { ok: false, error: "unavailable" });
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
		if (sessionId === "") return sendJson(res, 400, { error: "sessionId is required" });
		const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_FEEDBACK_CHARS) : "";
		const category = FEEDBACK_CATEGORIES.includes(body.category) ? body.category : "product-interaction";
		let outcome;
		try {
			outcome = await feedback.record({ sessionId, text, category });
		} catch (error) {
			return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
		}
		if (outcome?.ok !== true) {
			// The one failure worth naming: the page is holding a session id the host no longer has a
			// live session for, which is a different thing from a channel that refused the remark.
			return sendJson(res, 200, { ok: false, error: outcome?.error?.code === "session-not-found" ? "session-not-found" : "rejected" });
		}
		return sendJson(res, 200, { ok: true });
	}

	/**
	 * `POST /pack` — build a pack from this dictionary, or read one back from a share code.
	 *
	 * `action: "build"` publishes; `action: "decode"` reads. They share a route because they are the
	 * two directions of one thing, and because a caller that can do one usually wants the other.
	 *
	 * @param res - the response to own.
	 * @param body - the parsed request body.
	 */
	async function handlePack(res, body) {
		if (body.action === "decode") {
			const decoded = decodePackCode(body.code);
			if (decoded.ok !== true) return sendJson(res, 400, { error: decoded.error });
			return sendJson(res, 200, { ok: true, pack: decoded.pack, summary: packCore.summarizePack(decoded.pack) });
		}
		if (body.action !== "build") return sendJson(res, 400, { error: "action must be build or decode" });
		const built = packCore.buildPack(dictionary.serializeState(dictionary.seal(state)).entries, {
			id: body.id,
			name: body.name,
			description: body.description,
			author: body.author,
			license: body.license,
			homepage: body.homepage,
			build: pluginVersion(),
			scope: body.scope,
			domains: body.domains,
			now: Date.now()
		});
		// A pack with nothing in it is refused rather than published empty, and the reason says which
		// emptiness it was: the whole dictionary is empty, or the chosen categories are.
		if (built.ok !== true) return sendJson(res, 400, { error: built.error });
		const text = packCore.packBytes(built.pack);
		return sendJson(res, 200, {
			ok: true,
			pack: built.pack,
			summary: packCore.summarizePack(built.pack),
			sha256: sha256Hex(text),
			bytes: Buffer.byteLength(text, "utf8"),
			// The code only when it was asked for: encoding is cheap, but a response carrying a code
			// nobody wanted makes every log line of this route enormous.
			...(body.code === true ? { code: encodePackCode(built.pack) } : {})
		});
	}

	/**
	 * `GET /source/index` — the list of packs a source URL offers, through a cache.
	 *
	 * A source is somebody else's static file. The cache exists so that opening the packs page does not
	 * mean a request every time, and so an unreachable source still shows what it last said — marked
	 * stale rather than presented as current.
	 *
	 * @param res - the response to own.
	 * @param params - the query string.
	 */
	async function handleSourceIndex(res, params) {
		const url = params.get("url") ?? "";
		const refusal = packCore.refuseUrl(url);
		if (refusal !== null) return sendJson(res, 400, { error: refusal });
		const cache = readCache();
		const entry = cache.indexes?.[url];
		const fresh = entry !== undefined && Date.now() - entry.fetchedAt < INDEX_TTL_MS;
		if (fresh && params.get("refresh") !== "1") {
			return sendJson(res, 200, { ok: true, index: entry.index, fetchedAt: entry.fetchedAt, cached: true });
		}
		const fetched = await fetchText(url, MAX_INDEX_BYTES);
		if (fetched.ok !== true) {
			// An unreachable source with a usable cache is not a failure the page should shout about: it
			// is yesterday's list, and saying so is more useful than an error.
			if (entry !== undefined) {
				return sendJson(res, 200, { ok: true, index: entry.index, fetchedAt: entry.fetchedAt, cached: true, stale: true, error: fetched.error });
			}
			return sendJson(res, 200, { ok: false, error: fetched.error });
		}
		let raw;
		try {
			raw = JSON.parse(fetched.text);
		} catch (error) {
			void error;
			return sendJson(res, 200, { ok: false, error: "not-json" });
		}
		const parsed = packCore.parseIndex(raw);
		if (parsed.ok !== true) return sendJson(res, 200, { ok: false, error: parsed.error });
		const fetchedAt = Date.now();
		writeCache({ ...cache, indexes: { ...(cache.indexes ?? {}), [url]: { fetchedAt, index: parsed.index } } });
		return sendJson(res, 200, { ok: true, index: parsed.index, fetchedAt, cached: false, dropped: parsed.dropped });
	}

	/**
	 * `GET /source/pack` — one pack from a source, checksum-verified when the index promised one.
	 *
	 * The checksum is the whole point of the index carrying one: the file comes from a URL a third
	 * party wrote, and without a digest there is nothing to compare it against.
	 *
	 * @param res - the response to own.
	 * @param params - the query string.
	 */
	async function handleSourcePack(res, params) {
		const url = params.get("url") ?? "";
		const refusal = packCore.refuseUrl(url);
		if (refusal !== null) return sendJson(res, 400, { error: refusal });
		const promised = (params.get("sha256") ?? "").trim().toLowerCase();
		const cache = readCache();
		const entry = cache.packs?.[url];
		const fresh = entry !== undefined && Date.now() - entry.fetchedAt < PACK_TTL_MS;
		let text = null;
		let fetchedAt = Date.now();
		let cached = false;
		if (fresh) {
			// The cache is keyed by URL but the DIGEST is re-checked every time: a cached body is still a
			// body from somewhere else, and the promise must hold for it too.
			text = entry.text;
			fetchedAt = entry.fetchedAt;
			cached = true;
		} else {
			const fetched = await fetchText(url, MAX_PACK_BYTES);
			if (fetched.ok !== true) return sendJson(res, 200, { ok: false, error: fetched.error });
			text = fetched.text;
		}
		let digest = sha256Hex(text);
		if (cached && promised !== "" && promised !== digest) {
			// A cached copy that fails the promise is a STALE cached copy — somebody republished the file
			// — and the digest is the authority, not the cache. Without this, republishing a pack made
			// every reader see `checksum-mismatch` until the cache expired a day later, which looks
			// exactly like a broken pack.
			const refetched = await fetchText(url, MAX_PACK_BYTES);
			if (refetched.ok !== true) return sendJson(res, 200, { ok: false, error: refetched.error });
			text = refetched.text;
			digest = sha256Hex(text);
			fetchedAt = Date.now();
			cached = false;
		}
		if (promised !== "" && promised !== digest) {
			return sendJson(res, 200, { ok: false, error: "checksum-mismatch", sha256: digest });
		}
		let raw;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			void error;
			return sendJson(res, 200, { ok: false, error: "not-json" });
		}
		const parsed = packCore.parsePack(raw);
		if (parsed.ok !== true) return sendJson(res, 200, { ok: false, error: parsed.error });
		if (!cached) writeCache({ ...cache, packs: { ...(cache.packs ?? {}), [url]: { fetchedAt, text } } });
		return sendJson(res, 200, { ok: true, pack: parsed.pack, summary: packCore.summarizePack(parsed.pack), sha256: digest, cached });
	}

	/** The cache file's contents, or an empty object when there is none to read. */
	function readCache() {
		const file = join(location.directory, "sources.json");
		try {
			const raw = fileSystem.readFileSync(file, "utf8");
			const parsed = JSON.parse(raw);
			return parsed !== null && typeof parsed === "object" ? parsed : {};
		} catch (error) {
			// Absent, unreadable or corrupt all mean the same thing here: ask the source again.
			void error;
			return {};
		}
	}

	/** Write the cache, or quietly do without one when the profile is read-only. */
	function writeCache(next) {
		if (!location.writable) return;
		const file = join(location.directory, "sources.json");
		try {
			fileSystem.mkdirSync(dirname(file), { recursive: true });
			// Written through a temporary file: a fetch that dies mid-write must not leave a cache the
			// next read cannot parse, which would silently turn every source into "unreachable".
			const temporary = `${file}.tmp`;
			fileSystem.writeFileSync(temporary, JSON.stringify(next), "utf8");
			fileSystem.renameSync(temporary, file);
		} catch (error) {
			logger?.warn?.(`term-dictionary: could not write the source cache (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	/**
	 * Fetch one text document from a URL that has already passed {@link packCore.refuseUrl}.
	 *
	 * @param url - an https URL.
	 * @param maxBytes - the size cap for this document.
	 * @returns `{ ok: true, text }`, or `{ ok: false, error }` with `unreachable`, `http-<status>` or
	 *   `too-large`.
	 */
	async function fetchText(url, maxBytes) {
		const doFetch = typeof runtimeOverrides?.fetch === "function" ? runtimeOverrides.fetch : globalThis.fetch;
		if (typeof doFetch !== "function") return { ok: false, error: "no-fetch" };
		try {
			const response = await doFetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if (response?.ok !== true) return { ok: false, error: `http-${response?.status ?? 0}` };
			const text = await response.text();
			if (typeof text !== "string" || text === "") return { ok: false, error: "empty" };
			// Measured on the bytes, not on the character count: a page of Chinese is three times the
			// size its length suggests, and a cap that can be tripled is not a cap.
			if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, error: "too-large" };
			return { ok: true, text };
		} catch (error) {
			// Timeout, DNS, TLS and connection reset all arrive here. The page cannot act differently on
			// any of them, and a source that is briefly down is a normal state rather than a bug.
			void error;
			return { ok: false, error: "unreachable" };
		}
	}
}

	/** The services this bundle needs before it may activate. */
export const inject = ["webServer"];
/*
 * There is deliberately NO `Config` export here.
 *
 * Cordis validates a row's `config` through `runtime.Config["~standard"].validate`,
 * i.e. it requires a **Standard Schema**. A JSON Schema object exported as `Config`
 * is not one: activation died with
 *
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 *     at resolveConfig (.../cordis/lib/index.js)
 *
 * which looks like a broken plugin rather than a schema mismatch. The DSH-native way
 * to declare one is `z.object({...})` from `@deepseek-ai/schemastery`, but that is a
 * HOST package: it is not resolvable from a plugin linked into a profile, and no
 * third-party plugin installed here uses it. Declaring no schema leaves the row's
 * `config` untouched (`resolveConfig` returns it unchanged), and every field below is
 * read defensively in this file, so a missing or malformed value falls back instead
 * of failing:
 *
 *   provider  — must be a non-empty string to be used, else the profile's own default
 *               model route is chosen, and only failing that the first registered
 *               provider.
 *   model     — must be a non-empty string to be used, else the chosen route's own
 *               default model.
 *   dataDir   — must be a non-empty string to be used, else $DSH_HOME/dsh-plugin-term-dictionary.
 */

/** Test seam: swap the shared core or inject fake services. */
export function __testing(overrides) {
	runtimeOverrides = overrides ?? null;
}

/**
 * Test seam: the provider/model precedence used by `POST /explain`.
 *
 * Exported because the rule it encodes was wrong once in a way no test could see: the
 * plugin asked the first registered provider, which in this profile is the API-key
 * route, and generation failed while the window was using a different, working route.
 */
export const __resolveTarget = resolveTarget;
export const __resolveTargets = resolveTargets;
export const __isCredentialFailure = isCredentialFailure;
export const __buildSystemPrompt = buildSystemPrompt;
