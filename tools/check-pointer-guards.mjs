// Mutation harness for the pointer-capture guards.
//
// Why it exists: a green check says only that the check did not fire, and a check that cannot fire
// is worth nothing. Every claim the pointer work rests on therefore gets a deliberate break, in a
// throwaway copy of the tree, and has to turn the check that claims to guard it RED. A mutation
// that changes nothing observable is reported as an escape — a finding about the guards, not about
// the plugin.
//
// The source tree is never written to. Each run copies `tools/` and `dsh-plugin-term-dictionary/`
// into `.tmp/pointer-guards/<id>`, mutates the copy, rebuilds the bundle inside the copy, and runs
// both suites there. Checksums of every source file are taken before and re-taken after.
//
// The breaks themselves are listed in `pointer-mutations.mjs`.
//
// Usage:
//   node tools/check-pointer-guards.mjs [--only <id>] [--keep]

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MUTATIONS } from "./pointer-mutations.mjs";
import { pluginDir, toolsDir, scratchDir } from "./paths.mjs";

const here = toolsDir;
const scratchRoot = join(scratchDir, "pointer-guards");
/**
 * Where the copy of the package goes inside each mutation's scratch directory.
 *
 * `tools/` lives inside the package now, so one recursive copy is a whole checkout — and the tools
 * inside it resolve the package the same way they do here, by walking up for `dsh.bundle`.
 */
const COPY = "pkg";

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > 0 ? process.argv[onlyArg + 1] : "";
const keep = process.argv.includes("--keep");

/** Files a run must leave byte-identical. */
const LOCKED = [
	join(pluginDir, "lib", "core", "interact.js"),
	join(pluginDir, "lib", "core", "shell.js"),
	join(pluginDir, "lib", "client.template.js"),
	join(here, "test-interaction.mjs"),
	join(here, "test-term-dictionary.mjs"),
	join(here, "check-pointer-guards.mjs"),
	join(here, "pointer-mutations.mjs")
];

/** Short SHA-1 of a file's contents. */
function digest(path) {
	return createHash("sha1").update(readFileSync(path)).digest("hex").slice(0, 12);
}

/** The checks a suite reported as failing, by name. */
function failedChecks(output) {
	return [...String(output).matchAll(/^ {2}FAIL (.+)$/gmu)].map((match) => match[1].trim());
}

/** The suites whose check names a mutation may name. */
const SUITES = [join(here, "test-term-dictionary.mjs"), join(here, "test-interaction.mjs")];

/**
 * Whether the check a mutation names still exists at all.
 *
 * The distinction this makes is the difference between two very different reports. A mutation whose
 * NAMED CHECK IS GONE is a stale entry in `pointer-mutations.mjs` — the harness is describing a guard
 * that was deleted, and it needs retargeting or dropping. A mutation whose check EXISTS but did not
 * fire is a finding about the plugin: the guard is vacuous. Reading "no check fired" for both is how
 * fourteen stale entries can sit in a red harness without anyone knowing which half is which.
 *
 * @param name - the guard name the mutation expects.
 * @returns true when some suite still defines a check with that name.
 */
function guardExists(name) {
	return SUITES.some((path) => readFileSync(path, "utf8").includes(name));
}

/**
 * Run one script and return its output whether or not it exited zero: a failing suite is the
 * expected outcome of a mutation that bit.
 */
function run(script, cwd) {
	try {
		return { output: execFileSync(process.execPath, [script], { cwd, encoding: "utf8", maxBuffer: 67108864, timeout: 240000 }), code: 0 };
	} catch (error) {
		const seen = `${error.stdout ?? ""}${error.stderr ?? ""}`;
		return { output: seen === "" ? String(error) : seen, code: error.status ?? 1 };
	}
}

