// Builds the browser half of the term dictionary plugin.
//
// Why a build step exists at all: the host's client module table hands a bundle a
// synchronous `require` that resolves ONLY platform seed words (react, and the
// static UI libraries) and already-registered package factories. A relative
// `require("./core.js")` therefore throws at runtime, and `require.async` only
// fetches files matching the `client.<name>.js` chunk convention. A plugin that
// wants testable CommonJS modules in Node must therefore inline them into the one
// bundle it ships.
//
// The generated bundle keeps the sources' own `require("./x.js")` calls working by
// installing a tiny local module registry that shadows the platform `require` for
// relative specifiers and forwards everything else to the platform one.
//
// Usage:
//   node tools/build-client.mjs [--check]
//
// `--check` verifies that lib/client.js is up to date and exits 1 when it is not.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { pluginDir } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** The CommonJS sources, kept under their own `"type": "commonjs"` scope. */
const libDir = join(pluginDir, "lib", "core");

/** Modules inlined into the bundle, in dependency order (order is not significant). */
const MODULES = [
	"core.js",
	"copy.js",
	"entries.js",
	"dictionary.js",
	"terms.js",
	"stopwords.js",
	"lexicon.en.js",
	"lexicon.zh.js",
	"store.js",
	"settings.js",
	"transfer.js",
	"api.js",
	"interact.js",
	"highlight.js",
	"hover.js",
	"hovercard.js",
	"bus.js",
	"styles.js",
	"views.js",
	"overlay.js",
	"shell.js"
];

/**
 * Data modules that may legitimately be absent before their authoring pass lands.
 * The shell already degrades without them, so a missing file is reported rather
 * than treated as a broken build.
 */
const OPTIONAL = new Set(["stopwords.js", "lexicon.en.js", "lexicon.zh.js"]);

const TEMPLATE = join(pluginDir, "lib", "client.template.js");
const OUTPUT = join(pluginDir, "lib", "client.js");

/** Read one source file, failing loudly with the path. */
function read(path) {
	if (!existsSync(path)) throw new Error(`build-client: missing source ${path}`);
	return readFileSync(path, "utf8");
}

/** Platform seed words the browser module table provides; everything else must be a sibling. */
const PLATFORM_SEEDS = new Set(["react", "react/jsx-runtime", "react-dom"]);

/**
 * Whether a source is safe to concatenate: it must be a CommonJS module and must
 * only require relative siblings or a known platform seed.
 * @param name - the module's file name.
 * @param text - the source text.
 */
