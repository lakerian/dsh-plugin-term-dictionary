"use strict";

/**
 * The dictionary entry: its shape, its construction, and the rules for merging
 * two versions of it.
 *
 * One entry per normalized term. The entry is the durable record a user curates;
 * everything the detector knows about a word is derived from it or from the
 * built-in glossary, never stored twice.
 */

const core = require("./core.js");

/** Where an entry's definition came from, weakest first. */
const SOURCES = ["auto", "heuristic", "llm", "user", "import"];

/** Human-readable source labels, localized at render time. */
const SOURCE_RANK = {
	auto: 0,
	heuristic: 1,
	llm: 2,
	user: 3,
	import: 1
};

/** Upper bound on one stored definition, so a runaway model cannot bloat the file. */
const MAX_DEFINITION_CHARS = 600;

/** Upper bound on stored context, which is evidence rather than content. */
const MAX_CONTEXT_CHARS = 400;

/** Upper bound on a feedback note, which is a remark rather than an explanation. */
const MAX_NOTE_CHARS = 200;

/**
 * Upper bound on an entry's group path.
 *
 * A path rather than a name: a group can hold groups, because that is what a directory does and what a
 * folder import produces. One string covers any depth, which is why nothing else had to be added to the
 * document to get nesting.
 */
const MAX_GROUP_CHARS = 120;

/**
 * What a user can say is wrong with an entry.
 *
 * A closed set, because the note travels: the feedback report and (later) a shared pack carry these
 * ids, and free-text categories would make them unreadable to whoever receives them. `other` is the
 * escape hatch, and a note is always allowed on top.
 */
const FEEDBACK_KINDS = ["wrong-gloss", "wrong-term", "should-not-collect", "other"];

/**
 * Read one feedback value into the stored shape.
 *
 * An unknown kind becomes `other` rather than refusing the record: a remark whose category this
 * version does not know is still a remark the user made, and dropping it would lose their words to a
 * vocabulary change.
 *
 * @param value - `{ kind, note }`, or null to mean "nothing to say".
 * @returns `{ kind, note }`, or null.
 */
function normalizeFeedback(value) {
	if (value === null || typeof value !== "object") return null;
	return {
		kind: FEEDBACK_KINDS.includes(value.kind) ? value.kind : "other",
		note: clampText(value.note, MAX_NOTE_CHARS)
	};
}

/**
 * Whether the user has said anything about this entry.
 *
 * Two independent facts count: a remark (`feedback`) and a verdict on the explanation
 * (`untrusted`). They are deliberately separate — "here is what is wrong" and "stop treating this as
 * authoritative" are different claims, and the second is what the automatic explainer obeys.
 *
 * @param entry - a normalized entry.
 * @returns true when either is set.
 */
function isFlagged(entry) {
	return entry?.feedback !== null && entry?.feedback !== undefined ? true : entry?.untrusted === true;
}

/**
 * Clamp a string field to a maximum length without cutting mid-surrogate.
 * @param value - the raw value.
 * @param limit - maximum characters to keep.
 * @returns the trimmed, clamped string (empty for non-strings).
 */
function clampText(value, limit) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Normalize an untrusted value into a dictionary entry.
 *
 * Every read path (host file, HTTP body, local storage) goes through this, so a
 * corrupt or older record can never introduce a malformed entry into the store.
 *
 * @param value - a candidate entry as plain data.
 * @param options - `now` overrides the timestamp used for missing fields.
 * @returns a complete entry, or null when the record has no usable term.
 */
