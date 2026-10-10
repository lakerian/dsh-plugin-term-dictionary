"use strict";

/**
 * Term packs: a dictionary's worth of entries as one shareable artifact.
 *
 * A pack is what a user hands to another user — a topical glossary, a team's vocabulary, a domain's
 * jargon. It is deliberately NOT a dictionary file: {@link module:transfer} exports entries plus the
 * local history that makes them a snapshot of THIS machine, while a pack carries only what a reader
 * needs to use the terms, and never anything about the person who made it.
 *
 * What a pack therefore cannot contain, and why it matters:
 *
 *  - **`context`** — the sentence a term appeared in. That is a piece of a private conversation.
 *  - **`notes`** — the user's own remarks about an entry, which {@link module:transfer}'s record shape
 *    already leaves out and which a pack must not add back.
 *  - **`feedback` / `untrusted`** — what the AUTHOR thinks of an explanation. Someone else's verdict
 *    arriving as if it were yours would be worse than no verdict at all; the merge would also treat it
 *    as a decision, which is exactly the kind of state a shared artifact must not be able to write.
 *  - **`pinned` / `source` / `seen` / `lastSeenAt` / `createdAt`** — local preferences and history.
 *    A pack that pinned its own entries would rearrange the reader's list.
 *
 * The entries themselves use the same record shape as an imported file (`term`, `key`, `definition.{zh,
 * gloss,usage}`, `domain`, `aliases`), which is what lets an imported pack go through the import path
 * this plugin already has — the duplicate report, the deleted-term opt-in and the crafted revival are
 * all reused rather than reimplemented.
 */

const transfer = require("./transfer.js");

/** The envelope's marker, so a pack is never mistaken for a dictionary to import. */
const PACK_KIND = "dsh-term-dictionary-pack";

/** The envelope version. Bumped if the shape changes in a way an older reader must know about. */
const PACK_VERSION = 1;

/**
 * What a share code starts with.
 *
 * Declared here rather than next to the compressor because it is part of the FORMAT: the panel checks
 * it before a paste is sent anywhere, and the host checks it before it decompresses anything. One
 * definition, two readers — the compressor (`lib/pack-code.js`) imports this constant.
 */
const PACK_CODE_PREFIX = "dshpack1:";

/** Upper bounds, so a hand-written pack or index cannot bloat the panel. */
const MAX_PACK_TEXT = 160;
const MAX_PACK_ENTRIES = 2000;

/** The index's marker and version: the file a source URL points at, listing packs. */
const INDEX_KIND = "dsh-term-dictionary-index";
const INDEX_VERSION = 1;

/** The most packs one index may offer, and the longest a pack URL may be. */
const MAX_INDEX_PACKS = 500;
const MAX_URL = 600;

/**
 * Whether a URL may be fetched at all.
 *
 * **https only.** A plugin that fetches whatever a field says is a plugin that can be pointed at a
 * local file, a `data:` URL or a plaintext LAN endpoint, and none of those are a term-pack source. The
 * check is on the URL STRING, so it holds for a cached copy and for an injected transport alike.
 *
 * @param value - the candidate URL.
 * @returns null when it may be fetched, or the reason it may not.
 */
function refuseUrl(value) {
	if (typeof value !== "string" || value.trim() === "") return "no-url";
	if (value.length > MAX_URL) return "url-too-long";
	let url;
	try {
		url = new URL(value.trim());
	} catch (error) {
		return "bad-url";
	}
	if (url.protocol !== "https:") return "not-https";
	if (url.hostname === "") return "bad-url";
	// Credentials in a URL are a leak waiting to happen: they end up in the cache file and in any log
	// that prints the URL, and no pack source needs them.
	if (url.username !== "" || url.password !== "") return "credentials-in-url";
	return null;
}

/** Clamp one short text field. */
function clamp(value, limit = MAX_PACK_TEXT) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed.length <= limit) return trimmed;
	return `${trimmed.slice(0, limit - 1)}…`;
}

/**
 * One entry as a pack carries it: content, and nothing about the machine it came from.
 *
 * The field names match {@link module:transfer}'s record shape on purpose — validation of an incoming
 * pack is then the SAME validation as an incoming file, which is the difference between one gate and
 * two that drift.
 *
 * @param entry - an entry from the store.
 * @returns the portable record.
 */
function packRecord(entry) {
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
	if (Array.isArray(entry?.aliases) && entry.aliases.length > 0) record.aliases = [...entry.aliases];
	return record;
}

