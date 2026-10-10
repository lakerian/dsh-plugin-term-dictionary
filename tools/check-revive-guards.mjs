// Mutation harness for the dictionary's own guards: the revive / blacklist work, the deleted view,
// the import's opt-in, and the beacon that reaches the console.
//
// The sibling of `check-pointer-guards.mjs`, and it exists for the same reason: a green check says
// only that the check did not fire, and a check that cannot fire is worth nothing. Every claim these
// features rest on gets a deliberate break, in a throwaway copy of the tree, and has to turn the
// check that claims to guard it RED.
//
//   node tools/check-revive-guards.mjs
//
// The sources are never written to. `tools/` and `dsh-plugin-term-dictionary/` are copied into
// `.tmp/revive-guards/work`, each mutation is applied to the COPY and the bundle rebuilt there, and
// the mutated file's checksum is compared against the original's at the end of that mutation.
//
// What each entry names is a claim, not a line: when the line moves, re-point `find`; when the
// behaviour it guarded is gone, delete the entry rather than leave a break that lands nowhere.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginDir, scratchDir } from "./paths.mjs";

const sandbox = join(scratchDir, "revive-guards");
const work = join(sandbox, "work");
/** `--keep` leaves the scratch copy behind, for reading a mutation that behaved unexpectedly. */
const keep = process.argv.includes("--keep");

