// Генерирует data/maps-geo.json — гео-конфиг карт (SVG + трансформация координат),
// взятый из открытого репозитория tarkov.dev (the-hideout/tarkov-dev, src/data/maps.json).
// Формула маркеров портирована из их getCRS()/applyRotation().
// Запуск: node build/maps.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json';

const res = await fetch(SRC);
if (!res.ok) throw new Error('HTTP ' + res.status);
const maps = await res.json();

const out = {}; // slug(normalizedName) -> { svg, rotation, sx, sy, bounds, floors, extracts, bossSpawns, bosses }
for (const group of maps) {
  for (const m of group.maps || []) {
    if (!m.svgPath || !m.transform || !m.bounds) continue;
    const floors = [m.svgLayer, ...((m.layers || []).map((l) => l.svgLayer))].filter(Boolean);
    out[group.normalizedName] = {
      svg: m.svgPath,
      rotation: m.coordinateRotation || 0,
      sx: m.transform[0],
      sy: m.transform[2] * -1,
      bounds: m.bounds,
    };
    if (floors.length > 1) out[group.normalizedName].floors = floors;
    break; // первый подходящий слой (Ground_Level)
  }
}
// Лаборатория: в конфиге нет svgPath, но SVG существует отдельным файлом
if (!out['the-lab']) {
  const lab = maps.find((m) => m.normalizedName === 'the-lab');
  const lm = lab && (lab.maps || [])[0];
  if (lm && lm.transform && lm.bounds) {
    out['the-lab'] = { svg: 'https://assets.tarkov.dev/maps/svg/Labs.svg', rotation: lm.coordinateRotation || 0, sx: lm.transform[0], sy: lm.transform[2] * -1, bounds: lm.bounds };
  }
}

// --- выходы и спавны боссов из API ---
const r1 = (n) => Math.round(n * 10) / 10;
const gql = await fetch('https://api.tarkov.dev/graphql', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `{ maps(lang: ru){ normalizedName extracts{ name faction position{x z} } spawns{ position{x z} categories } bosses{ boss{ name } spawnChance } } }` }),
});
const md = (await gql.json()).data.maps;
for (const m of md) {
  const g = out[m.normalizedName];
  if (!g) continue;
  g.extracts = (m.extracts || []).filter((e) => e.position).map((e) => ({ name: e.name, faction: e.faction || 'shared', x: r1(e.position.x), z: r1(e.position.z) }));
  // спавны боссов: точки с категорией "boss", дедуп по округлённой позиции
  const seen = new Set(), bs = [];
  for (const s of m.spawns || []) {
    if (!s.position || !(s.categories || []).some((c) => /boss/i.test(c))) continue;
    const k = Math.round(s.position.x / 6) + '|' + Math.round(s.position.z / 6);
    if (seen.has(k)) continue; seen.add(k);
    bs.push({ x: r1(s.position.x), z: r1(s.position.z) });
  }
  g.bossSpawns = bs;
  g.bosses = (m.bosses || []).map((b) => ({ name: b.boss.name, chance: Math.round((b.spawnChance || 0) * 100) }))
    .filter((b, i, a) => a.findIndex((x) => x.name === b.name) === i)
    .sort((a, b) => b.chance - a.chance);
}

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(path.join(ROOT, 'data', 'maps-geo.json'), json, 'utf8');
fs.writeFileSync(path.join(ROOT, 'data', 'maps-geo.js'), 'window.__MAPSGEO__=' + json + ';\n', 'utf8');
console.log('maps with geo:', Object.keys(out).join(', '));
