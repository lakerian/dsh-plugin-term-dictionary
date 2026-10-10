"use strict";

/**
 * The dictionary document and the operations over it.
 *
 * This file is deliberately free of `node:` and DOM imports: the host half hands
 * it a file system through {@link createFileStore}, and the browser half hands it
 * `localStorage` through {@link createBrowserStore}. The host and the page then
 * apply exactly the same merge rules, which is what keeps an edit made offline in
 * the page from being mangled when it reaches the file.
 */

const entries = require("./entries.js");

const { normalizeEntry, mergeEntry, isUnexplained, isFlagged, normalizeFeedback, matchesQuery } = entries;

/** Current document schema version. */
const SCHEMA_VERSION = 1;

/** Upper bound on stored entries, so an accidental detector loop cannot grow without limit. */
const MAX_ENTRIES = 5000;

/**
 * Freeze a document and keep its tombstones out of `entries`.
 *
 * The invariant this enforces, and the reason it is one function rather than a
 * rule every caller has to remember:
 *
 *  - `entries` holds live entries only. Every reader — the panel, the popup, the
 *    detector, the JSON export, the HTTP response — reads `entries` and therefore
 *    cannot see a deleted term.
 *  - `deletedKeys` names the deleted terms, in one flat array, so the two
 *    questions stay separable: "may I show this?" is answered by `entries`, and
 *    "is this key deleted?" is answered by `deletedKeys`. Merging a deleted term
 *    back into `entries` would answer the second question wrongly.
 *  - `backing` are the tombstones themselves, needed only when a document is
 *    merged with another. Callers never read it; they pass the whole document to
 *    {@link mergeDocuments}, which uses it.
 *
 * @param state - the document to seal, or a bare record list; tombstones or not.
 * @param options - `now` seeds the timestamp when the document has none.
 * @returns the frozen, reader-safe document.
 */
function seal(state, options) {
	// An array is accepted for convenience and means "these are the records"; a
	// document is read through `recordsOf`, which knows where its tombstones live.
	const all = Array.isArray(state) ? state : recordsOf(state);
	// `=== 0` rather than falsy: a record that simply lacks the field is live, matching
	// `normalizeEntry`. Testing `deletedAt === 0` would make such a record neither
	// live nor deleted and drop it silently.
	const live = all.filter((entry) => (entry.deletedAt ?? 0) === 0);
	const dead = all.filter((entry) => (entry.deletedAt ?? 0) > 0);
	const freeze = (entry) => Object.freeze({ ...entry, definition: Object.freeze({ ...entry.definition }) });
	return Object.freeze({
		schemaVersion: SCHEMA_VERSION,
		updatedAt: typeof state?.updatedAt === "number" ? state.updatedAt : options?.now ?? 0,
		entries: Object.freeze(live.map(freeze)),
		deletedKeys: Object.freeze([...new Set(dead.map((entry) => entry.key))]),
		backing: Object.freeze(dead.map(freeze))
	});
}

/**
 * The tombstones a document carries.
 *
 * `backing` is authoritative when it is present: a document that has been sealed
 * once keeps its tombstones there, and `entries` is empty of them. Reading both
 * would count a tombstone twice and duplicate it on every re-seal.
 *
 * @param state - a document, sealed or raw.
 * @returns the deleted markers.
 */
function tombstonesOf(state) {
	if (Array.isArray(state?.backing)) return state.backing;
	return (state?.entries ?? []).filter((entry) => entry.deletedAt > 0);
}

/**
 * Every record a document holds: live entries plus tombstones.
 *
 * Deduplicated by id, because a raw (unsealed) document may hold the same record in
 * both places — that happens when a tombstone is produced and the caller keeps the
 * pre-split list. Without the dedupe a tombstone would be copied twice on the next
 * seal.
 *
 * @param state - a document.
 * @returns the records to persist or merge.
 */
function recordsOf(state) {
	const byId = new Map();
	for (const entry of [...(state?.entries ?? []), ...tombstonesOf(state)]) {
		if (byId.has(entry.id)) continue;
		byId.set(entry.id, entry);
	}
	return [...byId.values()];
}

/**
 * Build a frozen document from a raw record list.
 *
 * The split is done here and handed to {@link seal} as an already-separated
 * document: passing the raw list straight through would make `seal` treat the
 * tombstones as both live records and backing at once, duplicating them.
 *
 * @param records - live entries plus tombstones.
 * @param options - `now` seeds the timestamp.
 * @returns the frozen document.
 */
function sealRecords(records, options) {
	const list = Array.isArray(records) ? records : [];
	// `?? 0` matches `normalizeEntry`: a record that simply lacks `deletedAt` is live.
	// Filtering on `=== 0` dropped such a record from both lists, which silently lost
	// terms whose producer had not set the field.
	return seal(
		{
			updatedAt: options?.now ?? 0,
			entries: list.filter((entry) => (entry.deletedAt ?? 0) === 0),
			backing: list.filter((entry) => (entry.deletedAt ?? 0) > 0)
		},
		options
	);
}

/**
 * An empty document.
 * @param options - `now` seeds the timestamp.
 * @returns a sealed empty state.
 */
function emptyState(options) {
	return seal([], options);
}

/**
 * Normalize an untrusted document, dropping every record that cannot be
 * repaired. Accepts a bare array too, because an early version of the file and a
 * hand-edited file are both plausible.
 *
 * `deletedKeys` is accepted as an input as well as produced: a client that never
 * held a tombstone — a second window, a cleared storage — learns which terms were
 * deleted from the host's answer and can build the markers itself.
 *
 * @param value - parsed JSON from the file, the network or local storage.
 * @param options - `now` seeds timestamps for records missing them.
 * @returns a document carrying its tombstones in `backing`, invisible to readers.
 */
