"use strict";

/**
 * The page's client for the dictionary host API.
 *
 * Every call answers a discriminated result instead of throwing, because a
 * deployment without the Web carrier is a normal state rather than a failure:
 * the store treats "host unavailable" as "use local storage only".
 */

/** Route namespace owned by this plugin; the host registers the same prefix. */
const ROUTE_PREFIX = "/dsh-term-dictionary";

/** How long one host call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 6000;

/**
 * The deadline for a model-backed explanation. The host allows its own model call
 * 45 seconds, so the client must outwait it rather than abort a request that is
 * still making progress.
 */
const EXPLAIN_TIMEOUT_MS = 60_000;

/**
 * Build the client.
 *
 * @param options - `base` overrides the origin (default: the page's own origin,
 *   which is what the Electron shell serves), `timeoutMs` overrides the deadline,
 *   and `fetchImpl` allows tests to inject a transport.
 * @returns `{ load, save, explain, available }`.
 */
function createApiClient(options) {
	const explicitBase = typeof options?.base === "string" ? options.base.replace(/\/$/, "") : "";
	const timeoutMs = typeof options?.timeoutMs === "number" ? options.timeoutMs : REQUEST_TIMEOUT_MS;
	/** The model-backed call gets its own deadline; see {@link createApiClient}. */
	const explainTimeoutMs = typeof options?.explainTimeoutMs === "number" ? options.explainTimeoutMs : EXPLAIN_TIMEOUT_MS;
	const injectFetch = options?.fetchImpl;

	/**
	 * Resolve the transport for one call.
	 * @returns the fetch function and the resolved base URL, or null when the page
	 *   has no fetch at all.
	 */
	function transport() {
		const fetchImpl = injectFetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
		if (fetchImpl === null) return null;
		let base = explicitBase;
		if (base === "" && typeof globalThis.location === "object" && globalThis.location !== null && typeof globalThis.location.origin === "string") {
			base = globalThis.location.origin;
		}
		return { fetchImpl, base };
	}

	/**
	 * Perform one JSON round trip.
	 * @param path - route path below the plugin prefix.
	 * @param init - fetch options; a body is serialized by the caller.
	 * @param deadlineMs - how long this call may take, when it is not the default.
	 * @returns `{ ok: true, value }` or `{ ok: false, error }`; never throws.
	 */
	async function request(path, init, deadlineMs) {
		const resolved = transport();
		if (resolved === null) return { ok: false, error: "no fetch available" };
		const budget = typeof deadlineMs === "number" ? deadlineMs : timeoutMs;
		const controller = typeof AbortController === "function" ? new AbortController() : null;
		const timer = controller === null ? null : setTimeout(() => controller.abort(), budget);
		try {
			const response = await resolved.fetchImpl(`${resolved.base}${ROUTE_PREFIX}${path}`, {
				...init,
				...(controller === null ? {} : { signal: controller.signal }),
				headers: { accept: "application/json", ...(init?.headers ?? {}) }
			});
			if (response === null || typeof response !== "object") return { ok: false, error: "malformed response" };
			const text = typeof response.text === "function" ? await response.text() : "";
			if (response.ok !== true) {
				const detail = parseError(text);
				return { ok: false, error: detail === "" ? `HTTP ${String(response.status)}` : detail };
			}
			if (text.trim() === "") return { ok: true, value: null };
			try {
				return { ok: true, value: JSON.parse(text) };
			} catch (error) {
				return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
			}
		} catch (error) {
			const aborted = error !== null && typeof error === "object" && error.name === "AbortError";
			return { ok: false, error: aborted ? "host request timed out" : error instanceof Error ? error.message : String(error) };
		} finally {
			if (timer !== null) clearTimeout(timer);
		}
	}

	/** Pull a server-provided message out of an error body, if it is JSON. */
	function parseError(text) {
		if (typeof text !== "string" || text.trim() === "") return "";
		try {
			const parsed = JSON.parse(text);
			if (parsed !== null && typeof parsed === "object" && typeof parsed.error === "string") return parsed.error;
		} catch {
			/* a non-JSON error body is reported by status alone */
		}
		return text.slice(0, 160);
	}

	return {
		/** Whether a transport exists at all. @returns true when calls can be attempted. */
		available() {
			return transport() !== null;
		},

		/**
		 * Read the host's document.
		 * @returns `{ ok, state }` on success, `{ ok: false, error }` otherwise.
		 */
		async load() {
			const answer = await request("/state", { method: "GET" });
			if (!answer.ok) return answer;
			const value = answer.value;
			if (value === null || typeof value !== "object" || !Array.isArray(value.entries)) {
				return { ok: false, error: "host returned no dictionary" };
			}
			return { ok: true, state: value };
		},

		/**
		 * Replace the host's document with the page's, which the host merges by
		 * term. Used for every mutation, batched by the store.
		 * @param state - the document to send.
		 * @returns `{ ok }` plus the host's merged document when it answers one.
		 */
		async save(state) {
			const answer = await request("/entries", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "replace", state })
			});
			if (!answer.ok) return answer;
			const value = answer.value;
			if (value !== null && typeof value === "object" && Array.isArray(value.entries)) return { ok: true, state: value };
			return { ok: true };
		},

		/**
		 * Ask the host to explain one term, using the model when it is configured.
		 *
		 * This call gets a much longer deadline than the others: the host waits up to
		 * its own model timeout, and a generation of a few hundred tokens routinely
		 * outlives a short request budget. Aborting it early would look like a
		 * failure to the user even though the host finished and stored the entry.
		 *
		 * @param term - the term to explain.
		 * @param context - the sentence, or paragraph, the term appeared in.
		 * @param options - `lang`, `depth`, and `retry` for a second attempt at an entry whose
		 *   explanation the user rejected.
		 * @returns `{ ok, definition }` or `{ ok: false, error }`.
		 */
		async explain(term, context, options) {
			const answer = await request(
				"/explain",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						term,
						context: typeof context === "string" ? context : "",
						// The host builds the prompt, so the preferences travel with the request
						// instead of being applied here — there is one prompt builder, not two.
						lang: typeof options?.lang === "string" ? options.lang : "auto",
						depth: typeof options?.depth === "string" ? options.depth : "normal",
						// A boolean, never the rejected text: the host adds one fixed sentence, so the
						// user's own words cannot become instructions the model follows.
						retry: options?.retry === true
					})
				},
				explainTimeoutMs
			);
			if (!answer.ok) return answer;
			const value = answer.value;
			if (value === null || typeof value !== "object" || value.definition === null || typeof value.definition !== "object") {
				return { ok: false, error: "host returned no explanation" };
			}
			return { ok: true, definition: value.definition, source: value.source ?? "llm" };
		},

		/**
		 * Record one remark into the host's own session feedback log.
		 *
		 * The host's channel, not this plugin's: the remark lands in THAT machine's session log, never
		 * in a model's context and never on a server. It is the product-level half of feedback — the
		 * content-level half is the report, which only the user can carry out.
		 *
		 * @param input - `sessionId`, `text` and `category`.
		 * @returns `{ ok: true }`, or `{ ok: false, error }` with `unavailable`, `session-not-found`
		 *   or `rejected` — three different things, and the page says them differently.
		 */
		async feedback(input) {
			const answer = await request("/feedback", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId: typeof input?.sessionId === "string" ? input.sessionId : "",
					text: typeof input?.text === "string" ? input.text : "",
					category: typeof input?.category === "string" ? input.category : "product-interaction"
				})
			});
			if (!answer.ok) return answer;
			const value = answer.value;
			if (value !== null && typeof value === "object" && value.ok === true) return { ok: true };
			return { ok: false, error: typeof value?.error === "string" ? value.error : "rejected" };
		}
	};
}

module.exports = { createApiClient, ROUTE_PREFIX, REQUEST_TIMEOUT_MS, EXPLAIN_TIMEOUT_MS };
