// Where things are.
//
// Every tool used to compute the plugin directory by hand — `resolve(here, "..", "dsh-plugin-term-dictionary")`
// — which made the layout load-bearing: moving `tools/` anywhere broke a dozen scripts, and the
// breakage showed up as "file not found" from whichever one ran first rather than as a layout
// problem. This resolves the package by its MANIFEST instead: walk up from this file until a
// `package.json` declaring `dsh.bundle` turns up. That is the definition of the thing the tools
// operate on, so it keeps working whether `tools/` sits inside the package, beside it, or in a
// checkout somewhere else entirely.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Whether a directory holds the plugin package. */
function isPluginRoot(directory) {
	const manifest = join(directory, 'package.json');
	if (!existsSync(manifest)) return false;
	try {
		const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
		return parsed?.dsh?.bundle?.patch !== undefined;
	} catch {
		// An unparseable manifest is a different failure, reported by whatever reads it next.
		return false;
	}
}

/** The plugin package directory, found by walking up from `tools/`. */
function findPluginDir() {
	let at = here;
	for (let depth = 0; depth < 6; depth++) {
		if (isPluginRoot(at)) return at;
		const parent = dirname(at);
		if (parent === at) break;
		at = parent;
	}
	throw new Error(`paths: no package.json declaring dsh.bundle above ${here}`);
}

export const pluginDir = findPluginDir();
/** The package root: these are the same thing now, and keeping both names documents that. */
export const repoRoot = pluginDir;
export const libDir = join(pluginDir, 'lib');
export const coreDir = join(libDir, 'core');
export const toolsDir = here;
/**
 * The directory that holds scratch state (`tools/` sits inside the package, so a `.tmp/` next to
 * `tools/` would be published by accident on the next `git add -A`). It is deliberately the
 * package's parent: scratch belongs to the checkout, not to the package.
 */
export const scratchDir = join(dirname(pluginDir), '.tmp');
