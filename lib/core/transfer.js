"use strict";

/**
 * Import and export: the dictionary as a file, and a file as dictionary entries.
 *
 * Everything here is PURE — no store, no document, no React. The decisions the feature is made of
 * live in this one file so they can be checked without a browser: what a file contains, which
 * entries a scope selects, and what an import does with an entry it cannot take.
 *
 * Groups are `domain`
 * -------------------
 * "Import as a group" and "export by category" both mean the entry's `domain`, which every entry
 * already has, which the panel already shows, and which the merged document already carries. A
 * separate folder concept would have meant a schema change in the one part of this plugin that has
 * tombstones and union-merge rules to get wrong — for no expressive gain the data was asking for.
 *
 * An import never surprises
 * -------------------------
 * The dictionary refuses to re-collect a term it has deleted (that is what its tombstones are for),
 * so an import does NOT silently reinstate one: a file is not a reason to override a decision the
 * user made by hand. Existing entries are left alone for the same reason — the local explanation may
 * be edited, pinned or better than the file's. What the import does instead is report exactly what it
 * took and what it passed over, because "12 imported" and "12 imported, 3 skipped" are different
 * facts and only one of them is the truth.
 *
 * Retracting a deletion is a decision, so it is asked for
 * ------------------------------------------------------
 * `includeDeleted` is how the user says "and bring back the ones I struck out". It is an explicit
 * opt-in rather than a default because the tombstone list IS the blacklist; emptying it because a
 * file happened to contain those terms would be the import overruling the user. When it is set, the
 * entries move into `accepted` and the caller writes them through the store's ordinary save path —
 * which stamps a crafted revival strictly past the deletion, the one thing that makes a revived
 * entry survive the next merge.
 */

/** The envelope's marker, so a wrong file is refused with a sentence rather than a stack. */
const TRANSFER_KIND = "dsh-term-dictionary";

/** The envelope version. Bumped if the shape ever changes in a way an older reader must know about. */
const TRANSFER_VERSION = 1;

/** The feedback report's own marker, so it is never mistaken for a dictionary to import. */
const FEEDBACK_KIND = "dsh-term-dictionary-feedback";

/** The feedback report's version. */
const FEEDBACK_VERSION = 1;

/** The longest a term may be in an imported file, mirroring the collect path's limit. */
const MAX_TERM_LENGTH = 120;

/**
 * The fields one entry contributes to a file.
 *
 * A deliberate subset: what a reader needs to use the term, and nothing about this machine. `seen`,
 * `lastSeenAt` and `createdAt` are local history — importing them would claim a term was seen here
 * when it was not, and would make two files of the same dictionary differ for no useful reason.
 *
 * @param entry - an entry from the store.
 * @returns the portable record.
 */
function toRecord(entry) {
	const definition = entry?.definition ?? {};
	const record = {
		term: typeof entry?.term === "string" ? entry.term : "",
		key: typeof entry?.key === "string" ? entry.key : "",
		definition: {
			zh: typeof definition.zh === "string" ? definition.zh : "",
			gloss: typeof definition.gloss === "string" ? definition.gloss : "",
			usage: typeof definition.usage === "string" ? definition.usage : ""
		}
	};
	if (typeof entry?.domain === "string" && entry.domain !== "") record.domain = entry.domain;
	// A group travels through an export, so a backup restores the structure it was filed under; it does NOT
	// travel in a pack, where the reader organizes entries their own way (see `pack.js`'s allowlist).
	if (typeof entry?.group === "string" && entry.group !== "") record.group = entry.group;
	if (Array.isArray(entry?.aliases) && entry.aliases.length > 0) record.aliases = [...entry.aliases];
	if (entry?.pinned === true) record.pinned = true;
	if (typeof entry?.source === "string" && entry.source !== "") record.source = entry.source;
	return record;
}