/**
 * Build a pack from the entries a caller offers.
 *
 * Deleted entries are refused here rather than filtered by the caller: a tombstone is the record of a
 * decision this machine made, and publishing one would be publishing somebody's deletion.
 *
 * @param entries - every entry the caller may publish.
 * @param options - `id`, `name`, `description`, `author`, `license`, `homepage`, `build`, `scope`
 *   (`"all"` or `"domains"`), `domains`, `now`.
 * @returns `{ ok: true, pack }`, or `{ ok: false, error }` when there is nothing to publish.
 */
function buildPack(entries, options) {
	const all = (Array.isArray(entries) ? entries : []).filter((entry) => (entry?.deletedAt ?? 0) === 0);
	// Selecting no category is a statement, exactly as it is for an export: publishing everything
	// instead would be the wrong reading of it.
	const scope = options?.scope === "domains" ? "domains" : "all";
	const chosen = new Set(Array.isArray(options?.domains) ? options.domains : []);
	const picked = scope === "all" ? all : all.filter((entry) => chosen.has(typeof entry?.domain === "string" ? entry.domain.trim() : ""));
	if (picked.length === 0) return { ok: false, error: scope === "all" ? "empty" : "empty-scope" };
	if (picked.length > MAX_PACK_ENTRIES) return { ok: false, error: "too-many" };
	// Sorted by key, so the same dictionary always produces the same bytes and therefore the same
	// checksum: two people publishing the same glossary get the same artifact, and a reader can tell
	// "same content" from "same file" without trusting anything.
	const records = picked.map(packRecord).sort((left, right) => left.key.localeCompare(right.key) || left.term.localeCompare(right.term));
	return {
		ok: true,
		pack: {
			kind: PACK_KIND,
			version: PACK_VERSION,
			id: clamp(options?.id) || "pack",
			name: clamp(options?.name) || clamp(options?.id) || "pack",
			description: clamp(options?.description, 400),
			author: clamp(options?.author),
			license: clamp(options?.license),
			homepage: clamp(options?.homepage, 400),
			build: clamp(options?.build),
			createdAt: typeof options?.now === "number" ? options.now : Date.now(),
			scope: { kind: scope, domains: scope === "domains" ? [...chosen].sort() : [] },
			count: records.length,
			entries: records
		}
	};
}

/**
 * Read a pack from whatever arrived: a fetched file, or a decoded share code.
 *
 * Tolerant about unknown keys in the envelope, strict about the two things that make it a pack: its
 * marker and at least one usable entry. Every record goes through the same validator an imported file
 * does, so a record that cannot be imported is a record this refuses.
 *
 * @param raw - the parsed value.
 * @returns `{ ok: true, pack }`, or `{ ok: false, error }`.
 */
function parsePack(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not-an-object" };
	if (raw.kind !== PACK_KIND) return { ok: false, error: "not-a-pack" };
	if (raw.version !== PACK_VERSION) return { ok: false, error: "unsupported-version" };
	if (!Array.isArray(raw.entries)) return { ok: false, error: "no-entries" };
	if (raw.entries.length > MAX_PACK_ENTRIES) return { ok: false, error: "too-many" };
	const entries = [];
	for (const record of raw.entries) {
		const entry = transfer.toEntry(record);
		if (entry !== null) entries.push(record);
	}
	if (entries.length === 0) return { ok: false, error: "no-usable-entries" };
	const scope = raw.scope !== null && typeof raw.scope === "object" && raw.scope.kind === "domains" ? "domains" : "all";
	return {
		ok: true,
		pack: {
			kind: PACK_KIND,
			version: PACK_VERSION,
			id: clamp(raw.id) || "pack",
			name: clamp(raw.name) || clamp(raw.id) || "pack",
			description: clamp(raw.description, 400),
			author: clamp(raw.author),
			license: clamp(raw.license),
			homepage: clamp(raw.homepage, 400),
			build: clamp(raw.build),
			createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? Math.floor(raw.createdAt) : 0,
			scope: { kind: scope, domains: scope === "domains" && Array.isArray(raw.scope.domains) ? raw.scope.domains.filter((domain) => typeof domain === "string") : [] },
			// The count is the number of records a reader will actually get, not the number the file
			// claimed: a pack whose records are half unusable must not read as fully usable.
			count: entries.length,
			entries
		}
	};
}

/**
 * The bytes a pack is published as, and therefore the bytes its checksum covers.
 *
 * `buildPack` sorts the records, so this is deterministic for a given dictionary — the property that
 * lets two publishers of the same glossary produce one artifact, and lets a reader compare a fetched
 * pack against the checksum an index promised.
 *
 * @param pack - a built or parsed pack.
 * @returns the JSON text.
 */
function packBytes(pack) {
	return JSON.stringify(pack);
}

/**
 * What a pack contains, for a list that has to describe it in one line.
 *
 * @param pack - a built or parsed pack.
 * @returns `{ count, explained, domains }`, where `explained` counts entries with an explanation.
 */