function normalizeState(value, options) {
	const source = Array.isArray(value) ? { entries: value } : value;
	if (source === null || typeof source !== "object") return emptyState(options);
	const now = options?.now ?? Date.now();
	const updatedAt = typeof source.updatedAt === "number" && source.updatedAt > 0 ? source.updatedAt : now;
	// Each record arrives in one of two channels whose names state which they are:
	// `entries` are live and `backing` are tombstones. A record whose own `deletedAt`
	// contradicts the channel it arrived in is malformed, and it is resolved toward the
	// channel rather than toward the record: `backing` is the deletion channel, and
	// honouring a "live" record found there would let a payload smuggle live content
	// past the deletion rules by putting it in the tombstone list.
	const raw = [
		...(Array.isArray(source.entries) ? source.entries : []).map((candidate) => ({ candidate, tombstone: false })),
		...(Array.isArray(source.backing) ? source.backing : []).map((candidate) => ({ candidate, tombstone: true }))
	];
	// A bare key list carries no entry to merge, so a marker is synthesized for it.
	const explicitDeletions = Array.isArray(source.deletedKeys) ? source.deletedKeys.filter((key) => typeof key === "string" && key.trim() !== "") : [];
	const byId = new Map();
	for (const { candidate, tombstone } of raw) {
		const normalized = normalizeEntry(candidate, options);
		if (normalized === null) continue;
		const entry = tombstone && normalized.deletedAt === 0
			? { ...normalized, deletedAt: Math.max(updatedAt, (normalized.updatedAt ?? 0) + 1) }
			: !tombstone && normalized.deletedAt > 0
				? { ...normalized, deletedAt: 0 }
				: normalized;
		const existing = byId.get(entry.id);
		byId.set(entry.id, existing === undefined ? entry : mergeContent(existing, entry, options));
	}
	// A bare key is a deletion whose time is unknown, and it stays that way. Turning
	// it into a tombstone stamped with the current time would invent an edit-ordering
	// fact that nobody supplied, and the merge would then use it to overrule a real
	// edit. The key is carried forward as a key; only a merge turns it into a
	// deletion, and only for a record nobody has curated.
	const records = [...byId.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.term.localeCompare(right.term));
	const sealed = sealRecords(records.slice(0, MAX_ENTRIES), { now: updatedAt });
	return explicitDeletions.length === 0
		? sealed
		: Object.freeze({ ...sealed, deletedKeys: Object.freeze([...new Set([...sealed.deletedKeys, ...explicitDeletions])]) });
}

/**
 * Merge two documents into one, honouring tombstones.
 *
 * This is the only place a deletion is decided. A tombstone from either side wins
 * unless the other side carries a strictly newer edit, which is what makes a
 * deletion survive a round trip through a union merge.
 *
 * @param base - the local document.
 * @param incoming - the document received from the other side.
 * @param options - `now` seeds timestamps, and `deletedKeys` carries the deletion
 *   notices the incoming document announced. They are passed in rather than read
 *   off `incoming` because normalization already resolved a notice against the
 *   concrete record beside it, which is right for a single document but would lose
 *   the notice here, where both signals have to be weighed.
 * @returns the merged document, its tombstones in `backing`.
 */
function mergeDocuments(base, incoming, options) {
	const records = new Map();
	for (const entry of recordsOf(base)) records.set(entry.id, entry);
	// Notices are collected first, then the union is computed, and only then is the
	// deletion decided — once per term. Applying a notice before the merge (and
	// overwriting whatever was there) is what made the result order-dependent: a
	// notice arriving with an older stamp than a live record would destroy that
	// record instead of losing to it.
	const notices = collectNotices(base, incoming, options);
	// `incomingRecords` carries the `observed` marker, which normalization strips
	// because it describes how an arrival is used rather than what is stored; the
	// notices still come from the normalized document.
	const arriving = Array.isArray(options?.incomingRecords) ? options.incomingRecords : recordsOf(incoming);
	// The newest time the USER asked for each term, gathered from the two records each
	// merge actually compared. It cannot be read off the merged record: the record's
	// `updatedAt` follows the content that won, so a user's prompt for an explanation —
	// which is a genuine request to revive — would be discarded along with the
	// explanation when the existing definition outranked it.
	const craftedAt = new Map();
	const remember = (record) => {
		if (record === undefined || record === null) return;
		const newest = craftedTimeOf([record]);
		if (newest > 0) craftedAt.set(record.id, Math.max(craftedAt.get(record.id) ?? 0, newest));
	};
	for (const entry of arriving) {
		const existing = records.get(entry.id);
		if (existing === undefined) {
			records.set(entry.id, entry);
			remember(entry);
			continue;
		}
		// The document-level notice is passed through: the two records alone cannot
		// express a deletion that lives in `backing`/`deletedKeys` but not on either of
		// them, and deciding without it left the term live again.
		const combined = mergeContent(existing, entry, { ...options, notice: notices.get(entry.id) });
		records.set(entry.id, combined);
		remember(existing);
		remember(entry);
	}
	for (const entry of records.values()) remember(entry);
	// The union is complete, so the one deletion decision runs once per term.
	const decided = [...records.values()].map((entry) =>
		mergeRecords(entry, notices.get(entry.id), { ...options, craftedAt: craftedAt.get(entry.id) ?? 0 })
	);
	const updatedAt = Math.max(base?.updatedAt ?? 0, incoming?.updatedAt ?? 0, options?.now ?? 0);
	return sealRecords(decided, { now: updatedAt });
}

/**
 * Apply the one deletion rule to one record.
 *
 * This is the only place a term is deleted or REVIVED, and it takes three inputs:
 * the merged record, the strongest deletion notice for it, and whether an explicit
 * edit arrived for it. Keeping all three in one decision is what makes the merge
 * order-independent — when two code paths could each decide, one of them decides
 * wrongly, and both times this plugin got it wrong it was exactly that shape.
 *
 * @param record - the merged record, or undefined when the term is unknown.
 * @param notice - `{ deletedAt }` for the deletion, or undefined when there is none.
 * @param options - `now` stamps a deletion whose time is not known.
 * @returns the record with its deletion state settled.
 */