/**
 * The domains present in a set of entries, with how many entries each holds.
 *
 * This is the checklist the export offers, so it must come from the data rather than from a
 * hard-coded list: the categories that exist are the categories the user made.
 *
 * @param entries - the entries to survey.
 * @returns `[{ domain, count }]`, most-populated first, then alphabetical.
 */
function domainsIn(entries) {
	const counts = new Map();
	for (const entry of Array.isArray(entries) ? entries : []) {
		const domain = typeof entry?.domain === "string" ? entry.domain.trim() : "";
		if (domain === "") continue;
		counts.set(domain, (counts.get(domain) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([domain, count]) => ({ domain, count }))
		.sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain));
}

/**
 * Build the file's contents.
 *
 * @param entries - every entry the caller may export.
 * @param options - `scope` (`"all"` or `"domains"`) and `domains` (the chosen ones).
 * @param now - the timestamp to stamp, for a deterministic check.
 * @returns the envelope, ready to be serialised.
 */
function buildExport(entries, options, now) {
	const all = Array.isArray(entries) ? entries : [];
	const scope = options?.scope === "domains" ? "domains" : "all";
	const chosen = new Set(Array.isArray(options?.domains) ? options.domains : []);
	// An export of "domains" with nothing chosen is an empty file, not a whole one: selecting no
	// categories is a statement, and quietly sending everything would be the wrong reading of it.
	const picked = scope === "all" ? all : all.filter((entry) => chosen.has(typeof entry?.domain === "string" ? entry.domain.trim() : ""));
	return {
		kind: TRANSFER_KIND,
		version: TRANSFER_VERSION,
		exportedAt: typeof now === "number" ? now : Date.now(),
		scope,
		domains: scope === "domains" ? [...chosen].sort() : domainsIn(all).map((entry) => entry.domain),
		entries: picked.map(toRecord)
	};
}

/**
 * Read one record from a file into an entry-shaped object.
 *
 * Tolerant about the envelope and about extra keys, strict about the one thing that identifies an
 * entry: a term. A file whose entries have no terms is not a dictionary, and saying so is better
 * than importing four hundred empty rows.
 *
 * Provenance is deliberately NOT read from the file. The store's save path stamps every entry the
 * user asked for as `user`, and that is the only source the merge counts as intent — a file claiming
 * `source: "auto"` would produce an entry that the next sync quietly drops. The file's own `source`
 * field is therefore recorded by {@link toRecord} for a human reader and ignored here.
 *
 * @param raw - one record from the file.
 * @returns `{ term, key, definition, domain, aliases, pinned }`, or null.
 */
function toEntry(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const term = typeof raw.term === "string" ? raw.term.trim() : "";
	if (term === "" || term.length > MAX_TERM_LENGTH) return null;
	const definition = raw.definition !== null && typeof raw.definition === "object" ? raw.definition : {};
	const entry = {
		term,
		key: typeof raw.key === "string" && raw.key.trim() !== "" ? raw.key.trim() : term.toLowerCase().replace(/\s+/g, " "),
		definition: {
			zh: typeof definition.zh === "string" ? definition.zh : "",
			gloss: typeof definition.gloss === "string" ? definition.gloss : "",
			usage: typeof definition.usage === "string" ? definition.usage : ""
		},
		domain: typeof raw.domain === "string" ? raw.domain.trim() : "",
		// A group is read back from a file like any other label the user assigned — that is what makes an
		// export a backup of the STRUCTURE and not only of the words.
		group: typeof raw.group === "string" ? raw.group.trim() : "",
		aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((alias) => typeof alias === "string" && alias.trim() !== "") : [],
		pinned: raw.pinned === true
	};
	return entry;
}

/**
 * Parse a file's text.
 *
 * Accepts the envelope this plugin writes, a bare array of entries, and an object with only an
 * `entries` array — because a file someone built by hand or by another tool is still worth reading,
 * and refusing it on the envelope alone would be pedantry with a cost.
 *
 * @param text - the file's contents.
 * @returns `{ ok: true, entries, skipped }` or `{ ok: false, error }`.
 */
