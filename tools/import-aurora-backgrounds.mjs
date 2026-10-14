// import-aurora-backgrounds.mjs — copies every background a local Aurora
// Builder install knows into this table's homebrew (data/saves/homebrew.json).
//
//   node tools/import-aurora-backgrounds.mjs [--from <Aurora "custom" folder>]
//        [--data <saves folder>] [--owner <username>] [--dry-run]
//
// Aurora keeps its content as element XML under "5e Character Builder/custom"
// in the user's Documents. The conversion itself is public/js/shared/aurora.js
// (auroraBackgrounds); this script only walks the folder and writes the result
// through the homebrew schema. The imported text is the user's own content and
// stays in data/saves/ (gitignored) — it is never part of the repo.
//
// Re-running updates the imported entries in place (their index is derived from
// the Aurora id) and leaves everything else in the file alone. Stop the server
// first, or restart it afterwards: it only reads homebrew.json at startup.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseAuroraElements, auroraBackgrounds, auroraContext } from '../public/js/shared/aurora.js';

const require = createRequire(import.meta.url);
const { sanitizeRulesHomebrew, HOMEBREW_COLLECTIONS } = require('../lib/homebrew.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf('--' + name); return at >= 0 ? args[at + 1] : null; };
const dryRun = args.includes('--dry-run');

function findAuroraFolder() {
  const home = os.homedir();
  const documents = ['Documents', 'OneDrive/Documents', 'OneDrive/Documentos', 'Documentos']
    .map(d => path.join(home, d, '5e Character Builder', 'custom'));
  return documents.find(dir => fs.existsSync(dir)) || null;
}
function xmlFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) xmlFiles(full, out);
    else if (entry.name.toLowerCase().endsWith('.xml')) out.push(full);
  }
  return out;
}
const srd = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'srd', file + '.json'), 'utf8'));

const from = flag('from') || findAuroraFolder();
if (!from || !fs.existsSync(from)) {
  console.error('Aurora content folder not found. Pass it with --from "<...>/5e Character Builder/custom".');
  process.exit(1);
}
const dataDir = path.resolve(flag('data') || process.env.THREEDX_DATA_DIR || path.join(ROOT, 'data', 'saves'));
const target = path.join(dataDir, 'homebrew.json');

// Backgrounds point at features, variants and feature options defined in other
// elements, so every file that mentions a background is read first.
const elements = [];
for (const file of xmlFiles(from).sort()) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('"Background')) continue;
  try { elements.push(...parseAuroraElements(text)); }
  catch (error) { console.warn(`skipped ${path.relative(from, file)}: ${error.message}`); }
}
const context = auroraContext({ skills: srd('skills'), equipment: srd('equipment'), proficiencies: srd('proficiencies') });
const converted = auroraBackgrounds(elements, context);

const emptyDB = () => Object.fromEntries(Object.values(HOMEBREW_COLLECTIONS).map(collection => [collection, {}]));
const db = { ...emptyDB(), ...(fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {}) };

function hostName() {
  try {
    const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8')).users || {};
    const host = Object.values(users).find(user => user && user.role === 'host');
    return host ? host.username : null;
  } catch (_) { return null; }
}
const owner = flag('owner') || hostName() || 'gm';

// The SRD's own backgrounds are already at the table.
const builtIn = new Set(srd('backgrounds').map(b => b.name.toLowerCase()));
let added = 0, updated = 0, skipped = 0;
const bySource = new Map();
for (const { id, record } of converted) {
  if (builtIn.has(record.name.toLowerCase())) { skipped++; continue; }
  const data = sanitizeRulesHomebrew('background', record);
  if (!data) { console.warn(`rejected by the schema: ${record.name} (${id})`); skipped++; continue; }
  const index = 'aurora-' + id.toLowerCase().replace(/^id_/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const previous = db.backgrounds[index];
  db.backgrounds[index] = { ...data, index, owner: (previous && previous.owner) || owner, custom: true };
  if (previous) updated++; else added++;
  bySource.set(data.source || '—', (bySource.get(data.source || '—') || 0) + 1);
}

for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(4)}  ${source}`);
console.log(`${added} added, ${updated} updated, ${skipped} skipped (already in the SRD, or invalid) — from ${from}`);
if (dryRun) { console.log('dry run: nothing written'); process.exit(0); }

fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(target)) fs.copyFileSync(target, path.join(dataDir, 'homebrew.before-aurora-import.json'));
const temp = target + '.tmp';
fs.writeFileSync(temp, JSON.stringify(db, null, 2));
fs.renameSync(temp, target);
console.log(`wrote ${target} (owner "${owner}"). Restart the server to load it.`);