function mergeRecords(record, notice, options) {
	if (record === undefined) return record;
	const now = options?.now ?? Date.now();
	// No notice means nothing in this merge wants the record deleted, so it stays
	// whatever it already was. Returning it untouched is what keeps the two sides
	// order-independent for records nobody is deleting.
	if (notice === undefined) return record;
	// Every branch returns a copy. Mutating the record in place would edit a document
	// the caller still holds — and a merge must never change its own inputs.
	if (notice.deletedAt > 0) {
		// A dated deletion wins unless a CRAFTED record asked for the term strictly after
		// it. Two things are deliberately not the test here:
		//
		//  - `record.deletedAt`, because a record that has just been merged may already
		//    carry the deletion it is supposed to be weighed against. Reading it made the
		//    comparison dead code in exactly the case it exists for.
		//  - the merged record's own `updatedAt`, because content that lost the content
		//    contest does not speak for the term. An automatic copy that arrives later and
		//    is discarded must not hand its timestamp to the text that was kept — that is
		//    how a deletion of the user's own older text got undone by a passing sighting.
		//
		// So the comparison uses the newest time a record the USER asked for carries, and
		// being strictly newer is what revives. Time alone is not intent; provenance is.
		if ((options?.craftedAt ?? 0) > notice.deletedAt) return { ...record, deletedAt: 0 };
		const alreadyDeleted = record.deletedAt ?? 0;
		return { ...record, deletedAt: Math.max(alreadyDeleted, notice.deletedAt) };
	}
	// An undated notice carries no evidence of *when* the deletion happened, so it
	// cannot be weighed against a time. What it can still do is delete a term nobody
	// has curated. Curation means the user wrote something for it; a bare sighting —
	// which is all an automatic entry ever is — does not count, however recent its
	// timestamps are.
	const curated = typeof record.definition?.gloss === "string" && record.definition.gloss !== "";
	return curated ? { ...record } : { ...record, deletedAt: record.deletedAt > 0 ? record.deletedAt : now };
}

/**
 * Combine two records' content and their deletion evidence, leaving the deletion
 * DECISION to {@link mergeRecords}.
 *
 * Content merge and deletion decision are deliberately separate: `mergeDocuments`
 * merges every arriving record through here and then decides all of them once. If
 * this function also decided — as it did until this shape — a revival would be
 * honoured for the single-record write paths and silently overruled for the bulk
 * one, so a saved edit was re-deleted by the next sync.
 *
 * Deletion evidence is carried forward rather than acted on: whichever side holds a
 * tombstone keeps it on the combined record, and the notice passed to
 * {@link mergeRecords} names the later of the two deletion times.
 *
 * @param current - the stored record, or undefined.
 * @param incoming - the candidate record, or undefined.
 * @param options - `now` seeds timestamps.
 * @returns the combined record, or undefined when neither side has one.
 */
function mergeContent(current, incoming, options) {
	if (current === undefined) return incoming;
	if (incoming === undefined) return current;
	// A record that arrives without a provenance of its own cannot be distinguished from
	// an explicit `auto` one by the time it reaches this function — `normalizeEntry` has
	// already defaulted the missing field — so no inheritance happens here. The safe
	// reading is the one that cannot undo a deletion, and the plugin's own clients always
	// send a `source`, so the ambiguity is confined to a hand-written payload.
	const merged = entries.mergeEntry(current, incoming, options);
	// The deletion evidence is the stronger of what the two records carry and the
	// notice the enclosing merge collected. The notice is the one that knows about a
	// deletion recorded in `backing`/`deletedKeys` rather than on a record.
	const notice = options?.notice ?? collectDeletion(current, incoming);
	// The record is presented LIVE (`deletedAt: 0`), so the decision below weighs the
	// deletion instead of short-circuiting on a record that already looks deleted.
	//
	// `updatedAt` is deliberately NOT re-stamped here. Stamping it with the newest time
	// either side supplied let an automatic copy that LOST the content contest hand its
	// timestamp to the user's old text — so the stored content claimed to be newer than a
	// deletion it predated, and the term came back. The time follows the content that won,
	// exactly as `mergeEntry` sets it, and the revival is weighed separately against the
	// newest time a record the user actually asked for carries.
	return mergeRecords({ ...merged, deletedAt: 0 }, notice, { ...options, craftedAt: craftedTimeOf([current, incoming]) });
}

/**
 * The deletion evidence one pair of records carries.
 * @param current - the stored record.
 * @param incoming - the candidate record.
 * @returns `{ deletedAt }` for the later deletion, or undefined when neither is deleted.
 */
function collectDeletion(current, incoming) {
	const currentDeletedAt = current?.deletedAt ?? 0;
	const incomingDeletedAt = incoming?.deletedAt ?? 0;
	const deletedAt = Math.max(currentDeletedAt, incomingDeletedAt);
	return deletedAt > 0 ? { deletedAt } : undefined;
}

/**
 * The newest time a record the user asked for carries, or 0.
 *
 * This is the timestamp a revival is weighed against, and it exists because the merged
 * record's own `updatedAt` describes whichever content won rather than what the user
 * did. Only `user` (typed in the editor) and `llm` (an explanation the user requested)
 * count: `glossary`, `heuristic` and `auto` are the plugin noticing a term by itself,
 * and a detection is never a reason to reverse a deletion.
 *
 * @param records - the records being merged.
 * @returns the newest crafted time, or 0 when none of them is crafted.
 */
function craftedTimeOf(records) {
	let newest = 0;
	for (const record of records) {
		if (record === undefined || record === null) continue;
		if (record.source !== "user" && record.source !== "llm") continue;
		// A TOMBSTONE contributes nothing, whatever it claims about who wrote it. A
		// tombstone's own `updatedAt` is its deletion time in every document this plugin
		// writes, so counting it would let a deletion provide the authority to undo
		// itself — and a hand-written payload with `updatedAt` past `deletedAt` would be a
		// revival request dressed as a deletion.
		if ((record.deletedAt ?? 0) > 0) continue;
		newest = Math.max(newest, record.updatedAt ?? 0);
	}
	return newest;
}

/**
 * Every deletion notice the two sides carry, keyed by the record id it targets.
 *
 * Both a real tombstone (`backing`) and a bare key (`deletedKeys`) are notices. A
 * tombstone knows when the deletion happened; a bare key does not, and that
 * difference is preserved rather than papered over with the merge clock — an
 * undated notice must not look newer than a real edit.
 *
 * @param base - the local document.
 * @param incoming - the document received from the other side.
 * @param options - `deletedKeys` overrides the keys announced by `incoming`.
 * @returns a map of id to `{ deletedAt }`.
 */