function parseImport(text) {
	if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "empty" };
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: "not-json" };
	}
	const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
	if (list === null) return { ok: false, error: "no-entries" };
	const entries = [];
	let skipped = 0;
	for (const raw of list) {
		const entry = toEntry(raw);
		if (entry === null) {
			skipped++;
			continue;
		}
		entries.push(entry);
	}
	if (entries.length === 0) return { ok: false, error: "no-usable-entries" };
	return { ok: true, entries, skipped };
}

/**
 * The folder path a file sits in, as a group path.
 *
 * The picked folder's own name IS the first group: choosing a folder called `packs` is how you say "file
 * these under `packs`", and dropping the name would put everything at the top level — which is precisely
 * the structure the user just picked a folder to express.
 *
 * @param path - a `relative/path/file.json`, as `webkitRelativePath` reports it.
 * @returns the group path.
 */
function folderPathOf(path) {
	const parts = String(path)
		.split("/")
		.filter((part) => part !== "");
	// Everything but the file name.
	return parts.slice(0, -1).join("/");
}

/**
 * Read a whole directory into one import.
 *
 * A folder is a mixed bag: several exported dictionaries, somebody's downloaded pack files, an
 * `index.json` that lists packs rather than holding entries, and often a README or a screenshot. So this
 * reports what it could NOT use instead of refusing the folder — the alternative is a user with twenty
 * files and one bad one, told "no" with no idea which file it was. Files that are not JSON are not
 * reported at all: they are not mistakes.
 *
 * @param files - `[{ path, text }]`, the directory's files as the browser hands them over.
 * @param options - `useFolderAsGroup` files each entry under the folder it came from, which is the shape
 *   people actually keep: one folder per topic, and the reason the option exists at all.
 * @returns `{ entries, files, used, skipped }`, where `skipped` is `[{ name, error }]`.
 */
function collectFolderImport(files, options) {
	const list = Array.isArray(files) ? files : [];
	const entries = [];
	const skipped = [];
	const useFolder = options?.useFolderAsGroup === true;
	let used = 0;
	let jsonFiles = 0;
	for (const file of list) {
		const path = typeof file?.path === "string" ? file.path : "";
		if (!/\.json$/i.test(path)) continue;
		jsonFiles++;
		const parsed = parseImport(typeof file?.text === "string" ? file.text : "");
		if (parsed.ok !== true) {
			skipped.push({ name: path, error: parsed.error });
			continue;
		}
		used++;
		const folder = useFolder ? folderPathOf(path) : "";
		for (const entry of parsed.entries) {
			const hasGroup = typeof entry.group === "string" && entry.group !== "";
			entries.push(folder !== "" && !hasGroup ? { ...entry, group: folder } : entry);
		}
	}
	return { entries, files: jsonFiles, used, skipped };
}

/**
 * Decide what an import would do, without doing any of it.
 *
 * The policy in one place: an entry already present is left alone, an entry the user deleted is left
 * deleted unless the caller asked for those too, and everything else is taken. Duplicates WITHIN the
 * file collapse to one, on the same rule the store merges on — the key.
 *
 * @param existing - the entries the dictionary already holds.
 * @param incoming - the entries the file offers, already parsed.
 * @param deletedKeys - the keys the dictionary has tombstones for.
 * @param options - `includeDeleted` also takes the entries the user deleted.
 * @returns `{ accepted, existing, deleted, duplicates }`. `accepted` is what the caller writes.
 */