/** Rebuild the bundle in the copy, then run both suites there. */
function evaluate(copyDir) {
	const pkg = join(copyDir, COPY);
	const build = run(join(pkg, "tools", "build-client.mjs"), pkg);
	if (build.code !== 0) return { broken: `build failed: ${build.output.slice(0, 300)}`, fails: [] };
	const output = ["test-term-dictionary.mjs", "test-interaction.mjs"].map((name) => run(join(pkg, "tools", name), pkg).output).join("\n");
	return { broken: null, fails: failedChecks(output) };
}

/** Copy the package — `tools/` included — into a fresh scratch tree. */
function prepare(id) {
	const copyDir = join(scratchRoot, id);
	rmSync(copyDir, { recursive: true, force: true });
	mkdirSync(copyDir, { recursive: true });
	cpSync(pluginDir, join(copyDir, COPY), { recursive: true });
	return copyDir;
}

/** Apply one break to its file in the copy, or say why it could not be applied. */
function applyTo(mutation, copyDir) {
	const source = readFileSync(mutation.file, "utf8");
	const hits = source.split(mutation.find).length - 1;
	if (hits !== 1) return hits === 0 ? "the line it rewrites is gone" : `${hits} matches, so it is not anchored`;
	const relative = mutation.file.slice(pluginDir.length + 1).split("\\").join("/");
	writeFileSync(join(copyDir, COPY, relative), source.replace(mutation.find, mutation.replace));
	return null;
}

const before = LOCKED.map(digest);
mkdirSync(scratchRoot, { recursive: true });
console.log(`pointer-guard mutations: ${MUTATIONS.length} deliberate breaks, each in its own copy of the tree\n`);

const results = [];
for (const mutation of MUTATIONS) {
	if (only !== "" && mutation.id !== only && !mutation.claim.includes(only)) continue;
	if (!existsSync(mutation.file)) {
		results.push({ mutation, verdict: "NO-FILE", detail: mutation.file, others: [] });
		continue;
	}
	const copyDir = prepare(mutation.id);
	const refusal = applyTo(mutation, copyDir);
	if (refusal !== null) {
		results.push({ mutation, verdict: "NOT-APPLIED", detail: refusal, others: [] });
	} else {
		const { broken, fails } = evaluate(copyDir);
		if (broken !== null) {
			results.push({ mutation, verdict: "BUILD-FAIL", detail: broken, others: [] });
		} else {
			const hit = fails.find((name) => name.includes(mutation.expect));
			// Three distinct outcomes, kept apart on purpose: the named check went red (the mutation
			// bit), the named check no longer exists (this entry is stale), or it exists and stayed
			// green (the guard is vacuous).
			const stale = hit === undefined && !guardExists(mutation.expect);
			results.push({
				mutation,
				verdict: hit !== undefined ? "BIT" : stale ? "STALE" : fails.length === 0 ? "ESCAPED" : "MISS",
				detail: hit ?? (stale ? "the check it names is no longer in either suite" : fails.length === 0 ? "no check fired" : `fired elsewhere: ${fails.join(" | ")}`),
				others: fails.filter((name) => name !== hit)
			});
		}
	}
	if (!keep) rmSync(copyDir, { recursive: true, force: true });
	console.log(`  ${results[results.length - 1].verdict} ${mutation.id}`);
}

console.log("");
for (const { mutation, verdict, detail, others } of results) {
	console.log(`${verdict.padEnd(13)} ${mutation.id}  ${mutation.claim}`);
	console.log(`        guard   : ${mutation.expect}`);
	console.log(`        saw     : ${detail}`);
	if (others.length > 0) console.log(`        also red: ${others.join(" | ")}`);
}

const misses = results.filter((result) => result.verdict !== "BIT");
const stale = results.filter((result) => result.verdict === "STALE");
const damaged = LOCKED.filter((path, index) => digest(path) !== before[index]);
console.log(`\n${results.length} mutations: ${results.length - misses.length} bit, ${misses.length} did not (${stale.length} of them naming a check that no longer exists)`);
console.log(damaged.length === 0 ? "source tree unchanged (all checksums match)" : `SOURCE CHANGED: ${damaged.join(", ")}`);
if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
process.exit(misses.length === 0 && damaged.length === 0 ? 0 : 1);
