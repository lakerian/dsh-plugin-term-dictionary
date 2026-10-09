// Compare the client row the running host serves against the artifact on disk.
// A row can be served at a matching rev yet differ from the file (the host may wrap
// it), so this reports the real difference instead of assuming.
//
//   node tools/compare-served-client.mjs "<the URL verify-plugin-row.mjs printed>"
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { libDir } from "./paths.mjs";

const artifact = join(libDir, "client.js");
const url = process.argv[2];
const local = readFileSync(artifact, "utf8");
const served = await (await fetch(url, { signal: AbortSignal.timeout(30000) })).text();

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
console.log(`local  len=${local.length} sha=${sha(local)}`);
console.log(`served len=${served.length} sha=${sha(served)}`);
console.log(`identical: ${local === served}`);

// Where do they first diverge?
const max = Math.min(local.length, served.length);
let at = 0;
while (at < max && local[at] === served[at]) at++;
console.log(`first divergence at ${at} (of ${max})`);
if (at < max) {
	console.log(`  local  : ${JSON.stringify(local.slice(Math.max(0, at - 40), at + 60))}`);
	console.log(`  served : ${JSON.stringify(served.slice(Math.max(0, at - 40), at + 60))}`);
}
console.log(`local  ends: ${JSON.stringify(local.slice(-80))}`);
console.log(`served ends: ${JSON.stringify(served.slice(-80))}`);