rmSync(sandbox, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
// One recursive copy is a whole checkout: `tools/` lives inside the package, and the copy's own
// `paths.mjs` finds it by walking up for `dsh.bundle`, exactly as this one did.
const COPY = "pkg";
cpSync(pluginDir, join(work, COPY), { recursive: true });

/** Run one command in the copy, capturing everything. */
function run(args) {
	try {
		const out = execFileSync("node", args, { cwd: join(work, COPY), stdio: "pipe" });
		return { code: 0, out: String(out) };
	} catch (error) {
		return { code: error.status ?? 1, out: `${String(error.stdout ?? "")}${String(error.stderr ?? "")}` };
	}
}

/** The mutations: each reverts one decision this turn's guards exist to protect. */
const mutations = [
	{
		name: "the revival inherits a non-crafted source",
		file: `lib/core/dictionary.js`,
		find: 'deletedAt: 0, updatedAt, source: "user"',
		replace: 'deletedAt: 0, updatedAt, source: "auto"',
		filter: "reviving"
	},
	{
		name: "the revival is stamped with `now` alone",
		file: `lib/core/dictionary.js`,
		find: "const updatedAt = Math.max(now, (target.deletedAt ?? 0) + 1);",
		replace: "const updatedAt = now;",
		filter: "reviving"
	},
	{
		name: "the deleted filter falls back to the live list",
		file: `lib/core/store.js`,
		find: 'if (filter === "deleted") return dictionary.listDeleted(state, query).filter((entry) => (typeof entry.group === "string" ? entry.group : "") === at);',
		replace: 'if (filter === "deleted") return listEntries(state, query, "all", at);',
		filter: "revivePanel"
	},
	{
		name: "the import ignores the opt-in",
		file: `lib/core/transfer.js`,
		find: "const retract = options?.includeDeleted === true;",
		replace: "const retract = false;",
		filter: "transfer"
	},
	{
		name: "the deleted list is ordered oldest first",
		file: `lib/core/dictionary.js`,
		find: "(right.deletedAt ?? 0) - (left.deletedAt ?? 0)",
		replace: "(left.deletedAt ?? 0) - (right.deletedAt ?? 0)",
		filter: "deleted list"
	},
	{
		name: "revive looks the entry up by something that is not its id",
		file: `lib/core/views.js`,
		find: "const restored = await store.reviveEntry(entry.id);",
		replace: "const restored = await store.reviveEntry(`${entry.id}!`);",
		filter: "revivePanel"
	},
	{
		name: "the deleted tab is dropped from the tab list",
		file: `lib/core/views.js`,
		find: '["flagged", t("filterFlagged")],\n\t\t\t\t["deleted", t("filterDeleted")]',
		replace: '["flagged", t("filterFlagged")]',
		filter: "deleted view"
	},
	{
		name: "the deleted view is not exported to the checks",
		file: `lib/client.template.js`,
		find: "exports.deletedList = entry.deletedList;",
		replace: "// exports.deletedList = entry.deletedList;",
		filter: "deleted view"
	},
	{
		name: "the panel never renders the deleted view",
		file: `lib/core/views.js`,
		find: "showingDeleted\n\t\t\t\t\t? h(DeletedList,",
		replace: "false\n\t\t\t\t\t? h(DeletedList,",
		filter: "revivePanel"
	},
	{
		name: "an explicit edit is stamped with `now`, not past the deletion it supersedes",
		file: `lib/core/dictionary.js`,
		find: "const stamp = tombstoneAt > 0 ? Math.max(now, tombstoneAt + 1) : now;",
		replace: "const stamp = now;",
		filter: "importRevive"
	},
	{
		name: "the export page drops the categories the user ticked",
		file: `lib/core/views.js`,
		find: "buildExport(entries, { scope, domains: chosen }, Date.now())",
		replace: "buildExport(entries, { scope, domains: [] }, Date.now())",
		filter: "transferExport"
	},
	{
		name: "a category box never shows as ticked",
		file: `lib/core/views.js`,
		find: "checked: chosen.includes(domain.domain),",
		replace: "checked: false,",
		filter: "transferExport"
	},
	{
		name: "select-all selects nothing",
		file: `lib/core/views.js`,
		find: "onClick: () => setChosen(domains.map((domain) => domain.domain))",
		replace: "onClick: () => setChosen([])",
		filter: "transferExport"
	},
	{
		// Retargeted when the two import paths became one: the opt-in used to be passed from the transfer
		// page's own `planImport` call, and it now lives in the shared `importEntries` — the same claim,
		// asserted where the decision actually is (and therefore for both pages at once).
		name: "the import path stops passing the opt-in to the plan",
		file: `lib/core/views.js`,
		find: "includeDeleted: options?.includeDeleted === true",
		replace: "includeDeleted: false",
		filter: "transferImport"
	},
	{
		// Retargeted with the shared import path: same claim, now asserted where the count is summed.
		name: "the import report forgets the records the file could not use",
		file: `lib/core/views.js`,
		find: "duplicates: plan.duplicates + (options?.skipped ?? 0)",
		replace: "duplicates: plan.duplicates",
		filter: "transferImport"
	},
	{
		name: "a remark is merged like an OR instead of a decision",
		file: "lib/core/entries.js",
		find: "\t\tfeedback: (incoming.feedbackAt ?? 0) > (current.feedbackAt ?? 0) ? incoming.feedback : current.feedback,",
		replace: "\t\tfeedback: current.feedback ?? incoming.feedback,",
		filter: "remark is a decision"
	},
	{
		name: "the verdict on an explanation is merged like an OR",
		file: "lib/core/entries.js",
		find: "\t\tuntrusted: (incoming.untrustedAt ?? 0) > (current.untrustedAt ?? 0) ? incoming.untrusted === true : current.untrusted === true,",
		replace: "\t\tuntrusted: current.untrusted === true || incoming.untrusted === true,",
		filter: "remark is a decision"
	},
	{
		name: "a retraction is stamped with the same instant as the remark it takes back",
		file: "lib/core/dictionary.js",
		find: "const feedbackStamp = mentionsFeedback ? Math.max(stamp, (base.feedbackAt ?? 0) + 1) : base.feedbackAt ?? 0;",
		replace: "const feedbackStamp = mentionsFeedback ? stamp : base.feedbackAt ?? 0;",
		filter: "remark is a decision"
	},
	{
		name: "an automatic answer fills in an entry the user called untrustworthy",
		file: "lib/core/dictionary.js",
		find: "const refused = existing.untrusted === true && sighting.overridesUntrusted !== true;",
		replace: "const refused = false;",
		filter: "called untrustworthy"
	},
	{
		name: "an unfamiliar feedback category is kept instead of degrading to other",
		file: "lib/core/entries.js",
		find: "kind: FEEDBACK_KINDS.includes(value.kind) ? value.kind : \"other\",",
		replace: "kind: value.kind,",
		filter: "unknown feedback kind"
	},
	{
		name: "the feedback report attaches every explanation whether asked or not",
		file: "lib/core/transfer.js",
		find: "\t\t\tif (includeGloss) record.gloss = entry.definition?.gloss ?? \"\";",
		replace: "\t\t\trecord.gloss = entry.definition?.gloss ?? \"\";",
		filter: "feedback report says what was said"
	},
	{
		name: "saving the editor always rewrites the remark, so an unrelated save retracts it",
		file: "lib/core/views.js",
		find: "feedback: editing.feedbackTouched ? { kind: editing.feedbackKind, note: editing.feedbackNote } : null,",
		replace: "feedback: { kind: editing.feedbackKind, note: editing.feedbackNote },",
		filter: "markEntry"
	},
	{
		name: "the editor forgets that an existing remark was already made",
		file: "lib/core/views.js",
		find: "feedbackTouched: entry.feedback !== null && entry.feedback !== undefined,",
		replace: "feedbackTouched: false,",
		filter: "markEntry"
	},
	{
		name: "the feedback route records without a channel",
		file: "lib/index.js",
		find: '\t\tif (feedback === null) return sendJson(res, 200, { ok: false, error: "unavailable" });',
		replace: "\t\tif (feedback === null) void 0;",
		filter: "feedback:",
		suite: "host"
	},
	{
		name: "the feedback route passes an unknown category straight to the host",
		file: "lib/index.js",
		find: 'const category = FEEDBACK_CATEGORIES.includes(body.category) ? body.category : "product-interaction";',
		replace: "const category = body.category;",
		filter: "feedback:",
		suite: "host"
	},
	{
		name: "the feedback route records a remark with no session to attach it to",
		file: "lib/index.js",
		find: '\t\tif (sessionId === "") return sendJson(res, 400, { error: "sessionId is required" });',
		replace: "\t\tif (sessionId === \"\") void 0;",
		filter: "feedback:",
		suite: "host"
	},
	{
		name: "the feedback route forwards a runaway remark",
		file: "lib/index.js",
		find: 'const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_FEEDBACK_CHARS) : "";',
		replace: 'const text = typeof body.text === "string" ? body.text.trim() : "";',
		filter: "feedback:",
		suite: "host"
	},
	{
		name: "a dropped session is not told apart from a channel that refused",
		file: "lib/index.js",
		find: 'return sendJson(res, 200, { ok: false, error: outcome?.error?.code === "session-not-found" ? "session-not-found" : "rejected" });',
		replace: 'return sendJson(res, 200, { ok: false, error: "rejected" });',
		filter: "feedback:",
		suite: "host"
	},
	{
		name: "the page sends an empty session id instead of asking for a conversation",
		file: "lib/core/views.js",
		find: 'if (sessionId === "") {\n\t\t\tsetFeedbackState("no-session");\n\t\t\treturn;\n\t\t}',
		replace: "if (sessionId === \"\") void 0;",
		filter: "feedbackReport"
	},
	{
		name: "the client drops the session id it was handed",
		file: "lib/core/api.js",
		find: 'sessionId: typeof input?.sessionId === "string" ? input.sessionId : "",',
		replace: 'sessionId: "",',
		filter: "feedbackApi"
	},
	{
		name: "the pasted text loses the explanation",
		file: "lib/core/entries.js",
		find: '\tif (definition.gloss !== undefined && definition.gloss !== "") lines.push(definition.gloss);',
		replace: "\tif (false) lines.push(definition.gloss);",
		filter: "reads as the text"
	},
	{
		name: "a click that ends a selection opens the editor over it",
		file: "lib/core/views.js",
		find: "\t\t\t\t\t\t\t\tif (selectionInside(event?.currentTarget)) return;",
		replace: "\t\t\t\t\t\t\t\tif (false) return;",
		filter: "copyEntry"
	},
	{
		name: "the row loses its copy action",
		file: "lib/core/views.js",
		find: '\t\t\t\t\t\t\th(IconButton, { title: t("copyEntry"), onClick: () => void copyEntry(entry) }, Icons.copy(13)),',
		replace: "",
		filter: "copyEntry"
	},
	{
		name: "the annotated-term click ignores a selection and switches the panel anyway",
		file: "lib/core/hover.js",
		find: "\t\tif (selectionActive(doc)) return;",
		replace: "\t\tif (false) return;",
		filter: "hoverSelection"
	},
	{
		name: "a whitespace-only selection counts as a selection gesture",
		file: "lib/core/selection.js",
		find: '\treturn selection.toString().trim() !== "";',
		replace: '\treturn selection.toString() !== "";',
		filter: "one shared answer"
	},
	{
		name: "the caret check is dropped, so a collapsed selection counts as one",
		file: "lib/core/selection.js",
		find: "\tif (selection.isCollapsed === true) return false;",
		replace: "\tif (false) return false;",
		filter: "one shared answer"
	},
	{
		name: "the panel stops asking where the selection is",
		file: "lib/core/selection.js",
		find: "\treturn element.contains(node) === true;",
		replace: "\treturn node !== null;",
		filter: "one shared answer"
	},
	{
		name: "a pack carries the author's own verdicts and remarks",
		file: "lib/core/pack.js",
		find: "\tif (Array.isArray(entry?.aliases) && entry.aliases.length > 0) record.aliases = [...entry.aliases];\n\treturn record;",
		replace: "\tif (Array.isArray(entry?.aliases) && entry.aliases.length > 0) record.aliases = [...entry.aliases];\n\tif (entry?.feedback !== undefined) record.feedback = entry.feedback;\n\tif (entry?.untrusted !== undefined) record.untrusted = entry.untrusted;\n\tif (entry?.pinned !== undefined) record.pinned = entry.pinned;\n\treturn record;",
		filter: "pack:",
		suite: "host"
	},
	{
		name: "a pack publishes a term the user deleted",
		file: "lib/core/pack.js",
		find: "const all = (Array.isArray(entries) ? entries : []).filter((entry) => (entry?.deletedAt ?? 0) === 0);",
		replace: "const all = Array.isArray(entries) ? entries : [];",
		filter: "pack:"
	},
	{
		name: "an empty category selection silently publishes the whole dictionary",
		file: "lib/core/pack.js",
		find: '\tif (picked.length === 0) return { ok: false, error: scope === "all" ? "empty" : "empty-scope" };',
		replace: "\tif (picked.length === 0 && scope === \"all\") return { ok: false, error: \"empty\" };",
		filter: "pack:",
		suite: "host"
	},
	{
		name: "the source rule stops insisting on https",
		file: "lib/core/pack.js",
		find: '\tif (url.protocol !== "https:") return "not-https";',
		replace: "\tif (false) return \"not-https\";",
		filter: "source:",
		suite: "host"
	},
	{
		name: "a fetched pack is accepted without checking the promised digest",
		file: "lib/index.js",
		find: '\t\tif (promised !== "" && promised !== digest) {',
		replace: "\t\tif (false) {",
		filter: "source:",
		suite: "host"
	},
	{
		name: "an unreachable source is not served from its cache",
		file: "lib/index.js",
		find: "\t\t\tif (entry !== undefined) {\n\t\t\t\treturn sendJson(res, 200, { ok: true, index: entry.index, fetchedAt: entry.fetchedAt, cached: true, stale: true, error: fetched.error });\n\t\t\t}",
		replace: "\t\t\tif (false) {\n\t\t\t\treturn sendJson(res, 200, { ok: true, index: entry.index, fetchedAt: entry.fetchedAt, cached: true, stale: true, error: fetched.error });\n\t\t\t}",
		filter: "source:",
		suite: "host"
	},
	{
		name: "a source is added without the https rule",
		file: "lib/core/views.js",
		find: "\t\tif (refusal !== null) return say(t(`packError_${refusal}`));",
		replace: "\t\tif (false) return say(t(`packError_${refusal}`));",
		filter: "packPage"
	},
	{
		name: "the source list keeps entries the fetch would refuse",
		file: "lib/core/settings.js",
		find: "\t\tif (refuseUrl(url) !== null) continue;",
		replace: "\t\tif (false) continue;",
		filter: "source list keeps"
	},
	{
		name: "previewing a listed pack offers nothing to import",
		file: "lib/core/views.js",
		find: "\t\t\tsetIncoming({ pack: answer.pack, summary: answer.summary, label: listed.name });",
		replace: "\t\t\tsetIncoming(null);",
		filter: "packPage"
	},
	{
		name: "the shared import path plans but never writes",
		file: "lib/core/views.js",
		find: "\tfor (const entry of plan.accepted) {",
		replace: "\tfor (const entry of plan.accepted) { break;",
		filter: "packPage"
	},
	{
		name: "the pack from a source is fetched without the promised digest",
		file: "lib/core/api.js",
		find: 'const digest = typeof sha256 === "string" && sha256 !== "" ? `&sha256=${encodeURIComponent(sha256)}` : "";',
		replace: 'const digest = "";',
		filter: "source fetch"
	},
	{
		name: "a stale cached pack is trusted over the digest that was promised",
		file: "lib/index.js",
		find: '\t\tif (cached && promised !== "" && promised !== digest) {',
		replace: "\t\tif (false) {",
		filter: "verified against the checksum",
		suite: "host"
	},
	{
		name: "the generated index changes on every run, so staleness can never be detected",
		file: "tools/make-pack-index.mjs",
		find: "const index = pack.buildIndex(listed, { now: newest });",
		replace: "const index = pack.buildIndex(listed, { now: Date.now() });",
		filter: "index the generator writes",
		suite: "host"
	},
	{
		name: "clearing every source silently brings the shipped one back",
		file: "lib/core/settings.js",
		find: "\t\tpackSources: value.packSources === undefined ? [...DEFAULT_SETTINGS.packSources] : readSources(value.packSources)",
		replace: "\t\tpackSources: readSources(value.packSources).length === 0 ? [...DEFAULT_SETTINGS.packSources] : readSources(value.packSources)",
		filter: "source list keeps"
	},
	{
		name: "the packs page never asks its sources, so a fresh install shows nothing",
		file: "lib/core/views.js",
		find: "\t\tvoid refresh();",
		replace: "\t\tvoid 0;",
		filter: "packPage"
	},
	{
		name: "a fixed column count is ignored and the layout is chosen anyway",
		file: "lib/core/views.js",
		find: "\t\t\t? `repeat(${fixed}, minmax(0, 1fr))`",
		replace: "\t\t\t? `repeat(auto-fill, minmax(${MIN_COLUMN_PX}px, 1fr))`",
		filter: "layout follows the column"
	},
	{
		name: "the import writes the file as soon as it is picked, with nothing to confirm",
		file: "lib/core/views.js",
		find: "\t\t\tsetPending({ name: file.name, entries: parsed.entries, skippedCount: parsed.skipped ?? 0, plan: planFor(parsed.entries, includeDeleted) });",
		replace: "\t\t\tsetPending(null);\n\t\t\tsetReport(await importEntries(store, parsed.entries, { includeDeleted, skipped: parsed.skipped ?? 0 }));",
		filter: "transferImport"
	},
	{
		name: "the confirmation writes the entries instead of the ones the user saw",
		file: "lib/core/views.js",
		find: "\t\t\tconst result = await importEntries(store, pending.entries, { includeDeleted, skipped: pending.skippedCount });",
		replace: "\t\t\tconst result = await importEntries(store, [], { includeDeleted, skipped: pending.skippedCount });",
		filter: "transferImport"
	},
	{
		name: "a folder import reads files that are not JSON, and reports them as mistakes",
		file: "lib/core/transfer.js",
		find: "\t\tif (!/\\.json$/i.test(path)) continue;",
		replace: "\t\tif (false) continue;",
		filter: "a folder is read as one import"
	},
	{
		name: "a folder import overwrites a group the file itself named",
		file: "lib/core/transfer.js",
		find: '\t\t\tentries.push(folder !== "" && !hasGroup ? { ...entry, group: folder } : entry);',
		replace: '\t\t\tentries.push(folder !== "" ? { ...entry, group: folder } : entry);',
		filter: "a folder is read as one import"
	},
	{
		name: "an import never asks the panel to show what it wrote",
		file: "lib/core/views.js",
		find: '\t\t\tconst moved = typeof props.onImported === "function" && props.onImported() === true;',
		replace: "\t\t\tconst moved = false;",
		filter: "importMoved"
	},
	{
		name: "a group move is carried by the content merge instead of its own stamp",
		file: "lib/core/entries.js",
		find: "\t\tgroup: (incoming.groupAt ?? 0) > (current.groupAt ?? 0) ? incoming.group : current.group,",
		replace: "\t\tgroup: current.group ?? incoming.group,",
		filter: "groups are directories"
	},
	{
		name: "an entry cannot be moved back to the top level",
		file: "lib/core/dictionary.js",
		find: '\tconst mentionsGroup = patch !== null && patch !== undefined && Object.prototype.hasOwnProperty.call(patch, "group");',
		replace: '\tconst mentionsGroup = patch !== null && patch !== undefined && typeof patch.group === "string" && patch.group !== "";',
		filter: "groups are directories"
	},
	{
		name: "a group lists everything below it instead of one level",
		file: "lib/core/dictionary.js",
		find: '\t\tif ((typeof entry.group === "string" ? entry.group : "") !== base) return false;',
		replace: "\t\tvoid base;",
		filter: "groups are directories"
	},
	{
		name: "the list sorts pinned first again, so pinning moves the row",
		file: "lib/core/dictionary.js",
		find: "\treturn matched.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.term.localeCompare(right.term));",
		replace: "\treturn matched.sort((left, right) => Number(right.pinned) - Number(left.pinned) || (right.createdAt ?? 0) - (left.createdAt ?? 0));",
		filter: "an action never moves"
	},
	{
		name: "the row's actions go back on the title line",
		file: "lib/core/views.js",
		find: '{ style: applyStyles.rowActions, "data-term-actions": entry.key },',
		replace: '{ style: applyStyles.rowHead, "data-term-actions": entry.key },',
		filter: "the pin leads the row"
	},
	{
		name: "the index parser only accepts an object again, so every source fails",
		file: "lib/core/pack.js",
		find: '\tconst raw2 = value;\n\tif (raw2.kind !== INDEX_KIND) return { ok: false, error: "not-an-index" };',
		replace: '\tconst raw2 = raw;\n\tif (raw2.kind !== INDEX_KIND) return { ok: false, error: "not-an-index" };',
		filter: "TEXT that production"
	},
	// RETIRED M(retired) — "a restoration leaves the tombstone in the document for a merge to find again".
	// It anchored on a hand-made `backing` filter in `restoreEntry`, and it stopped biting because that
	// filter was REDUNDANT: re-sealing the rewritten records derives `backing`/`deletedKeys` afresh, so the
	// hand-made filter could not change the outcome. The claim it tested is still guarded — by "a restoration
	// is not recorded as evidence", which removes the `restoredAt` the merge reads, and by the suite's
	// assertion that `deletedKeys` and `backing` come back empty from a restoration.
	{
		name: "a restoration is not recorded as evidence, so a merge has only a clock to read",
		file: "lib/core/dictionary.js",
		find: '\t\tentry.id === found.id || entry.key === key ? { ...entry, deletedAt: 0, restoredAt: stamp, source: "user", updatedAt: stamp, lastSeenAt: stamp } : entry',
		replace: '\t\tentry.id === found.id || entry.key === key ? { ...entry, deletedAt: 0, source: "user", updatedAt: stamp, lastSeenAt: stamp } : entry',
		filter: "withdraws the tombstone"
	},
	{
		name: "a restore of an already-live term claims it restored something",
		file: "lib/core/dictionary.js",
		find: "\t\treturn { state, entry: found, restored: false };",
		replace: "\t\treturn { state, entry: found, restored: true };",
		filter: "withdraws the tombstone"
	},
	{
		name: "a group row opens something other than the group it names",
		file: "lib/core/views.js",
		find: "\t\t\t\t\t\t\t\tonClick: () => setGroup(sub.group),",
		replace: "\t\t\t\t\t\t\t\tonClick: () => setGroup(group),",
		filter: "groups are rows you open"
	},
	{
		name: "the panel lists every level at once instead of one level at a time",
		file: "lib/core/store.js",
		find: "\t\t\treturn listEntries(state, query, filter, at);",
		replace: '\t\t\treturn listEntries(state, query, filter, "");',
		filter: "groups are rows you open"
	},
	{
		name: "the breadcrumb cannot take you back up",
		file: "lib/core/views.js",
		find: "\t\t\t\t\t\t\t\t\tonClick: () => setGroup(crumb.path),",
		replace: "\t\t\t\t\t\t\t\t\tonClick: () => setGroup(crumb.label),",
		filter: "groups are rows you open"
	},
	{
		name: "only the group's label answers a click, so the row looks dead",
		file: "lib/core/views.js",
		find: "\t\t\t\t\t\tonClick: () => setGroup(sub.group)\n\t\t\t\t\t},",
		replace: "\t\t\t\t\t\tonClick: undefined\n\t\t\t\t\t},",
		filter: "groups are rows you open"
	},
	{
		name: "the entry cards no longer fill their track, leaving a strip under the short ones",
		file: "lib/core/views.js",
		find: '\t\talignItems: rowLayout === "compact" ? "start" : "stretch",',
		replace: '\t\talignItems: "start",',
		filter: "layout follows the column"
	},
	{
		name: "the grid stretches its rows to fill the panel, so two cards fill the window",
		file: "lib/core/views.js",
		find: '\t\talignContent: "start",',
		replace: "",
		filter: "layout follows the column"
	},
	{
		name: "a group card keeps its own height instead of filling the row it is in",
		file: "lib/core/views.js",
		find: '\t\t\t\t\t\tstyle: applyStyles.row,\n\t\t\t\t\t\t"data-term-group": sub.group,',
		replace: '\t\t\t\t\t\tstyle: { ...applyStyles.row, alignSelf: "start" },\n\t\t\t\t\t\t"data-term-group": sub.group,',
		filter: "groups are rows you open"
	},
	{
		name: "the breadcrumb is a grid cell again, so it floats in the middle of the row",
		file: "lib/core/views.js",
		find: '\t\t\t\t\t{ style: { ...applyStyles.breadcrumb, gridColumn: "1 / -1" }, "data-term-breadcrumb": group },',
		replace: '\t\t\t\t\t{ style: applyStyles.breadcrumb, "data-term-breadcrumb": group },',
		filter: "groups are rows you open"
	},
	{
		name: "a group card is a name over blank space again, with no preview of what is inside",
		file: "lib/core/views.js",
		find: '{ style: applyStyles.groupPreview, "data-term-group-sample": sub.group },',
		replace: '{ style: applyStyles.groupPreview, "data-term-group-sample": undefined },',
		filter: "groups are rows you open"
	},
	{
		name: "the preview names the oldest terms rather than the newest few",
		file: "lib/core/dictionary.js",
		find: "\t\t.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.term.localeCompare(right.term));",
		replace: "\t\t.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.term.localeCompare(right.term));",
		filter: "groups are directories"
	},
	{
		name: "the build guard copies literal text again",
		file: "tools/build-client.mjs",
		find: 'out += character === "\\n" ? "\\n" : " ";',
		replace: "out += character;",
		filter: "",
		expectBuildFailure: true
	}
];

const results = [];
for (const mutation of mutations) {
	// Mutation paths are relative to the package, which is what the copy mirrors.
	const path = join(work, COPY, mutation.file);
	const original = readFileSync(path, "utf8");
	const occurrences = original.split(mutation.find).length - 1;
	if (occurrences !== 1) throw new Error(`${mutation.name}: the anchor appears ${occurrences} times in ${mutation.file}`);
	writeFileSync(path, original.replace(mutation.find, mutation.replace), "utf8");

	const build = run(["tools/build-client.mjs"]);
	let caught = false;
	let detail = "";
	if (build.code !== 0) {
		caught = mutation.expectBuildFailure === true;
		detail = `build exit ${build.code}`;
	} else {
		if (mutation.expectBuildFailure === true) throw new Error(`${mutation.name}: the build still succeeded`);
		const suite = mutation.suite === "host" ? "tools/test-host-routes.mjs" : "tools/test-term-dictionary.mjs";
		const test = run([suite, "--filter", mutation.filter]);
		caught = test.code !== 0;
		const failing = test.out.split("\n").filter((line) => line.includes("FAIL")).map((line) => line.trim());
		detail = failing.length > 0 ? failing.slice(0, 2).join(" | ") : `test exit ${test.code}`;
	}
	results.push({ name: mutation.name, caught, detail });
	writeFileSync(path, original, "utf8");
}

// The copy must be back to byte-identical sources, so a mutation cannot have leaked.
const digest = (file) => createHash("sha1").update(readFileSync(join(work, COPY, file))).digest("hex").slice(0, 12);
const dirty = mutations.filter((mutation) => digest(mutation.file) !== createHash("sha1").update(readFileSync(join(pluginDir, mutation.file))).digest("hex").slice(0, 12));

const missed = results.filter((result) => !result.caught);
console.log("\nmutation checks\n");
for (const result of results) console.log(`  ${result.caught ? "caught  " : "MISSED  "} ${result.name}\n           ${result.detail}`);
console.log(`\n${results.length - missed.length}/${results.length} mutations caught`);
if (dirty.length > 0) console.log(`SOURCE DRIFT in: ${dirty.map((mutation) => mutation.file).join(", ")}`);
console.log(dirty.length === 0 ? "source tree unchanged (all checksums match)" : "a mutation leaked into the source tree");
// An exit code, because a harness whose failure does not fail the shell is one nobody reads.
if (!keep) rmSync(sandbox, { recursive: true, force: true });
process.exit(missed.length === 0 && dirty.length === 0 ? 0 : 1);
