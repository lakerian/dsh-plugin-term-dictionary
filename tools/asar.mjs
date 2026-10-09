// Minimal Electron ASAR reader: list directories and print/extract files.
// Usage:
//   node asar.mjs <asar> ls <dirPath>
//   node asar.mjs <asar> cat <filePath> [--max N]
//   node asar.mjs <asar> extract <filePath> <destPath>
//   node asar.mjs <asar> find <substr>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [asarPath, cmd, arg1, arg2] = process.argv.slice(2);
const buf = readFileSync(asarPath);

// ASAR header: UInt32LE(4) size-of-pickle, then pickle: UInt32LE(4)=headerSize? Standard layout:
// [0..4)   = 4
// [4..8)   = size of the "size" pickle payload region = 4 + jsonLen (padded)
// [8..12)  = jsonLen
// [12..16) = json string length again (payload size)
// Actually the canonical layout used by @electron/asar:
//   read first 8 bytes -> [0..4) is a UInt32LE == 4 (size of next field)
//   [4..8) is UInt32LE = size of header pickle payload
//   then at offset 8: UInt32LE = header string length
//   then at offset 12: the JSON string (length = value at offset 8), padded to 4 bytes
const sizeBuf = buf.readUInt32LE(4);
const headerJsonLen = buf.readUInt32LE(12);
const headerJson = buf.toString('utf8', 16, 16 + headerJsonLen);
const header = JSON.parse(headerJson);
const baseOffset = 8 + sizeBuf; // data section start

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: entry.size, offset: entry.offset });
  }
}

function readEntry(entry) {
  if (entry.unpacked) {
    // stored outside the asar, under <asar>.unpacked
    const p = asarPath.replace(/app\.asar$/, 'app.asar.unpacked') + '/' + entry._path;
    return readFileSync(p);
  }
  const start = baseOffset + Number(entry.offset);
  return buf.subarray(start, start + Number(entry.size));
}

const all = [];
walk(header, '', all);

if (cmd === 'ls') {
  const dir = (arg1 ?? '').replace(/^\/|\/$/g, '');
  const prefix = dir ? dir + '/' : '';
  const seen = new Set();
  for (const e of all) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    const top = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) + '/' : rest;
    if (seen.has(top)) continue;
    seen.add(top);
    const nested = rest.includes('/');
    const found = all.find((x) => x.path === prefix + top.replace(/\/$/, ''));
    console.log(nested ? top : `${top}${found ? `\t${found.size}` : ''}`);
  }
} else if (cmd === 'cat') {
  const entry = all.find((e) => e.path === arg1);
  if (!entry) { console.error('not found: ' + arg1); process.exit(1); }
  entry._path = entry.path;
  let text = readEntry(entry).toString('utf8');
  const maxIdx = process.argv.indexOf('--max');
  if (maxIdx > 0) text = text.slice(0, Number(process.argv[maxIdx + 1]));
  process.stdout.write(text);
} else if (cmd === 'extract') {
  const entry = all.find((e) => e.path === arg1);
  if (!entry) { console.error('not found: ' + arg1); process.exit(1); }
  entry._path = entry.path;
  mkdirSync(dirname(arg2), { recursive: true });
  writeFileSync(arg2, readEntry(entry));
  console.error(`wrote ${arg2} (${entry.size} bytes)`);
} else if (cmd === 'grep') {
  const needle = arg1;
  const re = new RegExp(needle, 'g');
  const limit = arg2 ? Number(arg2) : 200;
  let hits = 0;
  for (const e of all) {
    if (!/\.(js|mjs|cjs|ts|json|md|yml|yaml)$/.test(e.path)) continue;
    if (e.size > 3_000_000) continue;
    e._path = e.path;
    let text;
    try { text = readEntry(e).toString('utf8'); } catch { continue; }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index) === -1 ? text.length : text.indexOf('\n', m.index));
      console.log(`${e.path}\t${line.trim().slice(0, 220)}`);
      if (++hits >= limit) { console.error(`-- limit ${limit} reached --`); process.exit(0); }
      break; // one hit per file is enough for orientation
    }
  }
  console.error(`-- ${hits} file(s) matched --`);
} else if (cmd === 'find') {
  const needle = (arg1 ?? '').toLowerCase();
  for (const e of all) if (e.path.toLowerCase().includes(needle)) console.log(e.path);
} else {
  console.error('unknown command');
  process.exit(2);
}
