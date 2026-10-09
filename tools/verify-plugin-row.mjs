// Verify the running DSH host serves a plugin's client row.
//
// The host's client-modules registry derives a revision from the artifact's stat and
// serves the bundle at /plugins/??<package>/client.js&rev=<rev>. Recomputing that
// revision here and getting the file back is proof that THIS plugin's browser half is
// in the running host's client graph — not merely that a file exists on disk.
//
//   rev = sha1("plugin-artifact" + NUL + framed(mtimeMs, ctimeMs, size)).slice(0,12)
//
// Usage: node tools/verify-plugin-row.mjs <package-name> [expected-substring ...]
import { statSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The profile this checkout is developed against, overridable so the tool works on another machine
// or another profile without editing it — a published repo should not carry somebody's home path.
const PROFILE_MODULES = process.env.DSH_PROFILE_MODULES ?? join(homedir(), ".dsh", "profiles", "desktop", "node_modules");
const BASE = process.env.DSH_BASE_URL ?? "http://127.0.0.1:19387";

const packageName = process.argv[2];
if (packageName === undefined) {
	console.error("usage: node tools/verify-plugin-row.mjs <package-name> [expected-substring ...]");
	process.exit(2);
}
const expected = process.argv.slice(3);

/** Frame one hash input the way the host's registry does. */
function framedHash(domain, parts) {
	const hash = createHash("sha1").update(domain).update("\0");
	for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
	return hash.digest("hex").slice(0, 12);
}

// Resolve the installed package through the profile, so a `link:` dependency is
// followed to its real directory instead of being guessed.
const packageDir = realpathSync(join(PROFILE_MODULES, ...packageName.split("/")));
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const clientEntry = manifest.exports?.["./client"];
const clientPath = typeof clientEntry === "string" ? clientEntry : clientEntry?.default;
if (typeof clientPath !== "string") {
	console.error(`${packageName} does not export "./client" — it has no browser half to serve`);
	process.exit(1);
}
const artifact = resolve(packageDir, clientPath);

const stat = statSync(artifact);
const rev = framedHash("plugin-artifact", [String(stat.mtimeMs), String(stat.ctimeMs), String(stat.size)]);
console.log(`package  : ${packageName}`);
console.log(`artifact : ${artifact}`);
console.log(`size     : ${stat.size}`);
console.log(`row rev  : ${rev}`);

// Both framings the registry may use for a package's client artifact: the
// `??pkg/client.js` form (a client-only bundle) and the plain `pkg/client.js` form.
const urls = [
	`${BASE}/plugins/??${packageName}/client.js&rev=${rev}`,
	`${BASE}/plugins/${packageName}/client.js?rev=${rev}`
];
let ok = false;
for (const url of urls) {
	let response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(30000) });
	} catch (error) {
		console.log(`GET ${url}\n  request failed: ${error.message}`);
		continue;
	}
	const body = await response.text();
	console.log(`GET ${url}`);
	console.log(`  status   : ${response.status} ${response.headers.get("content-type")} bytes=${body.length}`);
	if (response.status !== 200 || body.length === 0) continue;
	const markers = [`__ModuleLoader__.load`, packageName, ...expected];
	const missing = markers.filter((marker) => !body.includes(marker));
	for (const marker of markers) console.log(`  contains ${JSON.stringify(marker)}: ${!missing.includes(marker)}`);
	if (missing.length === 0) ok = true;
}
console.log(ok ? "\nOK: the running host serves this plugin's client row" : "\nFAIL: no framing returned the bundle with every marker");
// `process.exit()` here aborts a Node/undici teardown race on Windows
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), which turns a
// successful check into a crash exit code. Setting the code lets the loop drain.
process.exitCode = ok ? 0 : 1;
