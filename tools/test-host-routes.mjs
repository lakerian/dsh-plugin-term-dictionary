// End-to-end test of the plugin's host half over real HTTP.
//
// The host half registers three routes on the Web carrier's server. This harness
// starts a real `node:http` server, hands the plugin the same handler contract the
// carrier uses, and drives the routes with `fetch` — so it proves the contract the
// page depends on: status codes, the JSON the page parses, how a sighting merges
// into an existing entry, and that the dictionary survives a restart of the host.
//
// Usage: node tools/test-host-routes.mjs [--filter <substring>]

import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pluginDir } from "./paths.mjs";

const filterArg = process.argv.indexOf("--filter");
const filter = filterArg > 0 ? process.argv[filterArg + 1] : "";

let passed = 0;
let failed = 0;

/** Checks queued by {@link test}, run in order so each sees the previous one's writes. */
const checks = [];

/**
 * Queue one named check.
 * @param name - the check's name.
 * @param fn - a function that may await and must throw on failure.
 */
function test(name, fn) {
	if (filter !== "" && !name.includes(filter)) return;
	checks.push({ name, fn });
}

/**
 * Run every queued check in order.
 * @returns a promise settling when all have run.
 */
async function runChecks() {
	for (const check of checks) {
		try {
			await check.fn();
			passed++;
			console.log(`  ok   ${check.name}`);
		} catch (error) {
			failed++;
			console.log(`  FAIL ${check.name}\n       ${error instanceof Error ? error.message : String(error)}`);
		}
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

/**
 * Start a server around the plugin's routes.
 *
 * The plugin registers through `ctx.webServer.register`, which the real carrier
 * implements as a route table in front of `node:http`; this harness reproduces the
 * same matching (longest prefix wins) so the handler sees a real IncomingMessage.
 *
 * @param options - `dataDir` and `logger` overrides.
 * @returns `{ url, close, registered, effects }`.
 */
async function startHost(options = {}) {
	const routes = [];
	const effects = [];
	const warnings = [];
	const logger = { warn: (message) => warnings.push(String(message)), info: () => {}, error: () => {} };

	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		const match = routes
			.filter((route) => (route.kind === "prefix" ? path.startsWith(route.path) : path === route.path))
			.sort((left, right) => right.path.length - left.path.length)[0];
		if (match === undefined) {
			res.writeHead(404);
			res.end();
			return;
		}
		Promise.resolve(match.handler(req, res)).catch((error) => {
			if (!res.headersSent) res.writeHead(400);
			res.end(String(error));
		});
	});
	await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
	const port = server.address().port;

	const context = {
		logger,
		webServer: {
			register(route) {
				routes.push(route);
				return () => {
					const at = routes.indexOf(route);
					if (at >= 0) routes.splice(at, 1);
				};
			}
		},
		effect(fn, label) {
			effects.push(label);
			const dispose = fn();
			return typeof dispose === "function" ? dispose : () => {};
		},
		on: () => () => {},
		get: () => undefined,
		inject(deps, callback) {
			// A service is offered only when the harness was handed one. With none, the plugin must
			// still activate and must report the missing service rather than throwing — that is the
			// whole point of the optional child context the host half uses for `llm`,
			// `agentDefaultModel` and the feedback channel.
			const wanted = Array.isArray(deps) ? deps : [];
			const provided = options.services ?? {};
			if (wanted.length === 0 || wanted.some((name) => provided[name] === undefined)) return () => {};
			const child = { ...context };
			for (const name of wanted) child[name] = provided[name];
			callback(child);
			return () => {};
		}
	};

	const module = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
	module.apply(context, { dataDir: options.dataDir, ...(options.config ?? {}) });

	return {
		url: `http://127.0.0.1:${port}`,
		routes,
		effects,
		warnings,
		close: () => new Promise((done) => server.close(done))
	};
}