function assertModuleShape(name, text) {
	if (!/module\.exports\s*=|exports\.[A-Za-z_$]/.test(text)) throw new Error(`build-client: ${name} exports nothing`);
	// The ESM check runs on the code with comments removed. Testing the raw text means a
	// doc comment containing a word like "bulk-import" trips the `\bimport\s` pattern —
	// which is how a prose comment once broke the build. Comments cannot execute, so they
	// are not evidence of ESM syntax.
	if (/\bimport\s|\bexport\s+(default|const|function|\{)/.test(stripComments(text))) {
		throw new Error(`build-client: ${name} uses ESM syntax and cannot be inlined`);
	}
	for (const match of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
		const spec = match[1];
		if (spec.startsWith("./") || spec.startsWith("../")) continue;
		if (PLATFORM_SEEDS.has(spec)) continue;
		throw new Error(`build-client: ${name} requires "${spec}" — not a relative sibling and not a platform seed the module table provides`);
	}
}

/**
 * Remove comments and literal text so a syntax check sees only code.
 *
 * This is a scanner rather than a set of regexes on purpose: a regex-based strip would
 * mangle a `//` inside a string literal, and getting that wrong is worse than the bug
 * being fixed. A `/*` inside a string is not a comment.
 *
 * Literal CONTENTS are blanked as well as comments, keeping only their shape so line
 * numbers still line up. A word inside a string cannot be syntax, and this plugin's copy
 * is about importing: the English hint "collection and import leave them alone" tripped
 * the `\bimport\s` pattern and stopped the build on a string that was doing its job. That
 * is the same false positive the comment-stripping above was added for, one channel over.
 *
 * @param text - the source text.
 * @returns the same text with comments and literal bodies replaced by spaces.
 */
function stripComments(text) {
	let out = "";
	let at = 0;
	let quote = null;
	while (at < text.length) {
		const character = text[at];
		const next = text[at + 1];
		if (quote !== null) {
			// An escape skips its escaped character, so `\"` cannot end the literal.
			if (character === "\\") {
				out += "  ";
				at += 2;
				continue;
			}
			if (character === quote) {
				quote = null;
				out += character;
				at++;
				continue;
			}
			out += character === "\n" ? "\n" : " ";
			at++;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			out += character;
			at++;
			continue;
		}
		if (character === "/" && next === "/") {
			while (at < text.length && text[at] !== "\n") at++;
			continue;
		}
		if (character === "/" && next === "*") {
			at += 2;
			while (at < text.length && !(text[at] === "*" && text[at + 1] === "/")) {
				// A newline is kept so line numbers in later errors still line up.
				if (text[at] === "\n") out += "\n";
				at++;
			}
			at += 2;
			continue;
		}
		out += character;
		at++;
	}
	return out;
}

/** Wrap one module in the registry factory. */
function wrap(name, text) {
	const indented = text
		.split("\n")
		.map((line) => (line === "" ? "" : `\t\t\t${line}`))
		.join("\n");
	return `\t\t__termDictionaryModules[${JSON.stringify(`./${name}`)}] = (module, exports, require) => {\n${indented}\n\t\t};`;
}

/** Build the registry source block. */
function buildRegistry() {
	const skipped = [];
	const blocks = [];
	for (const name of MODULES) {
		if (!existsSync(join(libDir, name))) {
			if (!OPTIONAL.has(name)) throw new Error(`build-client: missing source ${join(libDir, name)}`);
			skipped.push(name);
			continue;
		}
		const text = read(join(libDir, name));
		assertModuleShape(name, text);
		blocks.push(wrap(name, text));
	}
	if (skipped.length > 0) console.warn(`build-client: optional data modules absent, detector coverage reduced: ${skipped.join(", ")}`);
	return blocks.join("\n\n");
}

/** Assemble the whole bundle. */
function build() {
	const template = read(TEMPLATE);
	if (!template.includes("/*__MODULES__*/")) throw new Error("build-client: template is missing the /*__MODULES__*/ marker");
	const registry = buildRegistry();
	const prelude = [
		"\t\t/** The inlined CommonJS core: one factory per source file. */",
		"\t\tconst __termDictionaryModules = Object.create(null);",
		"",
		registry,
		"",
		"\t\t/** Specifiers already materialized, so a module body runs once. */",
		"\t\tconst __termDictionaryCache = Object.create(null);",
		"",
		"\t\t/**",
		"\t\t * Resolve a relative sibling from the registry, everything else from the",
		"\t\t * platform table. This is what keeps the sources' own require() calls intact.",
		"\t\t */",
		"\t\tconst __termDictionaryRequire = (spec) => {",
		"\t\t\tif (typeof spec !== \"string\" || !spec.startsWith(\".\")) return require(spec);",
		"\t\t\tconst record = __termDictionaryCache[spec];",
		"\t\t\tif (record !== undefined) return record.exports;",
		"\t\t\tconst factory = __termDictionaryModules[spec];",
		"\t\t\tif (factory === undefined) throw new Error(`client-modules: inlined core is missing ${JSON.stringify(spec)}`);",
		"\t\t\tconst module = { exports: {} };",
		"\t\t\t__termDictionaryCache[spec] = module;",
		"\t\t\ttry {",
		"\t\t\t\tfactory(module, module.exports, __termDictionaryRequire);",
		"\t\t\t} catch (error) {",
		"\t\t\t\tdelete __termDictionaryCache[spec];",
		"\t\t\t\tthrow error;",
		"\t\t\t}",
		"\t\t\treturn module.exports;",
		"\t\t};"
	].join("\n");
	const body = template.replace("/*__MODULES__*/", `${prelude}`);
	return `${body.trimEnd()}\n`;
}

/** Parse-check the generated bundle without running its side effects. */
function syntaxCheck(source) {
	new vm.Script(source, { filename: OUTPUT });
}

const checkOnly = process.argv.includes("--check");
const generated = build();
syntaxCheck(generated);
// `generated.length` counts UTF-16 code units, not the bytes that land on disk;
// the lexicons are largely Chinese, so the two differ by a wide margin and
// reporting the wrong one makes an unchanged bundle look like a changed file.
const onDiskBytes = Buffer.byteLength(generated, "utf8");

if (checkOnly) {
	const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
	if (current !== generated) {
		console.error("build-client: lib/client.js is out of date — run `node tools/build-client.mjs`");
		process.exit(1);
	}
	console.log(`build-client: lib/client.js is up to date (${onDiskBytes} bytes on disk, ${MODULES.length} modules)`);
} else {
	writeFileSync(OUTPUT, generated, "utf8");
	console.log(`build-client: wrote ${OUTPUT} (${onDiskBytes} bytes on disk, ${generated.length} code units, ${MODULES.length} modules)`);
}
