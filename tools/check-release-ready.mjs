// Release-readiness gate for a publishable plugin package.
//
// `check-display-meta.mjs` asks "will the host show this plugin's name and icon correctly".
// This asks the other question: **can this be published, and would what lands on npm actually
// work?** Those are different failures with different symptoms — a missing `keywords` is
// invisible until nobody finds the plugin, and a `files` glob that misses one runtime file is
// invisible until somebody installs it.
//
//   node tools/check-release-ready.mjs [pluginDir]
//
// The last check is the one that matters most and the one prose cannot replace: it packs the
// package with pnpm and reads the TARBALL, so `files`/`.npmignore` behaviour is verified against
// what a user would really download rather than against what the manifest says it means.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDir, scratchDir } from './paths.mjs';

const root = resolve(process.argv[2] ?? pluginDir);
const scratch = join(scratchDir, 'release-pack');

console.log(`checking release readiness for ${root}\n`);

const failures = [];
const expect = (name, ok, detail) => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
	if (!ok) failures.push(name);
};

/** Read a file, or undefined when it is not there. */
function read(path) {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

const manifestPath = join(root, 'package.json');
const manifestText = read(manifestPath);
if (manifestText === undefined) {
	console.error(`FAIL  no package.json at ${manifestPath}`);
	process.exit(1);
}
const manifest = JSON.parse(manifestText);

//#region the manifest npm needs

expect('name is a valid registry name', /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(manifest.name ?? ''), String(manifest.name));
expect('name matches the directory (so a checkout and an install agree)', basename(root) === (manifest.name ?? '').split('/').pop(), basename(root));
const version = manifest.version ?? '';
expect('version is a valid semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version), version);
expect('version is not a placeholder', version !== '0.0.0' && version !== '', version);
// `npm publish` refuses a private package outright, so this one is a hard blocker rather than a
// style question — and it is exactly the flag a `link:` era manifest carries around by accident.
expect('the package is not private', manifest.private !== true, `private=${JSON.stringify(manifest.private)}`);
expect('description is a non-empty string', typeof manifest.description === 'string' && manifest.description.trim() !== '');
expect('license is declared', typeof manifest.license === 'string' && manifest.license.trim() !== '', String(manifest.license));

//#endregion

//#region how it is found and supported

/** The ecosystem's discovery convention: every installed reference plugin carries these. */
const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
expect('keywords exist', keywords.length >= 3, `${keywords.length} keyword(s)`);
expect('keywords include dsh-plugin', keywords.includes('dsh-plugin'), keywords.join(','));

// The registry's own compatibility rule, read out of `dshmarket`'s `discovery-compatibility.js`:
// a requirement may be declared as `engines.dsh` or `dsh.engines.dsh`, and a same-version-line
// peer dependency on `@deepseek-ai/dsh-*` is accepted in its place.
const engineRequirement = manifest.engines?.dsh ?? manifest.dsh?.engines?.dsh;
const peerLine = Object.keys(manifest.peerDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/dsh-'));
expect(
	'the host requirement is declared (engines.dsh or a same-line @deepseek-ai/dsh-* peer)',
	(typeof engineRequirement === 'string' && engineRequirement.trim() !== '') || peerLine.length > 0,
	engineRequirement ?? (peerLine.length > 0 ? `peer ${peerLine.join(', ')}` : 'absent')
);

for (const field of ['repository', 'bugs', 'homepage']) {
	const raw = field === 'repository' ? manifest.repository?.url : field === 'bugs' ? manifest.bugs?.url : manifest.homepage;
	// npm's own convention writes a repository url as `git+https://…`, so the transport check has to
	// look past that prefix rather than insist on the bare scheme.
	const value = typeof raw === 'string' ? raw.replace(/^git\+/, '') : undefined;
	expect(`${field} is an https url`, typeof value === 'string' && value.startsWith('https://'), String(raw));
}

const scoped = (manifest.name ?? '').startsWith('@');
expect('publishConfig names the registry', typeof manifest.publishConfig?.registry === 'string', String(manifest.publishConfig?.registry));
if (scoped) {
	// A scoped package is private by default, so publishing one without this publishes nothing.
	expect('a scoped package declares public access', manifest.publishConfig?.access === 'public', String(manifest.publishConfig?.access));
}

//#endregion

//#region the files a licence and a readme

const license = read(join(root, 'LICENSE'));
expect('LICENSE exists', license !== undefined);
if (license !== undefined) {
	expect('LICENSE carries the declared licence', manifest.license === 'MIT' ? /MIT License|Permission is hereby granted, free of charge/i.test(license) : true);
	const holder = /Copyright\s+\(c\)\s+(\d{4})\s+(.+)/i.exec(license);
	expect('LICENSE has a copyright line with a year', holder !== null, holder === null ? 'no "Copyright (c) <year> <holder>" line' : holder[0].trim());
	// A placeholder is the failure mode this check exists for: the file looks finished, the tarball
	// ships it, and the licence names nobody.
	expect('LICENSE names a real holder', holder !== null && !/[<>]/.test(holder[2]), holder === null ? '—' : holder[2].trim());
}

const readme = read(join(root, 'README.md'));
expect('README exists and says something', readme !== undefined && readme.length > 500, readme === undefined ? 'missing' : `${readme.length} chars`);

//#endregion

//#region what an install actually receives

// The runtime files that are not reachable through `exports` and therefore easy to forget: the
// CommonJS scope marker for the inlined core, and the patch row that mounts the plugin at all.
const REQUIRED = [
	'package/package.json',
	'package/lib/index.js',
	'package/lib/client.js',
	'package/lib/core/package.json',
	'package/cordis.patch.yml',
	'package/locale/en.json',
	'package/locale/zh.json',
	'package/LICENSE',
	'package/README.md'
];
// Everything the manifest's own `exports` promises, resolved to tarball paths.
const exported = Object.values(manifest.exports ?? {}).flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.values(entry))).filter((value) => typeof value === 'string' && value.startsWith('./'));
const exportedFiles = exported.filter((value) => !value.includes('*')).map((value) => `package/${value.slice(2)}`);
// Deduplicated: an export that is also a runtime file would otherwise be asserted twice, and a
// check that fails twice reads as two problems.
const expectedPaths = [...new Set([...REQUIRED, ...exportedFiles])];

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
/**
 * Run pnpm through a shell, as ONE command string.
 *
 * On Windows `pnpm` is a `.cmd`, so it needs a shell — but Node deprecates (DEP0190) `shell: true`
 * together with an args array, because the arguments are concatenated rather than escaped. Passing
 * the whole command as the string is the documented remedy, and the only argument that can contain
 * spaces is a path, which is quoted here.
 */
const pnpm = (command, cwd) => execFileSync(command, { cwd, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

let packed = null;
let packError = null;
try {
	const output = pnpm(`pnpm pack --pack-destination "${scratch}"`, root);
	packed = output.trim().split('\n').filter((line) => line.trim().endsWith('.tgz')).pop() ?? null;
} catch (error) {
	packError = `${error.message}`.split('\n')[0];
}
expect('pnpm pack succeeds', packError === null, packError ?? '');
expect('pnpm pack names a tarball', packed !== null, String(packed));

let contents = [];
if (packed !== null && existsSync(packed)) {
	// `tar -t` prints CRLF line endings on Windows, and a trailing `\r` makes every membership test
	// fail while the listing still *looks* right — which is exactly how this check first reported
	// fifteen missing files that were all present.
	contents = execFileSync('tar', ['-tzf', packed], { encoding: 'utf8' }).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
	expect('the tarball is not empty', contents.length > 5, `${contents.length} entries`);
	for (const required of expectedPaths) {
		expect(`the tarball contains ${required.slice('package/'.length)}`, contents.includes(required), contents.includes(required) ? undefined : 'missing from the packed payload');
	}
	// Also a *content* check on the one file whose meaning is not visible from its name.
	const commonjsMarker = execFileSync('tar', ['-xzOf', packed, 'package/lib/core/package.json'], { encoding: 'utf8' });
	expect('lib/core/package.json still scopes the core as commonjs', JSON.parse(commonjsMarker).type === 'commonjs', commonjsMarker.trim());
	const bytes = statSync(packed).size;
	console.log(`\npacked payload: ${contents.length} files, ${(bytes / 1024).toFixed(0)} KiB`);

	// The strongest check available without a live host: install the tarball into a throwaway
	// directory and import the host half from there. Contents checks prove the files are IN the
	// tarball; this proves the package RESOLVES once unpacked — which is where a `files` pattern that
	// drops the CommonJS scope marker (`lib/core/package.json`) or an entry point that points outside
	// the payload actually breaks.
	const installRoot = join(scratchDir, 'release-install');
	rmSync(installRoot, { recursive: true, force: true });
	mkdirSync(installRoot, { recursive: true });
	writeFileSync(join(installRoot, 'package.json'), JSON.stringify({ name: 'release-install-check', private: true }, null, 2));
	let installError = null;
	try {
		pnpm(`pnpm add "${packed}" --ignore-scripts`, installRoot);
	} catch (error) {
		installError = `${error.message}`.split('\n')[0];
	}
	expect('the tarball installs into a clean directory', installError === null, installError ?? '');
	if (installError === null) {
		let probe = null;
		let probeError = null;
		try {
			probe = execFileSync('node', ['--input-type=module', '-e', `const m = await import(${JSON.stringify(manifest.name)}); console.log(JSON.stringify({ apply: typeof m.apply, inject: Array.isArray(m.inject) }));`], {
				cwd: installRoot,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe']
			});
		} catch (error) {
			// The child's own first line of stderr, not just "Command failed": the reason a check like
			// this exists is a module the `files` allowlist forgot, and the message that names it
			// (`Cannot find module './pack-code.js'`) is the whole diagnosis.
			const stderr = String(error?.stderr ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('at '));
			probeError = stderr[0] ?? `${error.message}`.split('\n')[0];
		}
		const shape = probeError === null ? JSON.parse(probe.trim()) : null;
		expect('the installed host half imports and exports apply/inject', shape?.apply === 'function' && shape?.inject === true, probeError ?? JSON.stringify(shape));
	}
	rmSync(installRoot, { recursive: true, force: true });
} else {
	expect('the tarball can be listed', false, 'nothing to inspect');
}

rmSync(scratch, { recursive: true, force: true });

//#endregion

//#region the name on the registry

/**
 * A repository url in the shape npm stores, comparable across the ways people write it.
 * @param value - a `repository` field: a string, or `{ url }`.
 * @returns the normalised url, or null.
 */
function normaliseRepo(value) {
	const raw = typeof value === 'string' ? value : value?.url;
	if (typeof raw !== 'string') return null;
	return raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
}

// The one check here that leaves the machine, and it is worth it: a first release that dies at
// `npm publish` because the name is taken has wasted the whole setup. What matters is not "taken"
// but "taken by somebody else" — republishing our own name is the normal update path, so the
// published repository is compared with this manifest's rather than mere existence.
const registry = (manifest.publishConfig?.registry ?? 'https://registry.npmjs.org/').replace(/\/+$/, '');
try {
	const response = await fetch(`${registry}/${manifest.name}`, { signal: AbortSignal.timeout(15000) });
	if (response.status === 404) {
		expect('the package name is free on npm', true, manifest.name);
	} else if (response.ok) {
		const published = await response.json();
		const theirs = normaliseRepo(published.repository);
		const ours = normaliseRepo(manifest.repository);
		expect(
			'the published name belongs to this project',
			theirs !== null && theirs === ours,
			`already published (latest ${published['dist-tags']?.latest ?? '?'}) from ${theirs ?? 'an unnamed repository'}`
		);
		console.log(`     (so this release is an UPDATE of ${manifest.name}, not a first publish)`);
	} else {
		console.log(`warn the registry answered HTTP ${response.status} for the name; the local checks above still stand`);
	}
} catch (error) {
	// Offline is not a release blocker: everything else this gate checks is local, so say what could
	// not be checked rather than failing the run on a network condition.
	console.log(`warn could not ask the registry about the name (${`${error.message}`.split('\n')[0]}); the local checks above still stand`);
}

//#endregion

//#region the advertised repository

// The mistake this exists for: the manifest pointed at `github.com/lakerian/dsh-plugin-term-dictionary`
// while the repository was actually named `lakerian-dsh-plugin-term-dictionary`. Nothing local could
// see that — the url is a perfectly valid https url to a project that does not exist, so the npm page
// and the curated list would both have linked a 404. Two API calls settle it.
const repoSlug = (normaliseRepo(manifest.repository) ?? '').replace(/^https:\/\/github\.com\//, '');
if (!/^[^/]+\/[^/]+$/.test(repoSlug)) {
	console.log('warn the repository is not a github url, so the existence check was skipped');
} else {
	const api = `https://api.github.com/repos/${repoSlug}`;
	const headers = { 'User-Agent': 'dsh-plugin-release-check', Accept: 'application/vnd.github+json' };
	try {
		const response = await fetch(api, { headers, signal: AbortSignal.timeout(15000) });
		if (response.status === 404) {
			expect(`the advertised repository exists (${repoSlug})`, false, 'github answers 404 for it — check the name');
		} else if (response.ok) {
			const repo = await response.json();
			expect(`the advertised repository exists (${repoSlug})`, true, `default branch ${repo.default_branch}`);
			// The curated list and the npm page both link it, so a private repository is not shippable.
			expect('the advertised repository is public', repo.private === false, `private=${repo.private}`);
			// Required by the listing's rules, and invisible from inside the checkout.
			const topics = await fetch(`${api}/topics`, { headers, signal: AbortSignal.timeout(15000) });
			const names = topics.ok ? (await topics.json()).names ?? [] : [];
			expect('the repository carries the dsh-plugin topic', names.includes('dsh-plugin'), topics.ok ? names.join(',') || 'no topics' : `HTTP ${topics.status}`);
		} else {
			console.log(`warn github answered HTTP ${response.status} for ${repoSlug}; the local checks above still stand`);
		}
	} catch (error) {
		const cause = error?.cause?.code ?? error?.cause?.message ?? error.message;
		// The one failure this machine really produces: a TLS-inspecting proxy whose CA is in the
		// Windows certificate store but not in Node's, so every github.com request from Node dies with
		// UNABLE_TO_VERIFY_LEAF_SIGNATURE while PowerShell and `git push` (over ssh) are fine. Naming
		// the flag is the difference between a mystery and a workaround.
		const remedy = String(cause).includes('UNABLE_TO_VERIFY') || String(cause).includes('certificate')
			? ' — a TLS-inspecting proxy: rerun as `node --use-system-ca tools/check-release-ready.mjs`'
			: '';
		console.log(`warn could not ask github about the repository (${cause})${remedy}; the local checks above still stand`);
	}
}

//#endregion

console.log('');
if (failures.length === 0) {
	console.log('release-ready. the two steps that need your hands:');
	console.log(`  1. npm login  &&  cd ${root}  &&  pnpm publish${scoped ? ' --access public' : ''}`);
	console.log('     (pnpm refuses to publish a dirty working tree: commit first, or add --no-git-checks)');
	console.log('  2. add the entry to awesome-dsh-plugin (a PR; the market picks it up within a day)');
	process.exit(0);
}
console.log(`${failures.length} check(s) failed:`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(1);