/** POST one JSON body and return the parsed answer with its status. */
async function post(url, body) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	const text = await response.text();
	return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

/** GET one route and return the parsed answer with its status. */
async function get(url) {
	const response = await fetch(url);
	const text = await response.text();
	return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

/**
 * Drive the whole suite. One async scope keeps the server, the temp directory and
 * the check closures over the same `host` binding.
 * @returns a promise settling when every check has run and teardown finished.
 */
async function main() {
	console.log("term-dictionary host route tests\n");

	const dir = mkdtempSync(join(tmpdir(), "term-dict-host-"));
	const dataDir = join(dir, "data");
	let host = null;
	// The harness owns the server, so it is started inside a check rather than in
	// this scope; `startHost` is awaited by the first check that needs it.
	host = await startHost({ dataDir });

	//#region checks

	test("host: the plugin registers exactly one route prefix", () => {
		assertEqual(host.routes.length, 1, `expected one route, got ${host.routes.length}`);
		assertEqual(host.routes[0].kind, "prefix", "the route is a prefix so every sub-path reaches one handler");
		assertEqual(host.routes[0].path, "/dsh-term-dictionary", "the route prefix the browser client uses");
	});

	test("host: GET /state answers an empty document before anything is recorded", async () => {
		const answer = await get(`${host.url}/dsh-term-dictionary/state`);
		assertEqual(answer.status, 200, "status");
		assertEqual(answer.body.schemaVersion, 1, "schema version");
		assertEqual(answer.body.entries, [], "an empty dictionary");
		assertEqual(answer.body.location.writable, true, "the host reports its data directory as writable");
		assertEqual(answer.body.location.model, false, "no model is mounted in this harness");
	});

	test("host: POST record creates an entry and reports it as created", async () => {
		const answer = await post(`${host.url}/dsh-term-dictionary/entries`, { action: "record", term: "Event Sourcing" });
		assertEqual(answer.status, 200, "status");
		assertEqual(answer.body.created, true, "the first sighting creates");
		assertEqual(answer.body.entry.term, "Event Sourcing", "the term is preserved as typed");
		assertEqual(answer.body.entry.key, "event sourcing", "the key is normalized");
	});

	test("host: a second sighting merges instead of duplicating", async () => {
		const answer = await post(`${host.url}/dsh-term-dictionary/entries`, { action: "record", term: "event sourcing" });
		assertEqual(answer.body.created, false, "the second sighting merges");
		const state = await get(`${host.url}/dsh-term-dictionary/state`);
		assertEqual(state.body.entries.length, 1, "still one entry");
		assertEqual(state.body.entries[0].seen, 2, "the sighting counter moved");
	});

	test("host: a glossary supplied with a sighting becomes the definition", async () => {
		await post(`${host.url}/dsh-term-dictionary/entries`, {
			action: "record",
			term: "quorum",
			glossary: { zh: "法定人数", gloss: "多数派确认后才能提交。", domain: "系统" }
		});
		const state = await get(`${host.url}/dsh-term-dictionary/state`);
		const entry = state.body.entries.find((candidate) => candidate.key === "quorum");
		assert(entry !== undefined, "the entry exists");
		assertEqual(entry.definition.gloss, "多数派确认后才能提交。", "the glossary gloss is stored");
		assertEqual(entry.domain, "系统", "the domain is stored");
	});

	test("host: an update marks the entry as the user's own", async () => {
		const answer = await post(`${host.url}/dsh-term-dictionary/entries`, {
			action: "update",
			term: "quorum",
			definition: { zh: "法定人数", gloss: "我自己写的解释。" }
		});
		assertEqual(answer.status, 200, "status");
		assertEqual(answer.body.entry.source, "user", "the source records a user edit");
		assertEqual(answer.body.entry.definition.gloss, "我自己写的解释。", "the user text wins");
	});

	test("host: a later automatic sighting does not overwrite the user's text", async () => {
		await post(`${host.url}/dsh-term-dictionary/entries`, {
			action: "record",
			term: "quorum",
			glossary: { gloss: "内置解释。" }
		});
		const state = await get(`${host.url}/dsh-term-dictionary/state`);
		const entry = state.body.entries.find((candidate) => candidate.key === "quorum");
		assertEqual(entry.definition.gloss, "我自己写的解释。", "the curated definition survives");
	});
	test("host: POST replace merges the page's whole document", async () => {
		const answer = await post(`${host.url}/dsh-term-dictionary/entries`, {
			action: "replace",
			state: {
				schemaVersion: 1,
				entries: [
					{ term: "sharding", definition: { gloss: "分片。" }, source: "user" },
					{ term: "quorum", definition: { gloss: "来自页面的解释。" }, source: "heuristic" }
				]
			}
		});
		assertEqual(answer.status, 200, "status");
		const keys = answer.body.entries.map((entry) => entry.key).sort();
		assertEqual(keys, ["event sourcing", "quorum", "sharding"], "the page's new entry merged in and nothing was lost");
		const quorum = answer.body.entries.find((entry) => entry.key === "quorum");
		assertEqual(quorum.definition.gloss, "我自己写的解释。", "the stronger stored definition still wins");
	});

	test("host: POST remove deletes by id and the deletion sticks", async () => {
		const state = await get(`${host.url}/dsh-term-dictionary/state`);
		const target = state.body.entries.find((entry) => entry.key === "sharding");
		const answer = await post(`${host.url}/dsh-term-dictionary/entries`, { action: "remove", id: target.id });
		assertEqual(answer.body.removed, true, "the removal is reported");
		const after = await get(`${host.url}/dsh-term-dictionary/state`);
		assertEqual(after.body.entries.some((entry) => entry.key === "sharding"), false, "the entry is gone from the document");
		// The tombstone must survive a later merge that carries the stale live copy,
		// or a page that still had the entry would resurrect it.
		const stale = await post(`${host.url}/dsh-term-dictionary/entries`, {
			action: "replace",
			state: { schemaVersion: 1, entries: [{ term: "sharding", definition: { gloss: "旧副本。" }, updatedAt: 1 }] }
		});
		assertEqual(stale.status, 200, "the replace is accepted");
		assertEqual(
			stale.body.entries.some((entry) => entry.key === "sharding"),
			false,
			"a stale live copy must not resurrect the deleted entry"
		);
	});

	test("host: POST /explain reports that no model is mounted", async () => {
		const answer = await post(`${host.url}/dsh-term-dictionary/explain`, { term: "quorum" });
		assertEqual(answer.status, 503, "status");
		assert(String(answer.body.error).includes("model"), `the error must mention the model, got ${JSON.stringify(answer.body.error)}`);
	});

	test("host: a wrong method and an unknown action are refused", async () => {
		const wrongMethod = await fetch(`${host.url}/dsh-term-dictionary/state`, { method: "POST" });
		assertEqual(wrongMethod.status, 405, "POST /state is refused");
		const unknown = await post(`${host.url}/dsh-term-dictionary/entries`, { action: "nonsense" });
		assertEqual(unknown.status, 400, "an unknown action is refused");
		const missingTerm = await post(`${host.url}/dsh-term-dictionary/entries`, { action: "record" });
		assertEqual(missingTerm.status, 400, "a missing term is refused");
	});

	test("host: a route outside the prefix is not claimed", async () => {
		const response = await fetch(`${host.url}/dsh-term-dictionary-other/state`);
		assertEqual(response.status, 404, "a lookalike prefix is not matched");
	});

	test("host: the dictionary survives a fresh host process over the same file", async () => {
		const before = await get(`${host.url}/dsh-term-dictionary/state`);
		assert(before.body.entries.length > 0, "there is something to persist");
		await host.close();
		host = await startHost({ dataDir });
		const after = await get(`${host.url}/dsh-term-dictionary/state`);
		assertEqual(after.body.entries.length, before.body.entries.length, "every live entry was reloaded");
		assertEqual(
			after.body.entries.map((entry) => entry.key).sort(),
			before.body.entries.map((entry) => entry.key).sort(),
			"the same terms came back"
		);
		// A deletion made before the restart must still hold after it.
		assertEqual(
			after.body.entries.some((entry) => entry.key === "sharding"),
			false,
			"a term deleted before the restart must not come back"
		);
		assert(existsSync(join(dataDir, "dictionary.json")), "the file exists on disk");
	});

	test("host: the file on disk is the documented shape", async () => {
		await host.close();
		const written = JSON.parse(readFileSync(join(dataDir, "dictionary.json"), "utf8"));
		assertEqual(written.schemaVersion, 1, "schema version");
		assert(Array.isArray(written.entries), "entries is an array");
		for (const entry of written.entries) {
			assert(typeof entry.term === "string" && entry.term !== "", `every entry has a term: ${JSON.stringify(entry)}`);
			assert(typeof entry.key === "string" && entry.key === entry.term.trim().toLowerCase(), `every entry has a normalized key: ${JSON.stringify(entry.key)}`);
			assert(entry.definition !== null && typeof entry.definition === "object", "every entry has a definition object");
		}
	});

	test("host + store: deletion and clear survive the real round trip", async () => {
		// The two halves together, over real HTTP: a page store, the real API client,
		// a real host and a real file. This is the level at which the resurrection
		// bugs lived — each side was individually correct.
		//
		// It owns its own host rather than reusing the shared one: earlier checks
		// restart that host, and a check whose subject is a `let` another check
		// reassigns is a check that passes or fails by ordering.
		const { createRequire } = await import("node:module");
		const require_ = createRequire(join(pluginDir, "package.json"));
		const { createDictionaryStore } = require_(join(pluginDir, "lib", "core", "store.js"));
		const { createBrowserStore } = require_(join(pluginDir, "lib", "core", "dictionary.js"));
		const { createApiClient } = require_(join(pluginDir, "lib", "core", "api.js"));

		const ownDir = mkdtempSync(join(tmpdir(), "term-dict-roundtrip-"));
		let live = await startHost({ dataDir: ownDir });
		/** One page: a store wired to the live host, and the memory it persists to. */
		const openPage = () => {
			const memory = new Map();
			const storage = {
				getItem: (key) => (memory.has(key) ? memory.get(key) : null),
				setItem: (key, value) => memory.set(key, String(value)),
				removeItem: (key) => memory.delete(key)
			};
			const api = createApiClient({ base: live.url });
			return {
				store: createDictionaryStore({
					local: createBrowserStore(storage, { warn: () => {} }),
					remote: { load: () => api.load(), save: (state) => api.save(state) },
					logger: { warn: () => {} }
				}),
				api
			};
		};
		const hostView = async () => {
			const response = await get(`${live.url}/dsh-term-dictionary/state`);
			return response.body.entries.map((entry) => entry.key).sort();
		};

		try {
			// One window creates two entries and they reach both sides.
			const page = openPage();
			await page.store.hydrate();
			await page.store.saveEntry("alpha", { definition: { gloss: "第一。" } });
			await page.store.saveEntry("beta", { definition: { gloss: "第二。" } });
			await page.store.retrySync();
			assertEqual(await hostView(), ["alpha", "beta"], "both entries reach the host");

			// Delete one. The host must lose it and a reload must not bring it back.
			await page.store.deleteEntry("alpha");
			// The tombstone must travel WITHOUT the transient edit marker. When it rode
			// along, the next round trip read the user's own deletion as a request to
			// restore the term, so the deletion undid itself on the way to the host.
			const deletion = post(`${live.url}/dsh-term-dictionary/entries`, { action: "replace", state: page.store.getState() });
			await deletion;
			await page.store.retrySync();
			assertEqual(await hostView(), ["beta"], "the deleted entry leaves the host");
			const reloaded = openPage();
			await reloaded.store.hydrate();
			assertEqual(reloaded.store.list("", "all").map((entry) => entry.term).sort(), ["beta"], "a reload does not resurrect it");
			const onWire = JSON.parse(readFileSync(join(ownDir, "dictionary.json"), "utf8"));
			assert(
				(onWire.backing ?? []).every((entry) => entry.edited === undefined && entry.observed === undefined),
				`no tombstone on disk may carry a transient marker: ${JSON.stringify(onWire.backing ?? [])}`
			);

			// A second window that never held the tombstone must not bring it back either.
			const second = openPage();
			await second.store.hydrate();
			await second.store.noteSighting({ term: "alpha" });
			await second.store.retrySync();
			assertEqual(await hostView(), ["beta"], "a re-sighting in a second window does not resurrect it");

			// THE STEP THIS CHECK USED TO MISS, and the plugin's central promise: the user
			// re-curates a term the host still holds as deleted. If this fails, the editor
			// accepts text and the next sync silently deletes it again.
			await second.store.saveEntry("alpha", { definition: { gloss: "重新整理过了。" } });
			await second.store.retrySync();
			assertEqual(await hostView(), ["alpha", "beta"], "a re-curation reaches the host");
			const reRead = openPage();
			await reRead.store.hydrate();
			const curated = reRead.store.find("alpha");
			assert(curated !== undefined, "the re-curated term is live after a reload");
			assertEqual(curated.definition.gloss, "重新整理过了。", "and the text the user typed is the text that survived");
			// And it stays curated through one more full round trip, which is where the
			// tombstone would win if the revival were not strictly newer than it.
			await reRead.store.retrySync();
			await reRead.store.retrySync();
			assertEqual((await hostView()).includes("alpha"), true, "and it is still curated after further syncs");
			for (const session of [reRead]) session.store.dispose();

			// The clock-skew form of the same promise is covered in the unit suite ("a
			// re-curation survives the clock") because it needs two clocks that disagree,
			// and this host stamps with the real one: a page whose clock is an hour behind
			// would be merged against real timestamps and never see the skew. What this
			// level adds is the part a unit test cannot: the revival travelling to the
			// host, and a THIRD client reading it back.

			// Clear everything. This is the bulk path that used to return immediately.
			await second.store.clearAll();
			await second.store.retrySync();
			assertEqual(await hostView(), [], "clearing removes every entry from the host");
			const afterClear = openPage();
			await afterClear.store.hydrate();
			assertEqual(afterClear.store.list("", "all").length, 0, "a reload after a clear stays empty");

			// The file agrees, both about the entries and about the tombstones.
			await live.close();
			const written = JSON.parse(readFileSync(join(ownDir, "dictionary.json"), "utf8"));
			assertEqual(written.entries, [], "no live entry is left on disk");
			assert((written.backing ?? []).length >= 2, `the deletions are recorded on disk, got ${JSON.stringify(written.backing ?? [])}`);
			// A fresh host over the same file still sees an empty dictionary.
			live = await startHost({ dataDir: ownDir });
			assertEqual(await hostView(), [], "the reloaded host still has no live entries");

			for (const session of [page, reloaded, second, afterClear]) session.store.dispose();		} finally {
			try {
				await live.close();
			} catch {
				/* already closed */
			}
			rmSync(ownDir, { recursive: true, force: true });
		}
	});

	//#endregion

	//#region the host's own feedback channel

	// The channel is a HOST service reached through an optional child context, not a client remote: a
	// live desktop profile was measured with no `remote` service at all, so declaring the client-side
	// projection would have parked the whole plugin waiting for a service that never arrives.
	test("feedback: a composition without the channel says so instead of failing", async () => {
		const host = await startHost({ dataDir: dir });
		try {
			const answer = await post(`${host.url}/dsh-term-dictionary/feedback`, { sessionId: "s-1", text: "一条备注" });
			assertEqual(answer.status, 200, "a missing channel is a normal answer, not an HTTP error");
			assertEqual(answer.body, { ok: false, error: "unavailable" }, "and it names the state the page shows");
		} finally {
			await host.close();
		}
	});

	test("feedback: a remark reaches the host channel as the host declares it", async () => {
		const seen = [];
		const host = await startHost({
			dataDir: dir,
			services: { sessionFeedback: { record: async (request) => { seen.push(request); return { ok: true, value: { recorded: true } }; } } }
		});
		try {
			const answer = await post(`${host.url}/dsh-term-dictionary/feedback`, { sessionId: "s-1", text: "术语词典: 1 — Quorum(解释不对)", category: "product-interaction" });
			assertEqual(answer.status, 200, "the route answers");
			assertEqual(answer.body, { ok: true }, "and reports the remark as recorded");
			assertEqual(seen.length, 1, "the host saw exactly one remark");
			assertEqual(seen[0], { sessionId: "s-1", text: "术语词典: 1 — Quorum(解释不对)", category: "product-interaction" }, "with the request shape the host declares");
		} finally {
			await host.close();
		}
	});

	test("feedback: the route validates the session id, the category and the length", async () => {
		const seen = [];
		const host = await startHost({
			dataDir: dir,
			services: { sessionFeedback: { record: async (request) => { seen.push(request); return { ok: true, value: { recorded: true } }; } } }
		});
		try {
			// A remark is about a session: without one there is nothing to record it against.
			const noSession = await post(`${host.url}/dsh-term-dictionary/feedback`, { text: "没有会话" });
			assertEqual([noSession.status, seen.length], [400, 0], "a missing session id is refused before the host is bothered");
			// The category is a closed set on the host's side too, so an unknown id must not be passed on.
			const unknown = await post(`${host.url}/dsh-term-dictionary/feedback`, { sessionId: "s-1", text: "x", category: "made-up" });
			assertEqual(unknown.status, 200, "an unknown category is not an error");
			assertEqual(seen[seen.length - 1].category, "product-interaction", "it falls back to the one a dictionary remark belongs to");
			// And a runaway text cannot fill the host's session log.
			await post(`${host.url}/dsh-term-dictionary/feedback`, { sessionId: "s-1", text: "y".repeat(900) });
			assertEqual(seen[seen.length - 1].text.length, 500, "the text is capped at what a remark is");
		} finally {
			await host.close();
		}
	});

	test("feedback: a session the host no longer has is reported as such", async () => {
		const host = await startHost({
			dataDir: dir,
			services: {
				sessionFeedback: {
					record: async (request) => ({ ok: false, error: { code: "session-not-found", sessionId: request.sessionId } })
				}
			}
		});
		try {
			const answer = await post(`${host.url}/dsh-term-dictionary/feedback`, { sessionId: "gone", text: "x" });
			assertEqual([answer.status, answer.body], [200, { ok: false, error: "session-not-found" }], "the one failure worth naming is named");
		} finally {
			await host.close();
		}
		// And a channel that throws is reported as a refusal rather than taking the route down.
		const broken = await startHost({ dataDir: dir, services: { sessionFeedback: { record: async () => { throw new Error("channel is broken"); } } } });
		try {
			const answer = await post(`${broken.url}/dsh-term-dictionary/feedback`, { sessionId: "s-1", text: "x" });
			assertEqual(answer.status, 502, "a throwing channel is a 502");
			assert(String(answer.body?.error ?? "").includes("broken"), "and its own message is passed on rather than swallowed");
		} finally {
			await broken.close();
		}
	});

	//#endregion

	await runChecks();

	try {
		await host.close();
	} catch {
		/* a check already closed it */
	}
	rmSync(dir, { recursive: true, force: true });

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

await main();
