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
      // svgBounds = реальные углы SVG-картинки; bounds = игровая (проходимая) область.
      // Маркеры позиционируются в % от картинки, поэтому нормируем по svgBounds, если он есть
      // (различаются, напр., у Резерва — иначе маркеры уезжают вниз).
      bounds: m.svgBounds || m.bounds,
      _layers: m.layers || [], // именованные этажи из maps.json (удаляется перед выводом)
    };
    // экстенты этажей: floor -> [[x1,z1,x2,z2,hmin,hmax], ...] (для привязки квест-маркеров к этажу)
    const extents = {};
    for (const l of m.layers || []) {
      if (!l.svgLayer) continue;
      const rects = [];
      for (const e of l.extents || []) {
        const h = e.height; if (!h) continue;
        const bs = (e.bounds || []).filter((b) => Array.isArray(b) && b[0] && b[1]);
        if (bs.length) {
          for (const b of bs) rects.push([b[0][0], b[0][1], b[1][0], b[1][1], h[0], h[1]]);
        } else {
          // высота без bounds: этажи различаются ТОЛЬКО по высоте (Улицы, Завод) —
          // покрываем весь прямоугольник карты этим диапазоном высоты.
          const mb = m.bounds;
          rects.push([mb[0][0], mb[0][1], mb[1][0], mb[1][1], h[0], h[1]]);
        }
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
    out['the-lab'] = { svg: 'https://assets.tarkov.dev/maps/svg/Labs.svg', rotation: lm.coordinateRotation || 0, sx: lm.transform[0], sy: lm.transform[2] * -1, bounds: lm.svgBounds || lm.bounds };
  }
}

// --- выходы (только PMC + общие, без чисто диких), переходы и спавны боссов ---
// Источник — статичные JSON tarkov.dev (json.tarkov.dev/regular/maps + словарь maps_ru): GraphQL
// api.tarkov.dev с осени 2026 не отвечает. Зоны боссов: boss.spawnLocations[].spawnKey совпадает со
// spawn.zoneName (если у зоны нет своих positions) — берём центроид зоны, один маркер на зону.
const r1 = (n) => Math.round(n * 10) / 10;
const getJson = async (name) => {
  const r = await fetch('https://json.tarkov.dev/regular/' + name);
  if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
  return (await r.json()).data;
};
const [mapsD, mapsRu] = await Promise.all([getJson('maps'), getJson('maps_ru')]);
// прошлый maps-geo.json: у части зон боссов в JSON нет координат (напр. Общага/Заправка на Таможне),
// а в старом GraphQL они были — такие точки сохраняем, чтобы маркеры не пропадали
let prevGeo = {};
try { prevGeo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'maps-geo.json'), 'utf8')); } catch {}
const tr = (k) => (k == null ? k : mapsRu[k] ?? k);
const mobName = (id) => tr(mapsD.mobs[id]?.name ?? id);
const allMaps = Object.values(mapsD.maps);
// карта-вариант (ночной Завод, Эпицентр 21+, тёмная Лаборатория) -> основная карта с SVG
const slugOf = (id) => {
  const n = mapsD.maps[id]?.normalizedName;
  return { 'night-factory': 'factory', 'ground-zero-21': 'ground-zero', 'ground-zero-tutorial': 'ground-zero', 'the-lab-dark': 'the-lab' }[n] || n;
};
for (const m of allMaps) {
  const g = out[m.normalizedName];
  if (!g) continue;
  g.extracts = (m.extracts || [])
    .filter((e) => e.position && /pmc|shared/i.test(e.faction || ''))
    .map((e) => ({ name: tr(e.name), faction: (e.faction || 'shared').toLowerCase(), x: r1(e.position.x), z: r1(e.position.z), y: r1(e.position.y) }));
  // переходы между локациями (транзиты): куда ведёт + точка
  g.transits = (m.transits || [])
    .filter((t) => t.position)
    .map((t) => ({ name: tr(t.description), to: slugOf(t.map) || null, x: r1(t.position.x), z: r1(t.position.z), y: r1(t.position.y) }));

  const bosses = (m.bosses || []).filter((b) => b.spawnChance > 0);
  // zoneName -> set of boss names; точки зоны — из spawnLocations[].positions или из spawns
  const zoneBosses = {}, zonePts = {};
  for (const b of bosses)
    for (const sl of b.spawnLocations || []) {
      if (!sl.spawnKey) continue;
      (zoneBosses[sl.spawnKey] ||= new Set()).add(mobName(b.mob));
      if (sl.positions?.length) (zonePts[sl.spawnKey] ||= []).push(...sl.positions);
    }
  const ownPts = new Set(Object.keys(zonePts)); // у этих зон точки уже есть из spawnLocations
  for (const s of m.spawns || []) if (s.position && zoneBosses[s.zoneName] && !ownPts.has(s.zoneName)) (zonePts[s.zoneName] ||= []).push(s.position);
  const bossSpawns = [];
  for (const [zone, pts] of Object.entries(zonePts)) {
    if (!pts.length) continue;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cz = pts.reduce((a, p) => a + p.z, 0) / pts.length, cy = pts.reduce((a, p) => a + (p.y || 0), 0) / pts.length;
    bossSpawns.push({ x: r1(cx), z: r1(cz), y: r1(cy), bosses: [...zoneBosses[zone]] });
  }
  for (const p of prevGeo[m.normalizedName]?.bossSpawns || []) {
    const near = bossSpawns.find((s) => Math.hypot(s.x - p.x, s.z - p.z) < 15);
    if (near) for (const n of p.bosses) { if (!near.bosses.includes(n)) near.bosses.push(n); }
    else bossSpawns.push(p);
  }
  g.bossSpawns = bossSpawns;
  g.bosses = bosses
    .map((b) => ({ name: mobName(b.mob), chance: Math.round((b.spawnChance || 0) * 100) }))
    .filter((b, i, a) => a.findIndex((x) => x.name === b.name) === i)
    .sort((a, b) => b.chance - a.chance);
}