function normalizeEntry(value, options) {
	if (value === null || typeof value !== "object") return null;
	const term = typeof value.term === "string" ? value.term.replace(/\s+/g, " ").trim() : "";
	if (term === "") return null;
	const key = core.normalizeTerm(term);
	if (key === "") return null;
	const now = typeof options?.now === "number" ? options.now : Date.now();
	const definition = value.definition !== null && typeof value.definition === "object" ? value.definition : {};
	const seen = typeof value.seen === "number" && Number.isFinite(value.seen) && value.seen > 0 ? Math.floor(value.seen) : 1;
	const aliases = Array.isArray(value.aliases)
		? [...new Set(value.aliases.filter((alias) => typeof alias === "string" && alias.trim() !== "").map((alias) => alias.trim()))].slice(0, 8)
		: [];
	return {
		version: 1,
		id: typeof value.id === "string" && value.id !== "" ? value.id : core.termId(key),
		term,
		key,
		aliases,
		definition: {
			zh: clampText(definition.zh, 60),
			gloss: clampText(definition.gloss, MAX_DEFINITION_CHARS),
			usage: clampText(definition.usage, MAX_DEFINITION_CHARS),
			notes: clampText(definition.notes, MAX_DEFINITION_CHARS)
		},
		domain: clampText(value.domain, 24),
		/**
		 * The group (folder) this entry lives in: `""` for the top level, or a `/`-separated path.
		 *
		 * A CONTAINER, not a topic: `domain` is a semantic label the reader assigns, while this is where
		 * the entry was put. It needs its own stamp (§ `groupAt`) because a move is a decision — the first
		 * attempt let it ride on the content merge, and a merge of one entry from two windows then wiped
		 * the group order-dependently.
		 */
		group: clampText(value.group, MAX_GROUP_CHARS),
		// When the group was last decided, epoch milliseconds, 0 for "never moved".
		//
		// The third use of this pattern, and for the reason the other two exist: a decision the user can
		// make and unmake cannot be carried by content-merging rules.
		// When the user restored this term, epoch milliseconds, 0 for never.
		//
		// The named evidence a merge weighs against a deletion, so a restoration does not have to win a
		// contest over a clock — see `restoreEntry`.
		restoredAt: typeof value.restoredAt === "number" && Number.isFinite(value.restoredAt) && value.restoredAt > 0 ? Math.floor(value.restoredAt) : 0,
		groupAt: typeof value.groupAt === "number" && Number.isFinite(value.groupAt) && value.groupAt > 0 ? Math.floor(value.groupAt) : 0,
		source: SOURCES.includes(value.source) ? value.source : "auto",
		confidence: typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : 0.5,
		createdAt: typeof value.createdAt === "number" && value.createdAt > 0 ? value.createdAt : now,
		updatedAt: typeof value.updatedAt === "number" && value.updatedAt > 0 ? value.updatedAt : now,
		seen,
		lastSeenAt: typeof value.lastSeenAt === "number" && value.lastSeenAt > 0 ? value.lastSeenAt : now,
		context: clampText(value.context, MAX_CONTEXT_CHARS),
		sessionId: typeof value.sessionId === "string" ? clampText(value.sessionId, 80) : "",
		pinned: value.pinned === true,
		// When the pin was last decided, epoch milliseconds, 0 for "never pinned".
		//
		// The boolean needs its OWN clock because `updatedAt` belongs to the definition:
		// the merge advances `updatedAt` only when the arriving content wins, so a
		// pin-only edit carries no timestamp at all — `upsertEntry` merges, sees no
		// definition change, and keeps the old value. Without `pinnedAt` there is nothing
		// for two sides to compare, and the merge can only guess (it used to OR, which
		// made unpinning impossible).
		pinnedAt: typeof value.pinnedAt === "number" && Number.isFinite(value.pinnedAt) && value.pinnedAt > 0 ? Math.floor(value.pinnedAt) : 0,
		// A tombstone: epoch milliseconds of the deletion, or 0 for a live entry.
		// Without it a union merge can only ever add, so a deletion made in the page
		// would be undone by the next round trip. See `mergeRecords`.
		deletedAt:
			typeof value.deletedAt === "number" && Number.isFinite(value.deletedAt) && value.deletedAt > 0 ? Math.floor(value.deletedAt) : 0,
		// What the user said about this entry, and when they last said it.
		//
		// Same reason as `pinnedAt`: the remark is a DECISION the user can retract, so the decision
		// needs a clock of its own. `updatedAt` follows the definition, and a remark changes no
		// definition — without `feedbackAt` a retraction could not be told from silence, and the copy
		// that still carries the remark would win every merge.
		feedback: normalizeFeedback(value.feedback),
		feedbackAt: typeof value.feedbackAt === "number" && Number.isFinite(value.feedbackAt) && value.feedbackAt > 0 ? Math.floor(value.feedbackAt) : 0,
		// "Do not treat this explanation as authoritative." The automatic explainer obeys it; see
		// `requestExplanation` in the shell. Stamped for the same reason as `feedbackAt`, since it is
		// a verdict the user can take back.
		untrusted: value.untrusted === true,
		untrustedAt: typeof value.untrustedAt === "number" && Number.isFinite(value.untrustedAt) && value.untrustedAt > 0 ? Math.floor(value.untrustedAt) : 0,
		// Transient merge directives, consumed by the merge and never stored.
		//
		// `observed` marks the record a sighting produced, so a sighting counts once
		// and a document load counts zero. `edited` marks the record an explicit edit
		// produced, which is the only thing allowed to advance `updatedAt`: without
		// that distinction a merge would stamp the current time onto content it merely
		// received, and the deletion rule would then compare a deletion against a
		// timestamp that never reflected an edit.
		...(value.observed === true ? { observed: true } : {}),
		...(value.edited === true ? { edited: true } : {})
	};
}

