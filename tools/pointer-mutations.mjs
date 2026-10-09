// Mutation list for `tools/check-pointer-guards.mjs`.
//
// Each entry is one deliberate break of a claim the pointer-capture work rests on, plus the check
// that is supposed to go red because of it. `find` must match its file exactly once: a mutation
// that no longer applies is reported rather than counted as a pass, because a break that quietly
// stopped landing is the same silent-green failure the guards themselves are for.
//
// Paths are absolute so the harness can read the source, mutate a copy of it, and leave the tree
// untouched.
//
// The IDs are stable, and there are gaps: M5, M6, M7, M15 and M20 were RETIRED on 2026-10-10, when
// the two plugins were merged and the entries below were re-pointed at the guards that survive. Their
// claims were about machinery the merge deleted, not about behaviour that was dropped by accident —
// each retirement is recorded where the entry used to be, so the next reader does not have to guess
// whether a missing break means "nothing to break" or "somebody deleted the line".

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginDir, coreDir } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = pluginDir;

/** Join lines the way the sources are indented — with tabs, one per line. */
export function lines(items) {
	return items.join("\n");
}

export const MUTATIONS = [
	{
		id: "M1",
		claim: "the pointermove listener is registered in the capture phase",
		// Retargeted on 2026-10-09, when the two plugins were merged: the movement listener moved out
		// of `interact.js` and into `hover.js`, so the old anchor stopped landing while the CLAIM and
		// its guard both stayed true. The guard is the bundle-level phase check, which sees both files.
		file: join(coreDir, "hover.js"),
		find: 'doc.addEventListener("pointermove", onPointerMove, true);',
		replace: 'doc.addEventListener("pointermove", onPointerMove);',
		expect: "bundle: the pointer layer is wired in the capture phase"
	},
	{
		id: "M2",
		claim: "the click listener is registered in the capture phase",
		// The anchor still lands; the guard it NAMED was retired with the merge, so the expectation
		// was repointed at the check that now asserts the same thing. That check had to be repaired
		// first: it asserted the listener TYPES while its name promised the phase, so this mutation
		// escaped it — a guard that cannot see the fact it is named for.
		file: join(coreDir, "interact.js"),
		find: 'listen(doc, "click", onClick, true);',
		replace: 'listen(doc, "click", onClick);',
		expect: "bundle: the pointer layer is wired in the capture phase"
	},
	{
		id: "M3",
		claim: "the region selector names the chat value, so the composer seat is never adopted",
		file: join(coreDir, "interact.js"),
		find: 'const REGION_SELECTOR = \'[data-conversation-region="chat"]\';',
		replace: 'const REGION_SELECTOR = "[data-conversation-region]";',
		// Re-pointed on 2026-10-10 at the check that now guards the selector's VALUE. The old expectation
		// named a hover-gate check that the merge retired with the hover layer.
		expect: "locate: the region selector names the chat value, so the composer seat is never adopted"
	},
	{
		id: "M4",
		claim: "a pointer over a body the layer never found adopts that body",
		file: join(coreDir, "interact.js"),
		find: '\t\tconst chat = typeof element?.closest === "function" ? element.closest(REGION_SELECTOR) : null;',
		replace: "\t\tconst chat = null;",
		// The adopt path is the CLICK path's now (the hover layer has its own document lookup), so the
		// check that guards it is the click one.
		expect: "click: the body a click happened in is adopted even when the layer never found it"
	},
	// RETIRED M5 — "a pointer refused for being outside the conversation says so". The rejection report
	// it rewrote (`report("rejected", …)`) had no call site left after the merge: the gate it described
	// belonged to the hover layer, which now lives in `hover.js` and reports nothing. The dead
	// `rejectionRecord` it built was removed with this retirement.
	// RETIRED M6 — "clicks are bounded by their own budget, not by the hovers". There is no hover
	// budget any more: `report("rejected", …)` was the only caller of the second budget, so the only
	// remaining report IS the click one and there is nothing for it to compete with.
	// RETIRED M7 — "the rejection record carries the same chat count the heartbeat reports". The record
	// it rewrote no longer exists (see M5); the count itself is still live and still reported, through
	// `regionCount()` in the beacon payload.
	{
		id: "M8",
		claim: "the settled pass is armed whenever a region exists, not only with a scroll root",
		file: join(coreDir, "interact.js"),
		find: lines([
			'\t\tif (scrollRoot !== null && typeof win?.MutationObserver === "function") {',
			"\t\t\tobserver = new win.MutationObserver(() => scheduleSettle());",
			"\t\t\tobserver.observe(scrollRoot, { childList: true, subtree: true, characterData: true });",
			"\t\t}",
			"\t\tif (region !== null) {",
			"\t\t\trefreshSnapshot();",
			"\t\t\tscheduleSettle();",
			"\t\t}"
		]),
		replace: lines([
			'\t\tif (scrollRoot !== null && typeof win?.MutationObserver === "function") {',
			"\t\t\tobserver = new win.MutationObserver(() => scheduleSettle());",
			"\t\t\tobserver.observe(scrollRoot, { childList: true, subtree: true, characterData: true });",
			"\t\t\trefreshSnapshot();",
			"\t\t}"
		]),
		expect: "locate: a region with no scroll root still arms the settled pass"
	},
	{
		id: "M9",
		claim: "the poll re-arms the settled pass when no observer exists",
		file: join(coreDir, "interact.js"),
		find: "\t\t\t\t\tif (region !== null && observer === null) scheduleSettle();",
		replace: "\t\t\t\t\t// mutant: the poll re-arms nothing",
		expect: "locate: the poll keeps re-arming the settled pass without an observer"
	},
	{
		id: "M10",
		claim: "a press outside the plugin's own surfaces dismisses the explanation card",
		file: join(coreDir, "interact.js"),
		find: "if (onPressOutside !== null && !isOwnSurface(event.target)) onPressOutside();",
		replace: "if (onPressOutside !== null && false) onPressOutside();",
		expect: "pointer: a press outside the plugin's own surfaces dismisses the explanation card"
	},
	{
		id: "M11",
		claim: "the dismissal tests every own surface, not only the selection affordance",
		file: join(coreDir, "interact.js"),
		find: "if (onPressOutside !== null && !isOwnSurface(event.target)) onPressOutside();",
		replace: "if (onPressOutside !== null && !isOwnAffordance(event.target)) onPressOutside();",
		expect: "pointer: a press outside the plugin's own surfaces dismisses the explanation card"
	},
	{
		id: "M12",
		claim: "the beacon's limit is the entry store's own limit",
		file: join(coreDir, "shell.js"),
		find: "const MAX_BEACON_CHARS = MAX_CONTEXT_CHARS - 20;",
		replace: "const MAX_BEACON_CHARS = MAX_CONTEXT_CHARS + 400;",
		expect: "beacon: an oversized report names what it dropped instead of being cut"
	},
	{
		id: "M13",
		claim: "a trimmed report declares what it removed",
		file: join(coreDir, "shell.js"),
		find: lines([
			"\t\tdelete payload[key];",
			"\t\tpayload.dropped.push(key);",
			"\t\tif (render().length <= MAX_BEACON_CHARS) return render();",
			"\t}",
			"\t// Whatever a later report bolted on that the drop list does not name."
		]),
		replace: lines([
			"\t\tdelete payload[key];",
			"\t\tif (render().length <= MAX_BEACON_CHARS) return render();",
			"\t}",
			"\t// Whatever a later report bolted on that the drop list does not name."
		]),
		expect: "beacon: an oversized report names what it dropped instead of being cut"
	},
	{
		id: "M14",
		claim: "the transcript count a report carries is never trimmed away",
		file: join(coreDir, "shell.js"),
		find: lines(['\t"chats",', '\t"blocks",']),
		replace: '\t"chats",',
		// Only the unit case can see this. In a live report the drop order gives up `probe` and
		// the payload fits, so the second pass — the one that consults the keep set — never runs.
		expect: "beacon: an oversized report names what it dropped instead of being cut"
	},
	// RETIRED M15 — "the beacon reads the settled transcript through a name it actually requires". The
	// require (`readRegion`) is still there and still live, but its only observable was a report filed
	// into the dictionary, and reports are console-only now: the beacon's `blocks` field is the sole
	// trace, and reaching it needs a fixture with a mounted transcript that the bundle-level sandbox
	// does not build. `readRegion` itself is guarded in the interaction suite ("the composer is never
	// read as a message"), so what is unguarded here is one require, not the function.
	{
		id: "M16",
		claim: "a report is fitted before it is sent",
		file: join(coreDir, "shell.js"),
		find: "\t\t\ttext = fitBeacon(payload);",
		replace: "\t\t\ttext = JSON.stringify(payload);",
		// The report is console-only, so the check that guards the call site reads the console: an
		// unfitted report has no `dropped`, which is what the fitter adds.
		expect: "beacon: the report that reaches the console is the fitted one, and it names the stage"
	},
	{
		id: "M17",
		claim: "a hit-test refusal is counted under the stage that produced it",
		file: join(coreDir, "interact.js"),
		find: "\t\thitStages[reason] = (hitStages[reason] ?? 0) + 1;",
		replace: "\t\tvoid reason;",
		expect: "click: a refusal is counted under the stage that produced it"
	},
	{
		id: "M18",
		claim: "a resolved hit is counted, so a tally reads as a fraction rather than a list of failures",
		file: join(coreDir, "interact.js"),
		find: "\t\thitStages.ok++;",
		replace: "\t\tvoid hit;",
		// This one always bit the click check; only its expectation was stale.
		expect: "click: the hit-stage tally names the stage a click resolved at"
	},
	{
		id: "M19",
		claim: "the stage tally is readable from outside the layer",
		file: join(coreDir, "interact.js"),
		find: "\t\t\t\thitStages: { ...hitStages },",
		replace: "",
		expect: "click: the hit-stage tally names the stage a click resolved at"
	},
	// RETIRED M20 — "a word that resolved but has no entry is counted apart from a geometric refusal".
	// The stage it removed (`refuse("not-known")`) no longer exists: a resolved word with no entry is a
	// route to the popup, not a refusal, and it is counted as neither. The stages that remain are the
	// ones `refuse(...)` is called with.
	{
		id: "M21",
		claim: "a report carries the refusing stage",
		file: join(coreDir, "shell.js"),
		find: "\t\t\t\ttrace: topStage(stats.hitStages),",
		replace: "",
		expect: "beacon: the report that reaches the console is the fitted one, and it names the stage"
	},
	{
		id: "M22",
		claim: "the refusing stage survives a trim that has to drop something",
		file: join(coreDir, "shell.js"),
		find: lines(['\t"trace",', '\t"budget",']),
		replace: '\t"budget",',
		expect: "beacon: a report names the hit-test stage that refused most"
	},
	{
		id: "M23",
		claim: "the bundle hands the stage compressor to the checks that call it",
		file: join(root, "lib", "client.template.js"),
		find: "\t\texports.topStage = entry.topStage;",
		replace: "",
		expect: "beacon: a report names the hit-test stage that refused most"
	},
	{
		id: "M24",
		claim: "the trace names a refusal, never the accept count, while any stage is refusing",
		file: join(coreDir, "shell.js"),
		find: "\t\tif (key === \"ok\" || !(value > count)) continue;",
		replace: "\t\tif (!(value > count)) continue;",
		expect: "beacon: a report names the hit-test stage that refused most"
	}
];