function planImport(existing, incoming, deletedKeys, options) {
	const have = new Set();
	for (const entry of Array.isArray(existing) ? existing : []) {
		if (typeof entry?.key === "string" && entry.key !== "") have.add(entry.key);
		if (typeof entry?.term === "string" && entry.term.trim() !== "") have.add(entry.term.trim().toLowerCase().replace(/\s+/g, " "));
	}
	const gone = deletedKeys instanceof Set ? deletedKeys : new Set(Array.isArray(deletedKeys) ? deletedKeys : []);
	const seen = new Set();
	const accepted = [];
	const alreadyHave = [];
	const wasDeleted = [];
	let duplicates = 0;
	for (const entry of Array.isArray(incoming) ? incoming : []) {
		const key = typeof entry?.key === "string" && entry.key !== "" ? entry.key : "";
		if (key === "" || seen.has(key)) {
			duplicates++;
			continue;
		}
		seen.add(key);
		if (gone.has(key)) {
			wasDeleted.push(entry);
			continue;
		}
		if (have.has(key)) {
			alreadyHave.push(entry);
			continue;
		}
		accepted.push(entry);
	}
	// Opting in does not empty the `deleted` bucket by accident: it moves those entries into
	// `accepted`, and the bucket is then genuinely empty, so the report says "0 you deleted" and
	// means it.
	const retract = options?.includeDeleted === true;
	return retract
		? { accepted: [...accepted, ...wasDeleted], existing: alreadyHave, deleted: [], duplicates }
		: { accepted, existing: alreadyHave, deleted: wasDeleted, duplicates };
}

/**
 * The feedback report: what the user said about which entries, as a file.
 *
 * This is the half of feedback the host's channel cannot carry. The host records a session-level
 * remark into the SESSION LOG — which stays on the machine that made it — so "this explanation is
 * wrong" would never reach the person who could fix it. A report is a carrier the user controls: they
 * export it and send it wherever they like.
 *
 * What it deliberately does NOT contain:
 *
 *  - **the conversation context.** An entry remembers the sentence a term appeared in, and that
 *    sentence is a piece of a private conversation. A remark about a glossary entry is not a reason
 *    to export somebody's transcript, so the field is absent by construction rather than by a flag
 *    somebody could flip.
 *  - **the explanation**, unless `includeGloss` asks for it. The gloss is model output about a term,
 *    and it is often exactly what the remark is about — so it can be attached, but only on purpose.
 *
 * @param entries - every live entry; the flagged ones are selected here.
 * @param options - `now`, `build` (the plugin build string), `includeGloss`.
 * @returns the report envelope, ready to be serialised.
 */
function buildFeedbackReport(entries, options) {
	const now = typeof options?.now === "number" ? options.now : Date.now();
	const includeGloss = options?.includeGloss === true;
	const flagged = (Array.isArray(entries) ? entries : [])
		// A remark and a verdict are both things the user said, and a report that dropped one of them
		// would be reporting half of what they said.
		.filter((entry) => entry?.feedback !== null && entry?.feedback !== undefined ? true : entry?.untrusted === true)
		// Newest remark first: the report is read top-down by whoever receives it.
		.sort((left, right) => Math.max(right.feedbackAt ?? 0, right.untrustedAt ?? 0) - Math.max(left.feedbackAt ?? 0, left.untrustedAt ?? 0) || left.term.localeCompare(right.term));
	return {
		kind: FEEDBACK_KIND,
		version: FEEDBACK_VERSION,
		exportedAt: now,
		// Which generation produced the report, so a receiver can tell a bug report from an old one.
		build: typeof options?.build === "string" ? options.build : "",
		count: flagged.length,
		entries: flagged.map((entry) => {
			const record = {
				term: entry.term,
				key: entry.key,
				untrusted: entry.untrusted === true,
				untrustedAt: entry.untrustedAt ?? 0
			};
			if (entry.feedback !== null && entry.feedback !== undefined) {
				record.kind = entry.feedback.kind;
				record.note = entry.feedback.note;
				record.at = entry.feedbackAt ?? 0;
			}
			if (includeGloss) record.gloss = entry.definition?.gloss ?? "";
			return record;
		})
	};
}

module.exports = {
	buildExport,
	buildFeedbackReport,
	parseImport,
	collectFolderImport,
	planImport,
	domainsIn,
	toRecord,
	toEntry,
	TRANSFER_KIND,
	TRANSFER_VERSION,
	FEEDBACK_KIND,
	FEEDBACK_VERSION
};
