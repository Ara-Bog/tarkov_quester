// Fetches the FULL item catalogue from tarkov.dev (Russian) for the "находки" page,
// where the user can build personal loot lists. Writes data/items.json.
// Run: node build/items.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');

const QUERY = `{
  items(lang: ru) {
    id
    name
    shortName
    iconLink
    image512pxLink
    category { name }
  }
}`;

const res = await fetch('https://api.tarkov.dev/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: QUERY }),
});
if (!res.ok) throw new Error('HTTP ' + res.status);
const json = await res.json();
if (json.errors) { console.error(JSON.stringify(json.errors, null, 2)); throw new Error('GraphQL errors'); }

const items = json.data.items.map((i) => ({
  id: i.id,
  name: i.name,
  shortName: i.shortName,
  icon: i.iconLink || null,
  img: (i.image512pxLink && !/unknown-item/.test(i.image512pxLink)) ? i.image512pxLink : (i.iconLink || null),
  cat: i.category ? i.category.name : null,
})).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

const out = { meta: { source: 'https://api.tarkov.dev', lang: 'ru', count: items.length }, items };
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const json2 = JSON.stringify(out);
fs.writeFileSync(path.join(ROOT, 'data', 'items.json'), json2, 'utf8');
fs.writeFileSync(path.join(ROOT, 'data', 'items-data.js'), 'window.__ITEMS__=' + json2 + ';\n', 'utf8');
console.log(`Items: ${items.length} -> data/items.json (${(json2.length / 1024 / 1024).toFixed(1)} MB)`);