function collectNotices(base, incoming, options) {
	const announced = Array.isArray(options?.deletedKeys) ? options.deletedKeys : incoming?.deletedKeys ?? [];
	const notices = new Map();
	/** Keep the later of two deletion times for one id; 0 means "no time known". */
	const remember = (id, deletedAt) => {
		const existing = notices.get(id);
		if (existing === undefined) {
			notices.set(id, { deletedAt });
			return;
		}
		// A dated notice outranks an undated one; between two undated ones nothing
		// changes.
		notices.set(id, { deletedAt: Math.max(existing.deletedAt, deletedAt) });
	};
	for (const entry of tombstonesOf(base)) remember(entry.id, entry.deletedAt);
	for (const entry of tombstonesOf(incoming)) remember(entry.id, entry.deletedAt);
	for (const key of announced) {
		if (typeof key !== "string" || key.trim() === "") continue;
		const normalized = normalizeEntry({ term: key }, options);
		if (normalized === null || notices.has(normalized.id)) continue;
		// A bare key has no time of its own; it borrows the local tombstone's when
		// this side has one, and otherwise stays undated.
		const local = findEntryIncludingDeleted(base, key);
		remember(normalized.id, local !== undefined && local.deletedAt > 0 ? local.deletedAt : 0);
	}
	return notices;
}

/**
 * Serialize a document for storage.
 *
 * Live entries go in `entries`; tombstones go in `backing`, and their keys are
 * also listed in `deletedKeys` so a reader that has no tombstone of its own —
 * another window, a cleared storage — can still learn that a term was deleted.
 *
 * Callers pass a document whose `backing` still holds the tombstones (a store's
 * in-memory document) or a sealed one (the HTTP responses). A sealed document has
 * already moved them to `backing`, so both shapes serialize identically.
 *
 * @param state - a document.
 * @returns a plain object safe to write as JSON.
 */
function serializeState(state) {
	const backing = tombstonesOf(state);
	const deletedKeys = Array.isArray(state.deletedKeys) && state.deletedKeys.length > 0
		? state.deletedKeys
		: [...new Set(backing.map((entry) => entry.key))];
	// A document can carry a tombstone record and a bare-key marker for the same
	// term; the record is the richer one and the marker only exists to fill a gap,
	// so both are published but a term is named once.
	const records = new Map();
	for (const entry of backing) records.set(entry.id, stripTransient(entry));
	return {
		schemaVersion: SCHEMA_VERSION,
		updatedAt: state.updatedAt,
		entries: state.entries.map(stripTransient),
		...(deletedKeys.length === 0 ? {} : { deletedKeys: [...deletedKeys] }),
		...(records.size === 0 ? {} : { backing: [...records.values()] })
	};
}

/**
 * Drop the transient `observed` marker from a record on its way out.
 *
 * `observed` means "this arrival is a sighting, count it once", which describes how
 * a record is being used rather than what is stored: a document that kept it would
 * count one sighting again on every reload.
 *
 * @param entry - the record to publish.
 * @returns the record without its transient field.
 */
function stripTransient(entry) {
	if (entry === null || typeof entry !== "object") return entry;
	if (entry.observed !== true) return entry;
	const { observed, ...rest } = entry;
	void observed;
	return rest;
}

/**
 * Insert or merge one entry.
 *
 * Merging is by normalized term, not by the caller's id, so two spellings of the
 * same term can never become two entries even if a caller invents its own id.
 *
 * @param state - the current document.
 * @param candidate - the entry to store; normalized here.
 * @param options - `now` overrides the update timestamp.
 * @returns the next document plus the stored entry.
 */
function upsertEntry(state, candidate, options) {
	const entry = normalizeEntry(candidate, options);
	if (entry === null) return { state, entry: null, changed: false };
	// Looked up over the document's records, not its live entries: a term whose only
	// record is a tombstone must merge with that tombstone rather than be inserted
	// beside it as a second, live entry.
	const records = recordsOf(state);
	const index = records.findIndex((existing) => existing.id === entry.id || existing.key === entry.key);
	if (index < 0) {
		// A fresh entry is stored as constructed: merging it with itself would
		// double-count the sighting it already records.
		const next = sealRecords([entry, ...records].slice(0, MAX_ENTRIES), { now: options?.now ?? Date.now() });
		return { state: next, entry, changed: true };
	}
	const merged = mergeContent(records[index], entry, options);
	const changed = JSON.stringify(merged) !== JSON.stringify(records[index]);
	const list = [...records];
	list[index] = merged;
	const next = sealRecords(list, { now: options?.now ?? Date.now() });
	return { state: next, entry: merged, changed };
}

/**
 * Apply an explicit user edit to an entry, creating it when absent.
 *
 * The edit is marked as such, which is what authorises it to re-stamp the record's
 * `updatedAt` and therefore to revive a term the user had deleted. A sighting, by
 * contrast, never does either.
 *
 * The patch is `{ definition, domain, aliases, pinned, feedback, untrusted }`. `feedback: null` is how
 * a remark is retracted; a patch that does not mention `feedback`/`untrusted` must leave both their
 * values AND their stamps alone, or an unrelated save would re-decide who said what last.
 *
 * @param state - the current document.
 * @param term - the term being edited.
 * @param patch - the fields to apply.
 * @param options - `now` overrides the update timestamp.
 * @returns the next document plus the stored entry.
 */