/**
 * Whether an entry is a tombstone rather than a live dictionary entry.
 * @param entry - a normalized entry.
 * @returns true when the entry records a deletion.
 */
function isTombstone(entry) {
	return (entry?.deletedAt ?? 0) > 0;
}

/**
 * Build a new entry for a term the dictionary does not have yet.
 *
 * The definition is filled from the best source available at call time: an
 * explicit user definition, then the built-in glossary, then nothing (the UI
 * offers to generate one). `source` records which of those it was, so the UI can
 * show an auto-detected entry as unverified instead of pretending it is curated.
 *
 * @param input - term plus whatever the caller already knows about it.
 * @param glossary - the glossary record for the term, if any.
 * @param options - `now` overrides the creation timestamp.
 * @returns a complete entry.
 * @throws {TypeError} when `input.term` is missing or blank.
 */
function createEntry(input, glossary, options) {
	const term = typeof input?.term === "string" ? input.term.replace(/\s+/g, " ").trim() : "";
	if (term === "") throw new TypeError("createEntry requires a non-empty term");
	const now = typeof options?.now === "number" ? options.now : Date.now();
	const provided = input.definition ?? {};
	const hasUserDefinition = typeof provided.gloss === "string" && provided.gloss.trim() !== "";
	const fromGlossary = !hasUserDefinition && glossary !== undefined && typeof glossary.gloss === "string" && glossary.gloss.trim() !== "";
	const definition = hasUserDefinition
		? {
			zh: clampText(provided.zh ?? "", 60),
			gloss: clampText(provided.gloss, MAX_DEFINITION_CHARS),
			usage: clampText(provided.usage ?? "", MAX_DEFINITION_CHARS),
			notes: clampText(provided.notes ?? "", MAX_DEFINITION_CHARS)
		}
		: fromGlossary
			? {
				zh: clampText(provided.zh ?? glossary.zh ?? "", 60),
				gloss: clampText(glossary.gloss, MAX_DEFINITION_CHARS),
				usage: clampText(provided.usage ?? "", MAX_DEFINITION_CHARS),
				notes: clampText(provided.notes ?? "", MAX_DEFINITION_CHARS)
			}
			: { zh: clampText(provided.zh ?? "", 60), gloss: clampText(provided.gloss ?? "", MAX_DEFINITION_CHARS), usage: "", notes: "" };
	const source = input.source !== undefined && SOURCES.includes(input.source)
		? input.source
		: hasUserDefinition
			? "user"
			: fromGlossary
				? "heuristic"
				: "auto";
	return normalizeEntry({
		term,
		// A brand-new record is not an edit of anything, so it carries no transient
		// directive. Without this, spreading a record that had one would inherit it.
		observed: input.observed === true,
		edited: false,
		aliases: input.aliases ?? [],
		definition,
		domain: input.domain ?? (glossary !== undefined ? glossary.domain : ""),
		source,
		confidence: input.confidence ?? (fromGlossary ? 0.8 : source === "user" ? 1 : 0.45),
		createdAt: now,
		updatedAt: now,
		seen: 1,
		lastSeenAt: now,
		context: input.context ?? "",
		sessionId: input.sessionId ?? "",
		pinned: input.pinned === true,
		pinnedAt: input.pinned === true ? now : 0
	});
}

/**
 * Whether a patch actually changes the stored definition, so a repeated
 * auto-detection does not rewrite the file on every message.
 * @param entry - the stored entry.
 * @param patch - the candidate replacement fields.
 * @returns true when at least one definition field or the domain differs.
 */
