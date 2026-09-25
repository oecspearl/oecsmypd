#!/usr/bin/env node
/**
 * Builds a pruned Iconify collection containing only the icons referenced in
 * the codebase, so they can be bundled and rendered offline without hitting
 * api.iconify.design. Icons not in the subset (e.g. names stored in the
 * database) still fall back to the API when online.
 *
 * Usage:  node app/components/icons/build-icon-subset.mjs
 * Output: app/components/icons/subset.generated.json
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

const PREFIXES = ['material-symbols', 'mdi', 'svg-spinners'];
const SCAN_DIRS = ['app', 'components', 'lib', 'database'].map((d) => join(ROOT, d)).filter(existsSync);
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.sql']);
const OUT = join(__dirname, 'subset.generated.json');

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (SCAN_EXT.has(extname(entry)) && full !== OUT) files.push(full);
  }
  return files;
}

const pattern = new RegExp(`\\b(${PREFIXES.join('|')}):([a-z0-9]+(?:-[a-z0-9]+)*)`, 'g');
const used = new Map(PREFIXES.map((p) => [p, new Set()]));

for (const file of SCAN_DIRS.flatMap((d) => walk(d))) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(pattern)) used.get(match[1]).add(match[2]);
}

function pickIcons(collection, names) {
  const out = { prefix: collection.prefix, icons: {}, aliases: {} };
  for (const key of ['width', 'height', 'lastModified']) if (collection[key] != null) out[key] = collection[key];
  const missing = [];
  const addIcon = (name) => {
    if (out.icons[name] || out.aliases[name]) return true;
    if (collection.icons?.[name]) { out.icons[name] = collection.icons[name]; return true; }
    const alias = collection.aliases?.[name];
    if (alias && addIcon(alias.parent)) { out.aliases[name] = alias; return true; }
    return false;
  };
  for (const name of names) if (!addIcon(name)) missing.push(name);
  if (!Object.keys(out.aliases).length) delete out.aliases;
  return { out, missing };
}

const result = {};
let total = 0;
for (const prefix of PREFIXES) {
  const names = [...used.get(prefix)].sort();
  if (!names.length) continue;
  let collection;
  try { collection = require(`@iconify-json/${prefix}/icons.json`); }
  catch { console.warn(`@iconify-json/${prefix} not installed, skipping ${names.length} icons`); continue; }
  const { out, missing } = pickIcons(collection, names);
  const count = Object.keys(out.icons).length + Object.keys(out.aliases || {}).length;
  total += count;
  console.log(`${prefix}: ${count} icons bundled${missing.length ? `, ${missing.length} unknown (${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''})` : ''}`);
  result[prefix] = out;
}

writeFileSync(OUT, JSON.stringify(result));
console.log(`Wrote ${OUT} (${(statSync(OUT).size / 1024).toFixed(1)} KB, ${total} icons)`);