function editEntry(state, term, patch, options) {
	const now = options?.now ?? Date.now();
	// The lookup includes tombstones: the user is looking at this term and typing an
	// explanation, so the entry is being edited whether or not it is currently
	// deleted, and the edit is what revives it.
	const existing = findEntryIncludingDeleted(state, term);
	const base = existing ?? {
		term: typeof term === "string" ? term.trim() : "",
		definition: { zh: "", gloss: "", usage: "", notes: "" },
		aliases: [],
		domain: "",
		source: "user",
		confidence: 1,
		createdAt: now,
		seen: 1
	};
	// Reviving a deleted term means the record must read as changed strictly AFTER the
	// deletion, because that is the comparison the merge makes. When the deletion was
	// stamped with a clock running ahead of this machine's, `now` alone is older than
	// the tombstone and the user's text would be thrown away on the next sync — an
	// editor that accepts text and then deletes it. The revival is therefore stamped one
	// millisecond past the deletion it supersedes: the one fact that is certainly true
	// is that this edit happened after the user saw that deletion.
	const tombstoneAt = existing !== undefined && existing.deletedAt > 0 ? existing.deletedAt : 0;
	const stamp = tombstoneAt > 0 ? Math.max(now, tombstoneAt + 1) : now;
	// A pin decision gets its own stamp, and ONLY when the caller states one. `updatedAt`
	// cannot carry it (a pin-only edit changes no definition, and the merge keeps
	// `updatedAt` with the content), so `pinnedAt` is what lets the merge tell a later
	// unpin from an earlier pin. A patch that does not mention `pinned` — a sighting, or
	// an editor save that never touched the toggle — must not move it.
	const pinnedPatch = typeof patch?.pinned === "boolean" ? patch.pinned : null;
	// A remark and a verdict on the explanation are decisions exactly like a pin, and each carries its
	// own stamp for the same reason `pinnedAt` exists: neither changes a definition, so `updatedAt`
	// cannot carry them, and a retraction has to be tellable from silence across a merge.
	//
	// `hasOwnProperty` rather than `!== undefined` for the remark, because `feedback: null` IS the
	// retraction — the two cases a plain undefined check would fuse together are "the user took their
	// remark back" and "this patch says nothing about remarks", and only the first may move the stamp.
	const mentionsFeedback = patch !== null && patch !== undefined && Object.prototype.hasOwnProperty.call(patch, "feedback");
	const feedbackStamp = mentionsFeedback ? Math.max(stamp, (base.feedbackAt ?? 0) + 1) : base.feedbackAt ?? 0;
	const untrustedPatch = typeof patch?.untrusted === "boolean" ? patch.untrusted : null;
	const untrustedStamp = untrustedPatch === null ? base.untrustedAt ?? 0 : Math.max(stamp, (base.untrustedAt ?? 0) + 1);
	// A move is a decision like a pin or a remark, and it is stamped strictly past the last one so that two
	// moves inside the same millisecond still have an order.
	const mentionsGroup = patch !== null && patch !== undefined && Object.prototype.hasOwnProperty.call(patch, "group");
	const groupStamp = mentionsGroup ? Math.max(stamp, (base.groupAt ?? 0) + 1) : base.groupAt ?? 0;
	const candidate = normalizeEntry(
		{
			...base,
			// An explicit edit clears the tombstone: the record is live from here, and the
			// `stamp` above is what keeps it live against the tombstone still on the wire.
			deletedAt: 0,
			aliases: patch?.aliases ?? base.aliases,
			domain: patch?.domain ?? base.domain,
			// `patch.group` may legitimately be `""` — that is how an entry is moved back to the top level —
			// so this reads with `hasOwnProperty` rather than with `??`: a patch that says nothing about the
			// group must leave it, and its stamp, exactly where they were.
			group: mentionsGroup ? patch.group : base.group,
			groupAt: groupStamp,
			definition: { ...base.definition, ...(patch?.definition ?? {}) },
			source: "user",
			confidence: 1,
			pinned: pinnedPatch ?? base.pinned,
			pinnedAt: pinnedPatch === null ? (base.pinnedAt ?? 0) : stamp,
			feedback: mentionsFeedback ? normalizeFeedback(patch.feedback) : base.feedback,
			feedbackAt: feedbackStamp,
			untrusted: untrustedPatch ?? base.untrusted,
			untrustedAt: untrustedStamp,
			updatedAt: stamp,
			lastSeenAt: stamp
		},
		{ now: stamp }
	);
	return upsertEntry(state, { ...candidate, source: "user", deletedAt: 0 }, { now: stamp });
}

/**
 * Record one sighting of a term without replacing its meaning: the counters move
 * and a missing definition is filled from the glossary, but a curated definition
 * survives untouched.
 * @param state - the current document.
 * @param sighting - `term`, optional `glossary`, `context`, `sessionId`.
 * @param options - `now` overrides the timestamp.
 * @returns the next document plus what happened.
 */
function recordSighting(state, sighting, options) {
	const now = options?.now ?? Date.now();
	const term = typeof sighting?.term === "string" ? sighting.term.trim() : "";
	if (term === "") return { state, entry: null, changed: false, created: false };
	// An explicit definition from this sighting — a model's answer, for instance —
	// outranks a glossary gloss, which is only a fallback.
	const supplied = sighting.definition !== null && typeof sighting.definition === "object" && typeof sighting.definition.gloss === "string" && sighting.definition.gloss.trim() !== ""
		? sighting.definition
		: null;
	const fallback = supplied ?? sighting.glossary ?? null;
	// Deliberately the tombstone-aware lookup. This is what makes a re-sighting of a
	// deleted term a no-op instead of a resurrection, and it has to live here rather
	// than in each caller: every collection path — the page's, a second window's, the
	// host's own `record` action — funnels through this function.
	const existing = findEntryIncludingDeleted(state, term);
	// A sighting of a term the user deleted is refused outright and writes nothing. The
	// tombstone is the guard, not a counter, so bumping the counters on a record nobody
	// can see — and re-persisting and re-syncing the document for it on every page load
	// — buys nothing. Returning the state untouched is what makes the refusal honest.
	if (existing !== undefined && existing.deletedAt > 0) {
		return { state, entry: existing, changed: false, created: false, deleted: true };
	}
	if (existing === undefined) {
		const created = entries.createEntry(
			{
				term,
				definition: { gloss: fallback?.gloss ?? "", zh: fallback?.zh ?? "" },
				domain: fallback?.domain ?? "",
				source: supplied !== null ? (sighting.source ?? "llm") : sighting.glossary ? "heuristic" : "auto",
				confidence: sighting.confidence ?? (fallback ? 0.8 : 0.45),
				context: sighting.context ?? "",
				sessionId: sighting.sessionId ?? ""
			},
			fallback ?? undefined,
			{ now }
		);
		const result = upsertEntry(state, created, { now });
		return { ...result, created: true };
	}
	// A sighting is an observation, not an edit. It advances the sighting counters
	// and an empty definition may be filled from the glossary, but the entry's own
	// `updatedAt` is preserved: that is what keeps the revival rule honest, because
	// otherwise the transcript re-observing a term would be "an edit newer than the
	// deletion" on every page load and the user's deletion could never hold.
	//
	// `observed` is what tells the merge to count this once. The stored `seen` is
	// carried through unchanged, so the count is a count of sightings rather than a
	// number that grows every time a document is loaded or merged.
	const bumped = normalizeEntry(
		{ ...existing, observed: true, lastSeenAt: now, updatedAt: existing.updatedAt },
		{ now: Math.max(existing.updatedAt ?? 0, now) }
	);
	const canFill = existing.definition.gloss === "" && fallback !== null && typeof fallback.gloss === "string" && fallback.gloss !== "";
	// An entry the user called untrustworthy is not filled in by a SIGHTING.
	//
	// This is the authoritative half of that rule, and it lives here rather than in the caller because
	// every automatic writer — the page's explain queue, a background refresh, the host's own `record`
	// action — funnels through this function. `overridesUntrusted` is the explicit escape hatch: a
	// generation the user pressed the button for is not the machine deciding on its own.
	const refused = existing.untrusted === true && sighting.overridesUntrusted !== true;
	const filled = canFill && !refused
		? normalizeEntry(
			{
				...bumped,
				definition: { zh: fallback.zh ?? "", gloss: fallback.gloss, usage: fallback.usage ?? "", notes: fallback.notes ?? "" },
				domain: fallback.domain ?? existing.domain,
				source: supplied !== null ? (sighting.source ?? "llm") : "heuristic",
				confidence: Math.max(existing.confidence, supplied !== null ? 0.9 : 0.8)
			},
			{ now: Math.max(existing.updatedAt ?? 0, now) }
		)
		: bumped;
	const result = upsertEntry(state, filled, { now: Math.max(existing.updatedAt ?? 0, now) });
	// A record that came back as a tombstone was a deletion this sighting cannot
	// undo: the caller should treat the term as still deleted rather than as newly
	// created, so the UI does not report having collected it.
	return { ...result, created: false, deleted: (result.entry?.deletedAt ?? 0) > 0 };
}