function definitionChanged(entry, patch) {
	const next = patch.definition ?? {};
	if ((patch.domain ?? entry.domain) !== entry.domain) return true;
	return ["zh", "gloss", "usage", "notes"].some((field) => {
		const value = next[field];
		if (value === undefined) return false;
		return clampText(value, MAX_DEFINITION_CHARS) !== entry.definition[field];
	});
}

/**
 * Merge one incoming entry's CONTENT into an existing one.
 *
 * This function deliberately does not decide deletion. It keeps whatever deletion
 * state the current record already had, and a missing current record means there is
 * nothing to argue with. Deletion is decided in one place — `mergeRecords` in
 * `dictionary.js` — because two independent decisions is exactly how a merge became
 * order-dependent: a tombstone arriving as `incoming` would resurrect a record, and
 * the same pair merged the other way would not.
 *
 * Later, stronger evidence wins for the content: a user edit replaces an automatic
 * definition, while a later automatic sighting of an entry the user already curated
 * only bumps the sighting counters and never touches the definition.
 *
 * @param current - the stored record.
 * @param incoming - the candidate record, already normalized.
 * @param options - `now` overrides the update timestamp.
 * @returns the merged record.
 */
function mergeEntry(current, incoming, options) {
	if (current === undefined || current === null) return incoming;
	const incomingRank = SOURCE_RANK[incoming.source] ?? 0;
	const currentRank = SOURCE_RANK[current.source] ?? 0;
	const takeDefinition =
		incoming.definition.gloss !== "" &&
		(current.definition.gloss === "" || (incomingRank >= currentRank && definitionChanged(current, incoming)));
	// `updatedAt` is the time the kept content was authored, so it follows the content
	// rather than the merge. Re-stamping it with the current time was a real defect:
	// the deletion rule compares a deletion against this value, and a fabricated
	// "now" made content that merely arrived look like an edit made after the
	// deletion. Only `editEntry` advances it, and it does so before the merge.
	const merged = {
		...current,
		// `deletedAt` is NOT inherited from `current`: a content merge must not carry a
		// deletion forward, or the decision that consumes this result cannot tell a
		// live arrival from a deleted one. Whoever merges is responsible for passing
		// the deletion evidence separately.
		deletedAt: 0,
		aliases: [...new Set([...current.aliases, ...incoming.aliases])].slice(0, 8),
		definition: takeDefinition ? incoming.definition : current.definition,
		domain: takeDefinition && incoming.domain !== "" ? incoming.domain : current.domain,
		// Unlike the domain, an empty incoming group is taken when the content changed: moving an entry back
		// to the top level is a move, and the old rule ("an empty value never overwrites") would make the
		// top level unreachable for anything that had ever been filed.
		group: (incoming.groupAt ?? 0) > (current.groupAt ?? 0) ? incoming.group : current.group,
		groupAt: Math.max(incoming.groupAt ?? 0, current.groupAt ?? 0),
		restoredAt: Math.max(incoming.restoredAt ?? 0, current.restoredAt ?? 0),
		// The STRONGEST provenance survives, not the arriving one. Taking the arriving
		// source let a later automatic copy of an already-curated term downgrade it to
		// `auto`, which then denied that term its own revival — and let its source be
		// laundered. Provenance describes the record, and the record's best evidence of
		// who wrote it does not expire.
		source: incomingRank > currentRank ? incoming.source : current.source,
		confidence: Math.max(current.confidence, incoming.confidence),
		// The record's time belongs to the content it kept, never to content it discarded.
		// An automatic copy that arrives newer but LOSES the content contest must not hand
		// its timestamp to the user's text: the merge would then read the record as "the
		// user asked for this after the deletion", and a passing sighting would undo a
		// deletion. So the kept content's own time wins, and the later of the two is used
		// only when the arriving content is what was kept.
		updatedAt: takeDefinition ? Math.max(current.updatedAt ?? 0, incoming.updatedAt ?? 0) : current.updatedAt ?? 0,
		seen: current.seen + (incoming.observed === true ? 1 : 0),
		lastSeenAt: Math.max(current.lastSeenAt ?? 0, incoming.lastSeenAt ?? 0),
		context: current.context !== "" ? current.context : incoming.context,
		// `pinned` follows the most recent DECISION, not a logical OR.
		//
		// It was `current.pinned || incoming.pinned`, which made unpinning impossible in
		// the running plugin: the user's unpin wrote false locally, the host's copy still
		// said true, the merge OR-ed them back to true, and the page adopts the merged
		// document — so the pin snapped back on every click ("钉选功能无法取消"). An OR can
		// only ever add a pin, and a flag the user toggles needs the later decision to win.
		//
		// The decision is compared on `pinnedAt`, not `updatedAt`: a pin-only edit changes
		// no definition, and `updatedAt` deliberately follows the content, so it cannot
		// carry a pin change. `Math.max` on the timestamp keeps the result independent of
		// merge order, which matters because both sides run this function and must
		// converge on the same document.
		pinned: (incoming.pinnedAt ?? 0) > (current.pinnedAt ?? 0) ? incoming.pinned === true : current.pinned === true,
		pinnedAt: Math.max(incoming.pinnedAt ?? 0, current.pinnedAt ?? 0),
		// The same rule for the two things the user can say about an entry: the later DECISION wins,
		// including a decision to say nothing. An OR here would make retracting a remark impossible
		// in exactly the way it made unpinning impossible.
		feedback: (incoming.feedbackAt ?? 0) > (current.feedbackAt ?? 0) ? incoming.feedback : current.feedback,
		feedbackAt: Math.max(incoming.feedbackAt ?? 0, current.feedbackAt ?? 0),
		untrusted: (incoming.untrustedAt ?? 0) > (current.untrustedAt ?? 0) ? incoming.untrusted === true : current.untrusted === true,
		untrustedAt: Math.max(incoming.untrustedAt ?? 0, current.untrustedAt ?? 0)
	};
	return merged;
}

