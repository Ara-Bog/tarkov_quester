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

// --- выходы (только PMC + общие, без чисто диких) и спавны боссов из API ---
// Реальные зоны боссов: boss.spawnLocations[].spawnKey ТОЧНО совпадает со spawn.zoneName.
// Берём центроид каждой боссовой зоны -> один маркер на зону с именем босса.
// Где боссов нет (Map.bosses пуст, напр. Эпицентр) — маркеров не будет.
const r1 = (n) => Math.round(n * 10) / 10;
const gql = await fetch('https://api.tarkov.dev/graphql', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: `{ maps(lang: ru){ normalizedName extracts{ name faction position{x z} } bosses{ boss{ name } spawnChance spawnLocations{ spawnKey } } spawns{ zoneName position{x z} } } }` }),
});
const md = (await gql.json()).data.maps;
for (const m of md) {
  const g = out[m.normalizedName];
  if (!g) continue;
  g.extracts = (m.extracts || [])
    .filter((e) => e.position && /pmc|shared/i.test(e.faction || ''))
    .map((e) => ({ name: e.name, faction: (e.faction || 'shared').toLowerCase(), x: r1(e.position.x), z: r1(e.position.z) }));

  // zoneName -> set of boss names, что спавнятся в этой зоне
  const zoneBosses = {};
  for (const b of m.bosses || []) for (const sl of b.spawnLocations || []) { if (sl.spawnKey) (zoneBosses[sl.spawnKey] ||= new Set()).add(b.boss.name); }
  // координаты спавнов в боссовых зонах
  const zonePts = {};
  for (const s of m.spawns || []) { if (s.position && zoneBosses[s.zoneName]) (zonePts[s.zoneName] ||= []).push(s.position); }
  const bossSpawns = [];
  for (const [zone, pts] of Object.entries(zonePts)) {
    if (!pts.length) continue;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cz = pts.reduce((a, p) => a + p.z, 0) / pts.length;
    bossSpawns.push({ x: r1(cx), z: r1(cz), bosses: [...zoneBosses[zone]] });
  }
  g.bossSpawns = bossSpawns;
  g.bosses = (m.bosses || []).map((b) => ({ name: b.boss.name, chance: Math.round((b.spawnChance || 0) * 100) }))
    .filter((b, i, a) => a.findIndex((x) => x.name === b.name) === i)
    .sort((a, b) => b.chance - a.chance);
}

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(path.join(ROOT, 'data', 'maps-geo.json'), json, 'utf8');
fs.writeFileSync(path.join(ROOT, 'data', 'maps-geo.js'), 'window.__MAPSGEO__=' + json + ';\n', 'utf8');
console.log('maps with geo:', Object.keys(out).join(', '));