/**
 * Remove one entry by id or term.
 *
 * The entry is not erased from the document: it becomes a tombstone carrying the
 * deletion time. A union merge can only add, so a deletion that left no trace
 * would be undone the moment the other side's copy was merged back in. The
 * tombstone is filtered out of every projection the reader sees, and the caller
 * receives the same document it would have received from an erase.
 *
 * The deletion time is `max(now, record.updatedAt + 1)`. A deletion must be strictly
 * newer than the content it deletes or the merge will judge that content to have
 * superseded the deletion — and `editEntry` stamps a revival one millisecond past the
 * tombstone it supersedes, so on a client whose clock is behind, a plain `now` would
 * be older than the entry it is trying to delete and the delete button would do
 * nothing.
 *
 * @param state - the current document.
 * @param idOrTerm - the entry id, or its term text.
 * @param options - `now` overrides the deletion timestamp.
 * @returns the next document plus whether anything was removed.
 */
function removeEntry(state, idOrTerm, options) {
	// The by-id lookup here must see tombstones too: deleting an entry that is
	// already deleted is a no-op, not a new deletion notice.
	const target = findEntryIncludingDeleted(state, idOrTerm);
	if (target === undefined) return { state, removed: false, tombstone: null };
	const now = options?.now ?? Date.now();
	// A deletion must be strictly newer than the content it deletes, so the stamp never
	// goes backwards. See this function's note above.
	const deletedAt = Math.max(now, (target.updatedAt ?? 0) + 1);
	// `updatedAt` is set to the deletion time, not to the later of the two: the
	// tombstone must not claim to be newer than it is, or a copy that is merely
	// newer than the deletion would be judged "newer than the tombstone" and revive
	// the entry. An edit and a deletion at the same instant is a deletion.
	const dead = normalizeEntry({ ...target, deletedAt, updatedAt: deletedAt }, { now: deletedAt });
	// Mapped over the document's *records*, not its live entries: the target may
	// itself already be a tombstone, and a fresh list is built so a tombstone is
	// never appended twice.
	const list = recordsOf(state).map((entry) => (entry.id === target.id ? dead : entry));
	// The tombstone rides in `backing`, invisible to readers but available to the
	// next merge — that is what lets the deletion travel to the host and back.
	return { state: sealRecords(list, { now }), tombstone: dead, removed: true };
}

/**
 * Bring a deleted entry back, as the user's own request.
 *
 * Two things make a revival actually stick, and both are rules the merge already had:
 *
 *  - the record must be CRAFTED — `source` of `user` or `llm` — because that is the time
 *    {@link mergeRecords} weighs against a deletion. A term the plugin collected by itself is
 *    collected again by itself, so inheriting `auto` here would produce a revival that vanishes on
 *    the next sync and looks like the button did nothing;
 *  - its time must be **strictly** newer than the deletion it undoes. Everything in this file that
 *    reverses a deletion turns on that comparison, and `+1` rather than `now` alone is what keeps it
 *    true when a tombstone is stamped ahead of the wall clock.
 *
 * The tombstone itself leaves no trace: it is dropped from `backing`, so a later merge cannot weigh
 * it a second time — which is what "retract from the blacklist" has to mean.
 *
 * @param state - the current document.
 * @param idOrTerm - the entry id, its term, or an alias.
 * @param options - `now` overrides the revival timestamp.
 * @returns the next document, whether anything was revived, and the entry.
 */
function reviveEntry(state, idOrTerm, options) {
	const target = findEntryIncludingDeleted(state, idOrTerm);
	if (target === undefined) return { state, revived: false, entry: null };
	if ((target.deletedAt ?? 0) <= 0) return { state, revived: false, entry: target };
	const now = options?.now ?? Date.now();
	const updatedAt = Math.max(now, (target.deletedAt ?? 0) + 1);
	const revived = normalizeEntry({ ...target, deletedAt: 0, updatedAt, source: "user" }, { now: updatedAt });
	// Mapped over the records, like the deletion: the target IS a tombstone here, and a fresh list is
	// what keeps it from being carried into `backing` as well as into `entries`.
	const list = recordsOf(state).map((entry) => (entry.id === target.id ? revived : entry));
	return { state: sealRecords(list, { now: updatedAt }), revived: true, entry: revived };
}

/**
 * Delete every live entry at once, EXCEPT the pinned ones.
 *
 * The bulk path needs the same treatment as the single one: without a tombstone
 * per entry, a union merge restores everything from the other side — and because
 * the page adopts the host's answer, that restoration would be immediate rather
 * than merely on the next reload.
 *
 * Pinning is how a reader says "this one, never mind the noise", so a bulk clear
 * that swept the pinned entries up would delete exactly the ones that had been
 * singled out — the opposite of what a pin is for. They survive, and the count
 * returned is the number actually tombstoned rather than the number of entries
 * that existed, because those are the two numbers a caller reports and only one
 * of them is true.
 *
 * @param state - the current document.
 * @param options - `now` overrides the deletion timestamp.
 * @returns the next document plus how many entries were deleted.
 */