/**
 * Whether an entry still carries an unexplained term: it exists for tracking but
 * the user has no explanation yet, which is what the panel offers to fix. A
 * tombstone counts as explained so it is never offered for editing.
 * @param entry - a normalized entry.
 * @returns true when the entry has no definition text.
 */
function isUnexplained(entry) {
	if ((entry.deletedAt ?? 0) > 0) return false;
	return entry.definition.gloss === "" && entry.definition.zh === "";
}

/**
 * One entry as the text a person would paste somewhere.
 *
 * Why this exists as a function rather than as a selection: selecting the text in the panel is a
 * moving target. The list re-sorts itself as sightings arrive, the row under the pointer re-renders,
 * and — the defect that prompted this — the click that ENDS a selection used to open the editor on top
 * of it, so the selection was gone before it could be copied. A copy action needs no selection at all,
 * which is what makes it immune to all of that.
 *
 * The fields are chosen for pasting into a conversation or a note: the term, its Chinese name, the
 * explanation and an example. Aliases and the domain are lookup metadata — a reader searching the
 * panel uses them, a person pasting an entry does not want them in the middle of the sentence.
 *
 * @param entry - a normalized entry.
 * @returns the text, or "" when there is no term to copy.
 */
function entryAsText(entry) {
	if (entry === null || entry === undefined || typeof entry.term !== "string" || entry.term === "") return "";
	const definition = entry.definition ?? {};
	const lines = [definition.zh === undefined || definition.zh === "" ? entry.term : `${entry.term}（${definition.zh}）`];
	if (definition.gloss !== undefined && definition.gloss !== "") lines.push(definition.gloss);
	if (definition.usage !== undefined && definition.usage !== "") lines.push(`例：${definition.usage}`);
	return lines.join("\n");
}

/**
 * Case-insensitive free-text match over a term, its translation, its definition
 * and its aliases, used by the panel's search box.
 * @param entry - a normalized entry.
 * @param query - raw search text.
 * @returns true when the entry matches.
 */
function matchesQuery(entry, query) {
	const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
	if (needle === "") return true;
	const haystack = [entry.term, entry.definition.zh, entry.definition.gloss, entry.domain, ...entry.aliases]
		.join("\n")
		.toLowerCase();
	return haystack.includes(needle);
}

module.exports = {
	SOURCES,
	FEEDBACK_KINDS,
	SOURCE_RANK,
	MAX_DEFINITION_CHARS,
	MAX_CONTEXT_CHARS,
	MAX_NOTE_CHARS,
	MAX_GROUP_CHARS,
	normalizeEntry,
	normalizeFeedback,
	entryAsText,
	isFlagged,
	isTombstone,
	createEntry,
	mergeEntry,
	definitionChanged,
	isUnexplained,
	matchesQuery,
	clampText
};