// Лаборатория: этажи в конфиге tarkov.dev заданы тайлами (без svgLayer), поэтому экстенты
// по высоте задаём вручную по их maps.json: ниже -0.9 — технический уровень, выше 3 в зоне
// [[-101,-422],[-271,-270]] — второй, остальное — первый (он же «земля» по умолчанию).
if (out['the-lab']) {
  const lb = out['the-lab'].bounds;
  out['the-lab'].ground = 'First_Level';
  out['the-lab'].extents = {
    Technical_Level: [[lb[0][0], lb[0][1], lb[1][0], lb[1][1], -10000, -0.9]],
    Second_Level: [[-101, -422, -271, -270, 3, 10000]],
  };
}

// --- этажи карты ---
// Источники слоёв-этажей в SVG: атрибут data-layer (Таможня/Берег/Эпицентр) ИЛИ id группы
// (Развязка использует <g id="First_Floor"> без data-layer). Выбираемые кнопки-этажи и их названия
// берём из maps.json (m.layers: name + svgLayer). Слой, который есть в SVG, но не назван в maps.json
// (напр. First_Floor на Таможне) — это «база» (показывается вместе с землёй, отдельной кнопки нет).
const FLOOR_ORDER = ['Ground_Level', 'Ground_Floor', 'Underground_Level', 'Basement', 'Garage', 'Bunkers', 'Tunnels', 'First_Floor', 'Second_Floor', 'Third_Floor', 'Fourth_Floor', 'Fifth_Floor'];
const NAME_RU = { Underground: 'Подвал', Garage: 'Подвал', Basement: 'Подвал', Bunkers: 'Бункеры', Tunnels: 'Тоннели', Ground: 'Земля', '1st Floor': '1 этаж', '2nd Floor': '2 этаж', '3rd Floor': '3 этаж', '4th Floor': '4 этаж', '5th Floor': '5 этаж' };
const fOrder = (id) => { const i = FLOOR_ORDER.indexOf(id); return i < 0 ? 99 : i; };
// Скачиваем SVG карт локально (data/maps/<slug>.svg), чтобы карта грузилась напрямую,
// без обращения к assets.tarkov.dev. Исходный URL сохраняем в svgRemote как фолбэк.
const MAPS_DIR = path.join(ROOT, 'data', 'maps');
fs.mkdirSync(MAPS_DIR, { recursive: true });
for (const [slug, g] of Object.entries(out)) {
  try {
    const svgText = await (await fetch(g.svg)).text();
    fs.writeFileSync(path.join(MAPS_DIR, slug + '.svg'), svgText, 'utf8');
    g.svgRemote = g.svg;
    g.svg = 'data/maps/' + slug + '.svg';
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