function clearAll(state, options) {
	const now = options?.now ?? Date.now();
	let removed = 0;
	const records = recordsOf(state).map((entry) => {
		if (entry.deletedAt > 0) return entry;
		if (entry.pinned === true) return entry;
		removed++;
		// Same rule as the single deletion: a deletion is strictly newer than what it
		// deletes, so a clock behind the entry's own stamp cannot make it a no-op.
		const deletedAt = Math.max(now, (entry.updatedAt ?? 0) + 1);
		return normalizeEntry({ ...entry, deletedAt, updatedAt: deletedAt }, { now: deletedAt });
	});
	return { state: sealRecords(records, { now }), removed };
}

/**
 * Find one live entry by id, term, or alias.
 *
 * Tombstones are invisible to callers: everything a user can reach — the panel,
 * the popup, the editor, `editEntry`, `removeEntry` — must behave as if a deleted
 * term is simply not there. {@link findEntryIncludingDeleted} is the one lookup
 * that still sees them, for the merge path.
 *
 * @param state - the document.
 * @param idOrTerm - the entry id, or its term text.
 * @returns the entry, or undefined when it is absent or deleted.
 */
function findEntry(state, idOrTerm) {
	const found = findEntryIncludingDeleted(state, idOrTerm);
	return found !== undefined && found.deletedAt === 0 ? found : undefined;
}

/**
 * Find one entry by id, term, or alias, tombstones included.
 * @param state - the document.
 * @param idOrTerm - the entry id, or its term text.
 * @returns the entry, or undefined.
 */
function findEntryIncludingDeleted(state, idOrTerm) {
	if (typeof idOrTerm !== "string" || idOrTerm.trim() === "") return undefined;
	const needle = idOrTerm.trim();
	// Searched over the document's *records*: a sealed document keeps its tombstones
	// in `backing`, so reading `entries` alone would make a deleted term look absent
	// and every merge would treat it as brand new.
	const records = recordsOf(state);
	const byId = records.find((entry) => entry.id === needle);
	if (byId !== undefined) return byId;
	const key = needle.toLowerCase().replace(/\s+/g, " ");
	return records.find(
		(entry) => entry.key === key || entry.aliases.some((alias) => alias.toLowerCase() === key)
	);
}

/**
 * Merge a whole remote document into a local one without losing local edits.
 *
 * Delegates to {@link mergeDocuments}, so tombstones from either side are
 * honoured and the merged document keeps them until it is sealed.
 *
 * @param base - the local document.
 * @param incoming - the document received from the other side.
 * @param options - `now` seeds timestamps.
 * @returns the merged document.
 */
function mergeState(base, incoming, options) {
	// The raw announcements are read before normalization, because normalization
	// resolves a notice against the concrete record beside it — correct for a single
	// document, but it would lose the notice at the one moment the merge needs it.
	const announced = Array.isArray(incoming) ? [] : incoming?.deletedKeys;
	const normalized = normalizeState(incoming, options);
	return mergeDocuments(base, normalized, {
		...options,
		deletedKeys: Array.isArray(announced) ? announced : normalized.deletedKeys,
		// Carries the `observed` marker, which is what counts an arriving sighting once.
		incomingRecords: rawRecordsOf(incoming, options)
	});
}

/**
 * The records an untrusted document carries, normalized but with their transient
 * `observed` marker intact.
 *
 * {@link normalizeState} deliberately drops `observed`, because it describes how a
 * record is being used rather than what is stored. A merge is the one place it
 * matters — it is how a sighting is counted exactly once — so it is restored here.
 *
 * @param value - the document as received.
 * @param options - `now` seeds timestamps.
 * @returns the records to merge.
 */
function rawRecordsOf(value, options) {
	const source = Array.isArray(value) ? { entries: value } : value;
	if (source === null || typeof source !== "object") return [];
	return [
		...(Array.isArray(source.entries) ? source.entries : []),
		...(Array.isArray(source.backing) ? source.backing : [])
	]
		.map((candidate) => {
			const entry = normalizeEntry(candidate, options);
			if (entry === null) return null;
			return candidate?.observed === true ? { ...entry, observed: true } : entry;
		})
		.filter((entry) => entry !== null);
}

/**
 * Counts the panel header shows.
 * @param state - the document.
 * @returns totals by verification state.
 */
function summarize(state) {
	// Filtered defensively: a sealed document has no tombstones, but a document
	// straight out of a merge does, and a deleted term must never be counted.
	const live = state.entries.filter((entry) => entry.deletedAt === 0);
	let explained = 0;
	let pinned = 0;
	for (const entry of live) {
		if (!isUnexplained(entry)) explained++;
		if (entry.pinned) pinned++;
	}
	return { total: live.length, explained, unexplained: live.length - explained, pinned };
}

/**
 * The groups immediately inside one path, with how many entries each holds.
 *
 * Only the immediate children: the list shows one level at a time, and a count covers everything under
 * that child, however deep. A group exists as long as something is in it — there is no separate list of
 * empty groups to keep in step with the entries, which is the trade this makes deliberately.
 *
 * @param entries - every live entry.
 * @param prefix - the path to look inside, `""` for the top level.
 * @returns `[{ group, name, count }]`, alphabetical.
 */
function groupsIn(entries, prefix) {
	const base = prefix === undefined || prefix === null ? "" : String(prefix);
	const counts = new Map();
	for (const entry of Array.isArray(entries) ? entries : []) {
		if ((entry?.deletedAt ?? 0) !== 0) continue;
		const group = typeof entry?.group === "string" ? entry.group : "";
		if (group === "" || group === base) continue;
		let inside = null;
		if (base === "") inside = group;
		else if (group.startsWith(`${base}/`)) inside = group.slice(base.length + 1);
		if (inside === null || inside === "") continue;
		const name = inside.split("/")[0];
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ group: base === "" ? name : `${base}/${name}`, name, count }))
		.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The panel's visible list: one level of the group tree, filtered by query, then ordered by when each
 * term was last seen.
 * @param state - the document.
 * @param query - search text.
 * @param filter - `all`, `unexplained`, `pinned` or `flagged`.
 * @param group - the group path to look inside, `""` for the top level.
 * @returns the ordered entries.
 */
