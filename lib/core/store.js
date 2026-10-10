"use strict";

/**
 * The page's view of the dictionary: one subscribable state object plus every
 * mutation the UI performs.
 *
 * All state flows through this class so the panel, the popup and the detector
 * always read the same generation. It is intentionally React-free: the bundle
 * converts {@link DictionaryStore#getSnapshot} into hook state with `useSyncExternalStore`,
 * which is what lets a mutation made by the transcript interaction surface
 * re-render the sidebar panel.
 *
 * Persistence is layered rather than duplicated. The local store is written
 * first and always, so an edit survives a reload even with no host; the remote
 * store is written afterwards and a failure is recorded as a sync error instead
 * of losing the edit.
 */

const entriesModule = require("./entries.js");
const dictionary = require("./dictionary.js");

const { isUnexplained } = entriesModule;
const { emptyState, editEntry, recordSighting, removeEntry, clearAll, listEntries, summarize, mergeState, seal } = dictionary;

/** Longest context the store keeps per entry. */
const MAX_CONTEXT_CHARS = entriesModule.MAX_CONTEXT_CHARS;

/**
 * @param options - `local` and `remote` stores, each with `load`/`save` (the
 *   remote one may be null), `now` for tests, and `logger`.
 */
function createDictionaryStore(options) {
	const local = options.local;
	const remote = options.remote ?? null;
	const now = typeof options.now === "function" ? options.now : () => Date.now();
	const logger = options.logger;

	/** What the host reported about itself: data directory, writability, model. */
	let hostInfo = null;
	let state = emptyState({ now: now() });
	// The first projection runs before the initial hydration read, so it must be
	// safe to build with no host information yet.
	let view = buildView();
	let status = "loading";
	let syncError = "";
	const listeners = new Set();

	/** The derived, render-ready projection of the document. */
	function buildView() {
		return {
			state,
			stats: summarize(state),
			list: state.entries,
			hostInfo
		};
	}

	/** Publish the current generation to subscribers. */
	function emit() {
		view = buildView();
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (error) {
				logger?.warn?.(`term-dictionary: subscriber failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/** Swap in a new document, persist it locally, and notify. */
	function commit(next, options) {
		state = next;
		emit();
		const writing = options?.persist === false ? Promise.resolve() : local.save(state);
		return Promise.resolve(writing).then(() => {
			if (options?.sync !== false) queueRemoteSync();
		});
	}

	let syncTimer = null;

	/**
	 * Push the whole document to the host shortly after the last mutation.
	 *
	 * One debounced full push beats one request per keystroke: the document is
	 * small, the host merges by term, and a burst of edits costs one round trip.
	 */
	function queueRemoteSync() {
		if (remote === null) return;
		if (syncTimer !== null) clearTimeout(syncTimer);
		syncTimer = setTimeout(() => {
			syncTimer = null;
			flushRemote();
		}, 400);
	}

	/**
	 * Send the current document to the host and adopt the answer.
	 *
	 * The host merges by term and tombstones, so its answer is the converged
	 * document; adopting it is what keeps the two sides identical and lets the
	 * host's copy of a deletion survive the page's next write.
	 */
	function flushRemote() {
		if (remote === null) return Promise.resolve();
		return Promise.resolve(remote.save(state)).then(
			(answer) => {
				if (answer !== undefined && answer !== null && answer.ok === false) {
					syncError = typeof answer.error === "string" && answer.error !== "" ? answer.error : "host rejected the dictionary";
				} else {
					syncError = "";
					if (answer !== null && answer !== undefined && answer.state !== undefined) {
						// The answer is sealed, so merging it would drop the host's
						// tombstones; `mergeState` re-derives them from the document it
						// receives plus the ones this side already holds.
						const adopted = mergeState(state, answer.state, { now: now() });
						// Only a real change is worth a repaint, and only a real change may
						// loop back into another sync.
						if (JSON.stringify(adopted.entries) !== JSON.stringify(state.entries) || adopted.deletedKeys.length !== state.deletedKeys.length) {
							state = adopted;
							void local.save(state);
						}
					}
				}
				emit();
			},
			(error) => {
				syncError = error instanceof Error ? error.message : String(error);
				emit();
			}
		);
	}

	return {
		/** Subscribe to any change. @returns the unsubscribe function. */
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** The cached projection; stable between mutations. @returns the view. */
		getSnapshot() {
			return view;
		},
		/** Lifecycle status for the panel header. @returns `loading`, `ready` or `error`. */
		getStatus() {
			return status;
		},
		/** The last host sync failure, or an empty string. @returns the message. */
		getSyncError() {
			return syncError;
		},
		/** The raw document, for the detector and the export action. @returns the document. */
		getState() {
			return state;
		},

		/**
		 * Load local state, then adopt the host's document when it is reachable and
		 * newer. A host that has never seen this profile returns nothing, and the
		 * local document survives untouched.
		 * @returns a promise settling when hydration finishes.
		 */
		async hydrate() {
			status = "loading";
			emit();
			try {
				state = local.load();
			} catch (error) {
				logger?.warn?.(`term-dictionary: local load failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (remote !== null) {
				try {
					const answer = await remote.load();
					if (answer !== null && answer !== undefined && answer.ok === true && answer.state !== undefined) {
						state = mergeState(state, answer.state, { now: now() });
						hostInfo = answer.state.location ?? null;
						await local.save(state);
						syncError = "";
					} else if (answer !== null && answer !== undefined && answer.ok === false) {
						syncError = typeof answer.error === "string" && answer.error !== "" ? answer.error : "host read failed";
					}
				} catch (error) {
					syncError = error instanceof Error ? error.message : String(error);
				}
			}
			status = "ready";
			emit();
			if (remote !== null && syncError === "") queueRemoteSync();
		},

		/**
		 * Create or update an entry from an explicit user action. The user's text is
		 * authoritative, so this always records `source: "user"`.
		 * @param term - the term being explained.
		 * @param patch - `definition`, `domain`, `aliases`, `pinned`.
		 * @returns a promise resolving to the stored entry.
		 */
		async saveEntry(term, patch) {
			const result = editEntry(state, term, patch, { now: now() });
			await commit(result.state);
			return result.entry;
		},

		/**
		 * Record that a term appeared in a message, without overwriting a definition
		 * the user wrote.
		 *
		 * `deleted` is passed through because the caller needs it: a sighting of a term
		 * the user deleted is refused, and the collector must not announce it as newly
		 * collected. Dropping the flag here made the refusal invisible to the UI.
		 *
		 * @param sighting - `term`, `context`, `sessionId`, optional glossary fields.
		 * @returns a promise resolving to what happened, including `deleted`.
		 */
		async noteSighting(sighting) {
			const result = recordSighting(
				state,
				{ ...sighting, context: typeof sighting.context === "string" ? sighting.context.slice(0, MAX_CONTEXT_CHARS) : "" },
				{ now: now() }
			);
			if (!result.changed) return { created: false, deleted: result.deleted === true, entry: result.entry ?? null };
			await commit(result.state);
			return { created: result.created, deleted: result.deleted === true, entry: result.entry };
		},

		/**
		 * Delete one entry.
		 * @param idOrTerm - the entry id, or its term.
		 * @returns a promise resolving to whether anything was deleted.
		 */
		async deleteEntry(idOrTerm) {
			const result = removeEntry(state, idOrTerm, { now: now() });
			if (result.removed) await commit(result.state);
			return result.removed;
		},

		/**
		 * Delete several entries, committing once.
		 *
		 * The panel's batch delete must not commit per row: every commit persists the
		 * whole document and pushes it to the host, so deleting twenty rows one call at a
		 * time would mean twenty full round trips and twenty merges. Each removal still
		 * leaves its own tombstone — that is what stops a union merge from restoring the
		 * rows from the host's copy — but the document is written once.
		 *
		 * @param idOrTerms - the entry ids, terms or aliases to remove.
		 * @returns a promise resolving to how many were actually removed.
		 */
		async deleteEntries(idOrTerms) {
			const list = Array.isArray(idOrTerms) ? idOrTerms : [];
			let next = state;
			let removed = 0;
			for (const key of list) {
				// Each removal needs the document the previous one produced: the tombstones
				// accumulate, and a removal reads the record it is about to kill.
				const result = removeEntry(next, key, { now: now() });
				if (!result.removed) continue;
				next = result.state;
				removed++;
			}
			if (removed > 0) await commit(next);
			return removed;
		},

		/**
		 * Toggle an entry's pinned flag.
		 * @param idOrTerm - the entry id, or its term.
		 * @returns a promise resolving to the updated entry.
		 */
		async togglePinned(idOrTerm) {
			const found = dictionary.findEntry(state, idOrTerm);
			if (found === undefined) return null;
			return this.saveEntry(found.term, { definition: found.definition, domain: found.domain, aliases: found.aliases, pinned: !found.pinned });
		},

		/**
		 * Forget every entry. The user asked for it explicitly, so no confirmation
		 * lives here; the panel owns that.
		 *
		 * Each removed entry leaves a tombstone, exactly like a single deletion: a
		 * bare empty document would be merged back together with the host's copy and
		 * the whole dictionary would return.
		 *
		 * @returns a promise settling when the clear is persisted.
		 */
		async clearAll() {
			const result = clearAll(state, { now: now() });
			await commit(result.state);
			return result.removed;
		},

		/**
		 * Bring a deleted entry back, as an explicit user action.
		 *
		 * The one-click counterpart to {@link DictionaryStore#deleteEntry}: retracting a deletion is
		 * not an edit, so it carries no patch — the entry comes back as it was, rather than back with
		 * the definition the editor happened to be seeded with. The revival itself is the dictionary's,
		 * where the merge rules it has to satisfy live.
		 *
		 * @param idOrTerm - the entry id, its term, or an alias.
		 * @returns a promise resolving to the revived entry, or null when there was nothing to revive.
		 */
		async reviveEntry(idOrTerm) {
			const result = dictionary.reviveEntry(state, idOrTerm, { now: now() });
			if (result.revived !== true) return null;
			await commit(result.state);
			return result.entry;
		},

		/**
		 * Say something about an entry, or take it back.
		 *
		 * One method for both decisions the panel can make, because they travel together in the UI and
		 * each call persists the whole document: `{ feedback: { kind, note } }` records a remark,
		 * `{ feedback: null }` retracts it, and `{ untrusted: true|false }` is the verdict the automatic
		 * explainer obeys. A field the patch leaves out is left alone, stamp included.
		 *
		 * @param idOrTerm - the entry id, or its term.
		 * @param patch - `feedback` and/or `untrusted`.
		 * @returns a promise resolving to the updated entry, or null when there is no such entry.
		 */
		async markEntry(idOrTerm, patch) {
			const found = dictionary.findEntry(state, idOrTerm);
			if (found === undefined) return null;
			// Through `saveEntry`, so a remark is recorded with the same provenance and the same revival
			// authority as anything else the user asked for.
			return this.saveEntry(found.term, patch);
		},

		/**
		 * The visible list for the panel.
		 * @param query - search text.
		 * @param filter - `all`, `unexplained`, `pinned`, `deleted` or `flagged`.
		 * @param group - the group path to look inside, `""` for the top level.
		 * @returns the ordered entries. For `deleted`, the tombstones.
		 */
		list(query, filter, group) {
			const at = group === undefined || group === null ? "" : String(group);
			// The deleted view is a different LIST rather than a different filter: tombstones live in
			// `backing`, not in `entries`, so no predicate over the live list could ever show one. The group
			// still applies — standing in a folder and asking what was deleted there means that folder.
			if (filter === "deleted") return dictionary.listDeleted(state, query).filter((entry) => (typeof entry.group === "string" ? entry.group : "") === at);
			return listEntries(state, query, filter, at);
		},

		/**
		 * Look one entry up by term text or alias.
		 * @param idOrTerm - the entry id, or its term.
		 * @returns the entry, or null.
		 */
		find(idOrTerm) {
			return dictionary.findEntry(state, idOrTerm) ?? null;
		},

		/** Force an immediate host sync, used by the panel's retry action. */
		retrySync() {
			if (syncTimer !== null) {
				clearTimeout(syncTimer);
				syncTimer = null;
			}
			return flushRemote().then(() => this.hydrate());
		},

		/** Release timers. @returns nothing. */
		dispose() {
			if (syncTimer !== null) clearTimeout(syncTimer);
			syncTimer = null;
			listeners.clear();
		}
	};
}

module.exports = { createDictionaryStore, isUnexplained };
