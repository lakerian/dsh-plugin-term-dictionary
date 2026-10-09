// Exercises the host half's route resolution against the real failure it produced.
//
// The bug: `no API key for provider route "deepseek-official"` — the profile's own selection
// was DISCARDED because the host half could not find it in `listProviders()`, and the first
// registered route (the API-key one) was used instead. This prints what the resolver now
// returns for each ordering case, so the fix can be read rather than trusted.
//
// Usage: node tools/probe-model-route.mjs

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { pluginDir } from "./paths.mjs";

const module = await import(pathToFileURL(join(pluginDir, "lib", "index.js")).href);
const resolveTargets = module.__resolveTargets;
const isCredentialFailure = module.__isCredentialFailure;

/** A stand-in `llm` service in the shape the contract declares. */
const llmWith = (ids) => ({
	listProviders: () => ids.map((id) => ({ id, name: id })),
	listModels: async () => [{ id: "deepseek-chat" }]
});

/** A stand-in `agentDefaultModel` service. */
const selectionOf = (provider, model) => ({ currentSelection: () => ({ provider, model }) });

const cases = [
	["selection visible in the catalog", llmWith(["deepseek-official", "deepseek-account"]), {}, selectionOf("deepseek-account", "deepseek-reasoner")],
	["selection INVISIBLE to this half", llmWith(["deepseek-official"]), {}, selectionOf("deepseek-signed-in", "deepseek-reasoner")],
	["explicit config wins alone", llmWith(["deepseek-official", "deepseek-account"]), { provider: "custom-route" }, selectionOf("deepseek-account")],
	["no selection at all", llmWith(["deepseek-official"]), {}, null],
	["a selection that throws", llmWith(["deepseek-official"]), {}, { currentSelection: () => { throw new Error("denied"); } }]
];

for (const [name, llm, config, selection] of cases) {
	try {
		const targets = await resolveTargets(llm, config, selection, { warn: () => {} });
		console.log(`${name.padEnd(34)} -> ${targets.map((t) => `${t.provider}/${t.model}`).join(" , ")}`);
	} catch (error) {
		console.log(`${name.padEnd(34)} -> throws: ${error.message}`);
	}
}

const empty = await resolveTargets({ listProviders: () => [] }, {}, null, { warn: () => {} }).catch((error) => `throws: ${error.message}`);
console.log(`${"no routes at all".padEnd(34)} -> ${empty}`);

console.log("");
console.log("the reported failure is treated as a credential failure :", isCredentialFailure('llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service'));
console.log("a model-side failure is NOT                            :", isCredentialFailure("the model did not return a usable explanation"));