function listEntries(state, query, filter, group) {
	const base = group === undefined || group === null ? "" : String(group);
	const matched = state.entries.filter((entry) => {
		if (entry.deletedAt !== 0) return false;
		// The list shows the level you are standing in, not everything below it: a group is a directory,
		// and what is inside it is what you see after entering it.
		if ((typeof entry.group === "string" ? entry.group : "") !== base) return false;
		if (!matchesQuery(entry, query)) return false;
		if (filter === "unexplained") return isUnexplained(entry);
		if (filter === "pinned") return entry.pinned;
		// "Flagged" gathers both things a user can say about an entry — a remark and a verdict on the
		// explanation — because the panel's one job for them is the same: show what was said, and let
		// it be taken back.
		if (filter === "flagged") return isFlagged(entry);
		return true;
	});
	// Newest term first, and NOTHING ELSE.
	//
	// It used to sort pinned first and unexplained first, and it then sorted by when each term was last
	// SEEN — every one of which moves a row under the reader's hand: pin a term and it jumped to the top,
	// answer a prompt and it jumped, and the transcript merely mentioning a term again shuffled the list.
	// Creation time is the one thing no action changes, so the list is still while the reader reads it.
	// The pin is shown on the row itself and 「已钉选」 gathers the pinned ones, so ordering has no job left.
	return matched.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.term.localeCompare(right.term));
}

/**
 * The panel's list of what the user deleted: the tombstones, newest deletion first.
 *
 * The dictionary is a blacklist as well as a glossary — a term the user struck out is refused by
 * collection and by import — and a blacklist nobody can read is one nobody can correct. This is the
 * read half of that; {@link reviveEntry} is the write half.
 *
 * Sorted by the DELETION time rather than by `lastSeenAt`: the row's own reason for being on this
 * list is when it was struck out, and the newest mistake is the one most likely to be retracted.
 *
 * @param state - the document.
 * @param query - search text.
 * @returns the tombstone records.
 */
function listDeleted(state, query) {
	return tombstonesOf(state)
		.filter((entry) => matchesQuery(entry, query))
		.sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0) || left.term.localeCompare(right.term));
}

//#region storage backends

/**
 * A store backed by one JSON file.
 *
 * Writes are serialized through a promise chain and atomic (write a sibling
 * temporary file, then rename), so a crash mid-write cannot truncate the
 * dictionary and two concurrent edits cannot interleave.
 *
 * @param fileSystem - `{ readFileSync, writeFileSync, renameSync, mkdirSync, existsSync }`.
 * @param filePath - absolute path of the dictionary file.
 * @param logger - optional `{ warn }` sink for read/write failures.
 * @returns a store with `load` and `save`.
 */
function createFileStore(fileSystem, filePath, logger) {
	let queue = Promise.resolve();
	return {
		path: filePath,
		/**
		 * Read the document, returning an empty one when the file is absent or
		 * unreadable. A corrupt file is reported but never fatal: the plugin keeps
		 * working and the next save repairs it.
		 * @returns the loaded document.
		 */
		load() {
			try {
				if (!fileSystem.existsSync(filePath)) return emptyState();
				const text = fileSystem.readFileSync(filePath, "utf8");
				if (typeof text !== "string" || text.trim() === "") return emptyState();
				return normalizeState(JSON.parse(text));
			} catch (error) {
				logger?.warn?.(`term-dictionary: reading ${filePath} failed: ${error instanceof Error ? error.message : String(error)}`);
				return emptyState();
			}
		},
		/**
		 * Persist the document.
		 * @param state - the document to write.
		 * @returns a promise settling when the write lands.
		 */
		save(state) {
			const payload = `${JSON.stringify(serializeState(state), null, 2)}\n`;
			queue = queue.then(() => {
				const temporary = `${filePath}.tmp`;
				fileSystem.mkdirSync(fileSystem.dirname?.(filePath) ?? filePath.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
				fileSystem.writeFileSync(temporary, payload, "utf8");
				fileSystem.renameSync(temporary, filePath);
			});
			return queue.catch((error) => {
				logger?.warn?.(`term-dictionary: writing ${filePath} failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}
	};
}

/** Local-storage key holding the page's copy of the dictionary. */
const STORAGE_KEY = "dsh-plugin-term-dictionary:v1";

/**
 * A store backed by `localStorage`, so the plugin keeps working with no host
 * half, no Web carrier and no network.
 * @param storage - a `Storage`-shaped object; a missing one degrades to memory.
 * @param logger - optional `{ warn }` sink.
 * @returns a store with `load` and `save`.
 */
function createBrowserStore(storage, logger) {
	let memory = emptyState();
	return {
		/**
		 * Read the page's copy.
		 * @returns the loaded document.
		 */
		load() {
			try {
				if (storage === undefined || storage === null) return memory;
				const text = storage.getItem(STORAGE_KEY);
				if (typeof text !== "string" || text.trim() === "") return emptyState();
				return normalizeState(JSON.parse(text));
			} catch (error) {
				logger?.warn?.(`term-dictionary: reading local storage failed: ${error instanceof Error ? error.message : String(error)}`);
				return emptyState();
			}
		},
		/**
		 * Persist the page's copy.
		 * @param state - the document to write.
		 * @returns a promise settling when the write lands.
		 */
		save(state) {
			try {
				if (storage === undefined || storage === null) {
					memory = state;
					return Promise.resolve();
				}
				storage.setItem(STORAGE_KEY, JSON.stringify(serializeState(state)));
			} catch (error) {
				logger?.warn?.(`term-dictionary: writing local storage failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return Promise.resolve();
		}
	};
}

//#endregion

module.exports = {
	SCHEMA_VERSION,
	MAX_ENTRIES,
	STORAGE_KEY,
	emptyState,
	normalizeState,
	serializeState,
	seal,
	sealRecords,
	recordsOf,
	mergeDocuments,
	tombstonesOf,
	upsertEntry,
	editEntry,
	recordSighting,
	removeEntry,
	reviveEntry,
	clearAll,
	findEntry,
	findEntryIncludingDeleted,
	mergeState,
	summarize,
	listEntries,
	groupsIn,
	listDeleted,
	createFileStore,
	createBrowserStore
};
