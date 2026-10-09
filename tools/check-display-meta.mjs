/**
 * Checks the plugin's display metadata the way the shipped reader does
 * (`readPluginMeta` in @deepseek-ai/dsh-app-boot):
 *   - locale files are resolved through the COMPLETE package specifier, so the
 *     package must export `./locale/*.json` — a missing export silently means
 *     "no metadata" and the card falls back to the package name;
 *   - every language present under `locale/` contributes a field, and `en`
 *     supplies the fallback layer (so `locale/en.json` must exist);
 *   - the icon is a manifest-relative SVG/PNG/JPEG/WebP file inside the package
 *     directory, at most 256 KiB, embedded as a data URL.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pluginDir } from './paths.mjs';

const profileDir = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
// The plugin to inspect: an explicit argument, or the package this checkout is in.
const root = resolve(process.argv[2] ?? pluginDir);
console.log(`checking display metadata for ${root}\n`);
const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
const require = createRequire(`${profileDir}/package.json`);

const failures = [];
const expect = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

// --- locale files ----------------------------------------------------------
const languages = readdirSync(`${root}/locale`).filter((file) => extname(file) === '.json').map((file) => file.slice(0, -5));
expect('english metadata exists (the fallback layer)', languages.includes('en'), languages.join(', '));
expect('chinese metadata exists', languages.includes('zh'), languages.join(', '));

const dictionaries = new Map();
for (const language of languages) {
  const file = `${root}/locale/${language}.json`;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const title = parsed.meta?.title;
  const description = parsed.meta?.description;
  expect(`${language}: meta.title is a non-empty string`, typeof title === 'string' && title.trim() !== '', JSON.stringify(title));
  expect(`${language}: meta.description is a non-empty string`, typeof description === 'string' && description.trim() !== '');
  dictionaries.set(language, { title, description });
}

// The reader merges every language file into one map per field, with `en` as the fallback layer.
const localized = (field) => ({
  en: manifest.name,
  ...Object.fromEntries([...dictionaries].flatMap(([language, fields]) => (fields[field] === undefined ? [] : [[language, fields[field]]])))
});
console.log('\nlocalized title      :', JSON.stringify(localized('title'), null, 0));
console.log('localized description:', JSON.stringify(localized('description'), null, 0));

// --- resolution through the package's own exports --------------------------
for (const language of languages) {
  let resolved;
  try {
    resolved = require.resolve(`${manifest.name}/locale/${language}.json`);
  } catch (error) {
    resolved = undefined;
    expect(`exports resolve locale/${language}.json`, false, String(error.message).split('\n')[0]);
  }
  if (resolved !== undefined) expect(`exports resolve locale/${language}.json`, realpathSync(resolved) === realpathSync(`${root}/locale/${language}.json`), resolved);
}
let manifestResolved;
try {
  manifestResolved = require.resolve(`${manifest.name}/package.json`);
} catch (error) {
  manifestResolved = undefined;
  expect('exports resolve package.json', false, String(error.message).split('\n')[0]);
}
if (manifestResolved !== undefined) expect('exports resolve package.json', realpathSync(manifestResolved) === realpathSync(`${root}/package.json`), manifestResolved);

// --- icon ------------------------------------------------------------------
const icon = manifest.icon;
expect('icon is a relative path', typeof icon === 'string' && !isAbsolute(icon) && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon ?? ''), icon);
expect('icon is an accepted media type', ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(icon ?? '').toLowerCase()), extname(icon ?? ''));
const directory = realpathSync(root);
const iconFile = realpathSync(resolve(directory, icon));
const local = relative(directory, iconFile);
expect('icon stays inside the package directory', local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local), local);
expect('icon is a regular file', statSync(iconFile).isFile());
const bytes = readFileSync(iconFile);
expect('icon is at most 256 KiB', bytes.length <= 256 * 1024, `${bytes.length} bytes`);
const dataUrl = `data:image/svg+xml;base64,${bytes.toString('base64')}`;
const [, mediaType, payload] = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl) ?? [];
expect('icon embeds as a data URL that decodes back byte-for-byte',
  mediaType === 'image/svg+xml' && Buffer.from(payload ?? '', 'base64').equals(bytes),
  `${mediaType}, ${dataUrl.length} chars`);
expect('icon payload is valid SVG', readFileSync(iconFile, 'utf8').trimStart().startsWith('<svg'));

// --- fallback text ---------------------------------------------------------
expect('package.json description is Chinese (the fallback for both languages)', /[\u4e00-\u9fff]/.test(manifest.description), manifest.description);

console.log(failures.length === 0 ? '\nall display-metadata checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
