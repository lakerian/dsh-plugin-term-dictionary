#!/usr/bin/env node

/**
 * Turn a directory of pack files into the index a source URL serves.
 *
 * Why this is a script rather than a feature of the page: publishing is a git action. The packs and
 * the index are files in a repository, the checksums have to be of the bytes that repository serves,
 * and the address in the index has to be the one the file will actually be fetched from. That is a
 * build step, and a build step belongs next to the code that is built.
 *
 * Usage
 * -----
 *
 *   node tools/make-pack-index.mjs --base <url of the directory> [--dir packs] [--check]
 *
 * `--base` is the URL the directory is served from, ending in `/`. For a GitHub repository the
 * jsDelivr form is what to use — static, cacheable, and reachable where githubusercontent is not:
 *
 *   --base https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/packs/
 *
 * It must be https: the same rule the plugin applies before it fetches anything
 * (`lib/core/pack.js`'s `refuseUrl`) runs here too, so an index can never be published containing a
 * pack URL the plugin would refuse — a mistake that would only show up in somebody else's panel.
 *
 * The workflow it is one half of:
 *
 *   1. in the panel's 「词条包」 page, build a pack and download it;
 *   2. put the file in `packs/` and commit it;
 *   3. run this script (it writes `packs/index.json`) and commit that;
 *   4. paste `<base>index.json` into the panel's source list — that is the source.
 *
 * The pack's own `id` is what the panel keys a row by, so two files claiming the same id is reported
 * as an error: nothing downstream could tell which row a click meant.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { pluginDir } from "./paths.mjs";

const require = createRequire(import.meta.url);
const pack = require(join(pluginDir, "lib", "core", "pack.js"));

/** Read `--name value` pairs and `--flag` booleans. */
function readArgs(argv) {
	const args = { base: "", dir: "", check: false, help: false };
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--check") args.check = true;
		else if (token === "--help" || token === "-h") args.help = true;
		else if (token === "--base") args.base = argv[++index] ?? "";
		else if (token === "--dir") args.dir = argv[++index] ?? "";
		else throw new Error(`unknown argument ${token}`);
	}
	return args;
}

const USAGE = [
	"usage: node tools/make-pack-index.mjs --base <https url of the directory> [--dir packs] [--check]",
	"",
	"  --base   where the directory will be served from, ending in `/`",
	"           e.g. https://cdn.jsdelivr.net/gh/lakerian/dsh-plugin-term-dictionary@main/packs/",
	"  --dir    the directory holding the pack files (default: <package>/packs)",
	"  --check  write nothing; fail if index.json is not what this run would produce"
].join("\n");

/**
 * The SHA-256 of a file's bytes.
 *
 * Of the BYTES, not of a re-serialised pack: the host compares the digest against what it downloaded,
 * so a checksum computed from anything else would fail for every consumer.
 *
 * @param text - the file's text.
 * @returns the digest, lowercase hex.
 */
function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stop with a message and a non-zero exit code. */
function fail(message) {
	console.error(`make-pack-index: ${message}`);
	process.exit(1);
}

const args = readArgs(process.argv.slice(2));
if (args.help) {
	console.log(USAGE);
	process.exit(0);
}

const base = args.base.trim();
if (base === "") fail(`--base is required\n\n${USAGE}`);
if (!base.endsWith("/")) fail("--base must end in `/`");
const refusal = pack.refuseUrl(`${base}index.json`);
if (refusal !== null) fail(`--base is not usable as a source: ${refusal} (only https, no credentials)`);

const dir = args.dir.trim() === "" ? join(pluginDir, "packs") : args.dir.trim();
if (!existsSync(dir)) fail(`no such directory: ${dir}`);

const files = readdirSync(dir)
	.filter((name) => name.endsWith(".json") && name !== "index.json")
	.sort();
if (files.length === 0) fail(`${dir} holds no *.json pack files`);

const listed = [];
const problems = [];
const seen = new Map();
let total = 0;
let newest = 0;
for (const name of files) {
	const path = join(dir, name);
	const text = readFileSync(path, "utf8");
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		problems.push(`${name}: not JSON (${error instanceof Error ? error.message : String(error)})`);
		continue;
	}
	const parsed = pack.parsePack(raw);
	if (parsed.ok !== true) {
		// Named, not silently skipped: a file in `packs/` that is not a pack is a mistake somebody made,
		// and the pack format says exactly which mistake it was.
		problems.push(`${name}: ${parsed.error}`);
		continue;
	}
	const value = parsed.pack;
	if (seen.has(value.id)) {
		problems.push(`${name}: id "${value.id}" is already used by ${seen.get(value.id)}`);
		continue;
	}
	seen.set(value.id, name);
	const summary = pack.summarizePack(value);
	total += summary.count;
	newest = Math.max(newest, value.createdAt ?? 0);
	listed.push({
		id: value.id,
		name: value.name,
		description: value.description,
		author: value.author,
		license: value.license,
		domains: summary.domains.map((entry) => entry.domain),
		count: summary.count,
		sha256: sha256(text),
		url: `${base}${encodeURIComponent(basename(name))}`
	});
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`  skipped ${problem}`);
	fail(`${problems.length} of ${files.length} files could not be listed`);
}

// Through the same builder the plugin's own index reader validates against, so a generator bug and a
// reader bug cannot cancel each other out.
//
// `updatedAt` is the newest pack in the directory rather than the moment this ran: the index is a
// build product, and a timestamp that changes on every run would make `--check` fail forever and every
// commit differ for no reason. As the newest pack it means something — "this is how fresh the content
// is" — and it only moves when the content does.
const index = pack.buildIndex(listed, { now: newest });
const text = `${JSON.stringify(index, null, 2)}\n`;
const target = join(dir, "index.json");

if (args.check) {
	const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
	if (existing !== text) {
		// A stale index is worse than a missing one: the panel would list packs whose checksums no
		// longer match the files, and every preview would fail the digest check.
		fail("index.json is not what this run would write — regenerate it and commit the result");
	}
	console.log(`make-pack-index: index.json is current (${index.count} packs, ${total} entries)`);
	process.exit(0);
}

writeFileSync(target, text, "utf8");
console.log(`make-pack-index: wrote ${target}`);
for (const entry of index.packs) {
	console.log(`  ${entry.name}  ${entry.count} entries  sha256 ${entry.sha256.slice(0, 12)}…  ${entry.url}`);
}
console.log(`\n${index.count} packs, ${total} entries. Paste this as a source in the panel:\n  ${base}index.json`);
