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
		find: 'if (filter === "deleted") return dictionary.listDeleted(state, query);',
		replace: 'if (filter === "deleted") return listEntries(state, query, "all");',
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
		find: '["pinned", t("filterPinned")],\n\t\t\t\t["deleted", t("filterDeleted")]',
		replace: '["pinned", t("filterPinned")]',
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
		find: "showingDeleted\n\t\t\t\t? h(DeletedList,",
		replace: "false\n\t\t\t\t? h(DeletedList,",
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
		name: "the import page stops passing the opt-in to the plan",
		file: `lib/core/views.js`,
		find: "store.getState().deletedKeys ?? new Set(), { includeDeleted });",
		replace: "store.getState().deletedKeys ?? new Set());",
		filter: "transferImport"
	},
	{
		name: "the import report forgets the records the file could not use",
		file: `lib/core/views.js`,
		find: "duplicates: plan.duplicates + (parsed.skipped ?? 0)",
		replace: "duplicates: plan.duplicates",
		filter: "transferImport"
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
		const test = run(["tools/test-term-dictionary.mjs", "--filter", mutation.filter]);
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