function summarizePack(pack) {
	const entries = Array.isArray(pack?.entries) ? pack.entries : [];
	const counts = new Map();
	let explained = 0;
	for (const record of entries) {
		const definition = record?.definition ?? {};
		if ((typeof definition.gloss === "string" && definition.gloss !== "") || (typeof definition.zh === "string" && definition.zh !== "")) explained++;
		const domain = typeof record?.domain === "string" ? record.domain.trim() : "";
		if (domain !== "") counts.set(domain, (counts.get(domain) ?? 0) + 1);
	}
	return {
		count: entries.length,
		explained,
		domains: [...counts.entries()].map(([domain, count]) => ({ domain, count })).sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain))
	};
}

/**
 * Build the index a source URL serves: the list a reader browses before fetching any pack.
 *
 * @param packs - `{ id, name, description, author, license, domains, count, sha256, url }` per pack.
 * @param options - `now`.
 * @returns the index envelope.
 */
function buildIndex(packs, options) {
	const listed = (Array.isArray(packs) ? packs : [])
		.filter((pack) => pack !== null && typeof pack === "object" && refuseUrl(pack.url) === null)
		.map((pack) => ({
			id: clamp(pack.id) || "pack",
			name: clamp(pack.name) || clamp(pack.id) || "pack",
			description: clamp(pack.description, 400),
			author: clamp(pack.author),
			license: clamp(pack.license),
			domains: (Array.isArray(pack.domains) ? pack.domains : []).filter((domain) => typeof domain === "string" && domain !== "").slice(0, 40),
			count: typeof pack.count === "number" && Number.isFinite(pack.count) && pack.count >= 0 ? Math.floor(pack.count) : 0,
			sha256: typeof pack.sha256 === "string" ? pack.sha256.toLowerCase() : "",
			url: pack.url
		}))
		.sort((left, right) => left.name.localeCompare(right.name))
		.slice(0, MAX_INDEX_PACKS);
	return {
		kind: INDEX_KIND,
		version: INDEX_VERSION,
		updatedAt: typeof options?.now === "number" ? options.now : Date.now(),
		count: listed.length,
		packs: listed
	};
}

/**
 * Read an index.
 *
 * Entries that cannot be used are DROPPED and counted rather than failing the whole file: one bad row
 * in somebody's index must not hide the other forty packs. An index with nothing usable left is a
 * refusal, because a source that offers nothing is a source that is misconfigured or moved.
 *
 * @param raw - the parsed value.
 * @returns `{ ok: true, index, dropped }`, or `{ ok: false, error }`.
 */
function parseIndex(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not-an-object" };
	if (raw.kind !== INDEX_KIND) return { ok: false, error: "not-an-index" };
	if (raw.version !== INDEX_VERSION) return { ok: false, error: "unsupported-version" };
	if (!Array.isArray(raw.packs)) return { ok: false, error: "no-packs" };
	const packs = [];
	let dropped = 0;
	for (const pack of raw.packs) {
		if (pack === null || typeof pack !== "object") {
			dropped++;
			continue;
		}
		// The url is the one field a bad value makes dangerous rather than merely useless.
		if (refuseUrl(pack.url) !== null || (typeof pack.id !== "string" && typeof pack.name !== "string")) {
			dropped++;
			continue;
		}
		packs.push({
			id: clamp(pack.id) || clamp(pack.name) || "pack",
			name: clamp(pack.name) || clamp(pack.id) || "pack",
			description: clamp(pack.description, 400),
			author: clamp(pack.author),
			license: clamp(pack.license),
			domains: (Array.isArray(pack.domains) ? pack.domains : []).filter((domain) => typeof domain === "string" && domain !== "").slice(0, 40),
			count: typeof pack.count === "number" && Number.isFinite(pack.count) && pack.count >= 0 ? Math.floor(pack.count) : 0,
			sha256: typeof pack.sha256 === "string" ? pack.sha256.toLowerCase() : "",
			url: String(pack.url).trim()
		});
	}
	if (packs.length === 0) return { ok: false, error: "no-usable-packs" };
	return {
		ok: true,
		dropped,
		index: {
			kind: INDEX_KIND,
			version: INDEX_VERSION,
			updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? Math.floor(raw.updatedAt) : 0,
			count: packs.length,
			packs: packs.slice(0, MAX_INDEX_PACKS)
		}
	};
}

module.exports = {
	PACK_KIND,
	PACK_VERSION,
	PACK_CODE_PREFIX,
	INDEX_KIND,
	INDEX_VERSION,
	MAX_PACK_ENTRIES,
	MAX_INDEX_PACKS,
	buildPack,
	parsePack,
	buildIndex,
	parseIndex,
	refuseUrl,
	packRecord,
	packBytes,
	summarizePack
};
