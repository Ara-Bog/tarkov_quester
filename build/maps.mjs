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
    out[group.normalizedName] = {
      svg: m.svgPath,
      rotation: m.coordinateRotation || 0,
      sx: m.transform[0],
      sy: m.transform[2] * -1,
      bounds: m.bounds,
      _layers: m.layers || [], // именованные этажи из maps.json (удаляется перед выводом)
    };
    // экстенты этажей: floor -> [[x1,z1,x2,z2,hmin,hmax], ...] (для привязки квест-маркеров к этажу)
    const extents = {};
    for (const l of m.layers || []) {
      if (!l.svgLayer) continue;
      const rects = [];
      for (const e of l.extents || []) {
        const h = e.height; if (!h) continue;
        for (const b of e.bounds || []) { if (Array.isArray(b) && b[0] && b[1]) rects.push([b[0][0], b[0][1], b[1][0], b[1][1], h[0], h[1]]); }
      }
      if (rects.length) extents[l.svgLayer] = rects;
    }
    if (Object.keys(extents).length) out[group.normalizedName].extents = extents;
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
  body: JSON.stringify({ query: `{ maps(lang: ru){ normalizedName extracts{ name faction position{x y z} } bosses{ boss{ name } spawnChance spawnLocations{ spawnKey } } spawns{ zoneName position{x y z} } } }` }),
});
const md = (await gql.json()).data.maps;
for (const m of md) {
  const g = out[m.normalizedName];
  if (!g) continue;
  g.extracts = (m.extracts || [])
    .filter((e) => e.position && /pmc|shared/i.test(e.faction || ''))
    .map((e) => ({ name: e.name, faction: (e.faction || 'shared').toLowerCase(), x: r1(e.position.x), z: r1(e.position.z), y: r1(e.position.y) }));

  // zoneName -> set of boss names, что спавнятся в этой зоне
  const zoneBosses = {};
  for (const b of m.bosses || []) for (const sl of b.spawnLocations || []) { if (sl.spawnKey) (zoneBosses[sl.spawnKey] ||= new Set()).add(b.boss.name); }
  // координаты спавнов в боссовых зонах
  const zonePts = {};
  for (const s of m.spawns || []) { if (s.position && zoneBosses[s.zoneName]) (zonePts[s.zoneName] ||= []).push(s.position); }
  const bossSpawns = [];
  for (const [zone, pts] of Object.entries(zonePts)) {
    if (!pts.length) continue;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cz = pts.reduce((a, p) => a + p.z, 0) / pts.length, cy = pts.reduce((a, p) => a + (p.y || 0), 0) / pts.length;
    bossSpawns.push({ x: r1(cx), z: r1(cz), y: r1(cy), bosses: [...zoneBosses[zone]] });
  }
  g.bossSpawns = bossSpawns;
  g.bosses = (m.bosses || []).map((b) => ({ name: b.boss.name, chance: Math.round((b.spawnChance || 0) * 100) }))
    .filter((b, i, a) => a.findIndex((x) => x.name === b.name) === i)
    .sort((a, b) => b.chance - a.chance);
}

// --- этажи карты ---
// Источники слоёв-этажей в SVG: атрибут data-layer (Таможня/Берег/Эпицентр) ИЛИ id группы
// (Развязка использует <g id="First_Floor"> без data-layer). Выбираемые кнопки-этажи и их названия
// берём из maps.json (m.layers: name + svgLayer). Слой, который есть в SVG, но не назван в maps.json
// (напр. First_Floor на Таможне) — это «база» (показывается вместе с землёй, отдельной кнопки нет).
const FLOOR_ORDER = ['Ground_Level', 'Ground_Floor', 'Underground_Level', 'Basement', 'Garage', 'Bunkers', 'Tunnels', 'First_Floor', 'Second_Floor', 'Third_Floor', 'Fourth_Floor', 'Fifth_Floor'];
const NAME_RU = { Underground: 'Подвал', Garage: 'Подвал', Basement: 'Подвал', Bunkers: 'Бункеры', Tunnels: 'Тоннели', Ground: 'Земля', '1st Floor': '1 этаж', '2nd Floor': '2 этаж', '3rd Floor': '3 этаж', '4th Floor': '4 этаж', '5th Floor': '5 этаж' };
const fOrder = (id) => { const i = FLOOR_ORDER.indexOf(id); return i < 0 ? 99 : i; };
for (const [slug, g] of Object.entries(out)) {
  try {
    const svgText = await (await fetch(g.svg)).text();
    const gids = new Set([...svgText.matchAll(/<g[^>]*\bid="([^"]+)"/g)].map((m) => m[1]));
    const dlayers = new Set([...svgText.matchAll(/data-layer="([^"]+)"/g)].map((m) => m[1]));
    // именованные этажи из maps.json, реально присутствующие в SVG (id группы или data-layer)
    const named = [];
    for (const l of g._layers || []) {
      if (l.svgLayer && (gids.has(l.svgLayer) || dlayers.has(l.svgLayer))) named.push({ id: l.svgLayer, name: NAME_RU[l.name] || l.name });
    }
    // слои-этажи: только из data-layer (явная разметка) + именованные из maps.json + слой земли
    const all = new Set([...dlayers, ...named.map((n) => n.id)]);
    const groundId = ['Ground_Level', 'Ground_Floor'].find((id) => gids.has(id) || dlayers.has(id));
    if (groundId) all.add(groundId);
    const ordered = [...all].sort((a, b) => fOrder(a) - fOrder(b));
    if (ordered.length > 1) {
      g.floors = ordered;
      // «База» (слой показывается вместе с землёй, без отдельной кнопки) выделяем только когда
      // в maps.json есть именованные этажи — тогда лишний data-layer (напр. First_Floor на Таможне)
      // это наземная постройка. Если имён нет (напр. Лаборатория) — все слои выбираемые.
      const selectable = named.length
        ? new Set([groundId || ordered[0], ...named.map((n) => n.id)])
        : new Set(ordered);
      const base = ordered.filter((id) => !selectable.has(id));
      if (base.length) g.base = base;
      const names = {};
      for (const n of named) names[n.id] = n.name;
      if (Object.keys(names).length) g.floorNames = names;
    } else {
      delete g.floors;
    }
  } catch { /* оставляем без этажей */ }
  delete g._layers;
}

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(path.join(ROOT, 'data', 'maps-geo.json'), json, 'utf8');
fs.writeFileSync(path.join(ROOT, 'data', 'maps-geo.js'), 'window.__MAPSGEO__=' + json + ';\n', 'utf8');
console.log('maps with geo:', Object.keys(out).join(', '));
