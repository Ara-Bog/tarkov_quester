// Генерирует data/keys.json — справочник ключей, сгруппированных по локациям.
// Источник «ключ → локация» — Map.locks из API tarkov.dev (надёжно, ~197 ключей с замками).
// Ключи без замка (автомобильные, сейфовые и т.п.) попадают в группу «Без привязки».
// Запуск: node build/keys.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');

// Каноникализация карт: сливаем ночные/21+ варианты (как в build/transform.mjs)
function canonMap(name) {
  let n = String(name || '').replace(/\s+/g, ' ').trim();
  n = n.replace(/\s*21\+$/, '');
  n = n.replace(/^Ночной\s+/i, '');
  if (/Завод/i.test(n)) n = 'Завод';
  return n;
}

const QUERY = `{
  maps(lang: ru) { name locks { lockType key { id name shortName iconLink image512pxLink wikiLink } } }
  items(type: keys, lang: ru) { id name shortName iconLink image512pxLink wikiLink }
}`;

const res = await fetch('https://api.tarkov.dev/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: QUERY }),
});
if (!res.ok) throw new Error('HTTP ' + res.status);
const json = await res.json();
if (json.errors) { console.error(JSON.stringify(json.errors, null, 2)); throw new Error('GraphQL errors'); }
const { maps, items } = json.data;

const keyById = new Map(); // id -> { id, name, shortName, icon, img, wiki, maps:Set, lockTypes:Set }
function reg(k) {
  if (!keyById.has(k.id)) keyById.set(k.id, {
    id: k.id,
    name: k.name || '',
    shortName: k.shortName || k.name || '',
    icon: k.iconLink || null,
    img: (k.image512pxLink && !/unknown-item/.test(k.image512pxLink)) ? k.image512pxLink : (k.iconLink || null),
    wiki: k.wikiLink || null,
    maps: new Set(),
    lockTypes: new Set(),
  });
  return keyById.get(k.id);
}

// привязка к картам из замков
for (const m of maps) {
  const mn = canonMap(m.name);
  for (const l of m.locks || []) {
    if (!l.key) continue;
    const e = reg(l.key);
    e.maps.add(mn);
    if (l.lockType) e.lockTypes.add(l.lockType);
  }
}
// добавим ключи из общего списка (без замка — останутся «без привязки»)
for (const it of items) reg(it);

// финальный массив
const keys = [...keyById.values()]
  .map((k) => ({ ...k, maps: [...k.maps].sort((a, b) => a.localeCompare(b, 'ru')), lockTypes: [...k.lockTypes] }))
  .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

// --- русские ссылки на вики (по названию ключа, как для квестов) ---
// wikiLink из API ведёт на английскую вики; формируем русскую по имени и проверяем, что
// страница существует (MediaWiki API). Если ru-страницы нет — ссылка на ПОИСК по ru-вики
// (а не на английский ресурс), чтобы всё оставалось на русском.
const RU = 'https://escapefromtarkov.fandom.com/ru/wiki/';
const ruSlug = (name) => String(name).replace(/\s*\.\s*Часть/gi, ' - Часть').replace(/ /g, '_');
const ruUrl = (name) => RU + encodeURIComponent(ruSlug(name));
const ruSearch = (name) => RU + 'Special:Search?query=' + encodeURIComponent(name);
async function ruWikiOk(names) {
  const ok = new Set();
  for (let i = 0; i < names.length; i += 40) {
    const batch = names.slice(i, i + 40);
    const url = 'https://escapefromtarkov.fandom.com/ru/api.php?action=query&format=json&redirects=1&prop=info&titles=' + encodeURIComponent(batch.join('|'));
    try {
      const j = await (await fetch(url)).json();
      const normd = j.query.normalized || [], red = j.query.redirects || [];
      const found = new Set();
      for (const id in j.query.pages) { const p = j.query.pages[id]; if (p.missing === undefined) found.add(p.title); }
      const titleOf = (n) => { let t = n; const nm = normd.find((x) => x.from === t); if (nm) t = nm.to; const rd = red.find((x) => x.from === t); if (rd) t = rd.to; return t; };
      for (const n of batch) if (found.has(titleOf(n))) ok.add(n);
    } catch { for (const n of batch) ok.add(n); } // сеть недоступна — ставим прямую ссылку
  }
  return ok;
}
const wikiOk = await ruWikiOk(keys.map((k) => k.name));
let ruArticles = 0;
for (const k of keys) {
  if (wikiOk.has(k.name)) { k.wiki = ruUrl(k.name); ruArticles++; }
  else k.wiki = ruSearch(k.name);
}

// порядок карт: по количеству ключей убыв., затем по алфавиту
const mapCount = {};
for (const k of keys) for (const mn of k.maps) mapCount[mn] = (mapCount[mn] || 0) + 1;
const mapOrder = Object.keys(mapCount).sort((a, b) => mapCount[b] - mapCount[a] || a.localeCompare(b, 'ru'));

const data = {
  meta: {
    source: 'https://api.tarkov.dev/graphql (Map.locks)',
    lang: 'ru',
    keyCount: keys.length,
    locatedCount: keys.filter((k) => k.maps.length).length,
    note: 'Локация ключа берётся из замков карт (Map.locks). Ключи без замка — в группе «Без привязки».',
  },
  mapOrder,
  keys,
};

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const out = JSON.stringify(data);
fs.writeFileSync(path.join(ROOT, 'data', 'keys.json'), out, 'utf8');
fs.writeFileSync(path.join(ROOT, 'data', 'keys-data.js'), 'window.__KEYS__=' + out + ';\n', 'utf8');
console.log('keys:', keys.length, '| с локацией:', data.meta.locatedCount, '| карт:', mapOrder.length, '| ru-вики статей:', ruArticles, '/ поиск:', keys.length - ruArticles);
console.log('по картам:', mapOrder.map((m) => `${m}(${mapCount[m]})`).join(', '));
