// Transforms tarkov.dev raw task dump into a clean, shareable quests.json
// Run: node build/transform.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const raw = JSON.parse(fs.readFileSync(path.join(__dir, 'tasks_raw.json'), 'utf8'));
const tasks = raw.data.tasks;

// ---- Russian action labels per objective type --------------------------
const ACTION = {
  findItem: 'Найти',
  giveItem: 'Сдать',
  plantItem: 'Оставить',
  mark: 'Маркер',
  findQuestItem: 'Найти предмет',
  giveQuestItem: 'Сдать предмет',
  plantQuestItem: 'Оставить предмет',
  shoot: 'Убить',
  visit: 'Посетить',
  extract: 'Выход',
  buildWeapon: 'Собрать оружие',
  useItem: 'Использовать',
  skill: 'Навык',
  traderLevel: 'Уровень торговца',
  traderStanding: 'Репутация',
  taskStatus: 'Статус квеста',
  sellItem: 'Продать',
  repair: 'Починить',
  experience: 'Опыт',
  dialogue: 'Поговорить',
  globalVariable: 'Условие',
  playerLevel: 'Уровень',
};

// ---- Map canonicalisation (merge night/21+ variants) -------------------
function canonMap(name) {
  if (!name) return name;
  let n = name.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/\s*21\+$/, '');
  if (/Завод/.test(n)) n = 'Завод'; // merge day/night Factory
  if (/^Лаборатория/.test(n)) n = 'Лаборатория'; // + «Лаборатория (Dark)»
  if (/^Ground Zero/.test(n)) n = 'Эпицентр'; // обучающий Эпицентр
  return n;
}
// id карт (map_N) должны быть стабильны между пересборками: на них ссылаются фильтры и выбор
// пользователя. Поэтому берём уже выданные id из прошлого data/quests.json, новым — следующий номер.
const canonMaps = new Map(); // canonical name -> {id, name}
let nextMapNo = 1;
try {
  const prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'quests.json'), 'utf8'));
  for (const m of prev.maps || []) {
    canonMaps.set(m.name, { id: m.id, name: m.name, unused: true });
    nextMapNo = Math.max(nextMapNo, parseInt(m.id.replace('map_', ''), 10) + 1);
  }
} catch {}
function mapId(name) {
  const c = canonMap(name);
  if (!canonMaps.has(c)) canonMaps.set(c, { id: 'map_' + nextMapNo++, name: c });
  const m = canonMaps.get(c);
  delete m.unused;
  return m.id;
}

// ---- Item registry -----------------------------------------------------
const items = {}; // id -> {id,name,shortName,icon,quest}
function regItem(it, isQuest = false) {
  if (!it || !it.id) return;
  if (!items[it.id]) {
    items[it.id] = {
      id: it.id,
      name: it.name || '',
      shortName: it.shortName || it.name || '',
      icon: it.iconLink || null,
      img: (it.image512pxLink && !/unknown-item/.test(it.image512pxLink)) ? it.image512pxLink : (it.iconLink || null),
      quest: isQuest || undefined,
    };
  }
}

// ---- Trader registry ---------------------------------------------------
const traders = {};
function regTrader(t) {
  if (t && t.id && !traders[t.id]) traders[t.id] = { id: t.id, name: t.name };
  return t ? t.id : null;
}

// ---- Objective classification -----------------------------------------
// bring   = ВЗЯТЬ С СОБОЙ / ЗАЛОЖИТЬ (маркеры, камеры, заложить предмет, оружие для убийства, использовать)
// handIn  = НАЙТИ / КУПИТЬ И СДАТЬ торговцу (передать предметы, собрать оружие)
// keys    = ключи, которые нужно взять
const CATEGORY_THRESHOLD = 5; // giveItem с таким числом допустимых предметов трактуем как "категорию"
const isCamera = (n) => /камер|camera/i.test(n || '');

function classify(o) {
  const out = {
    id: o.id,
    type: o.type,
    action: ACTION[o.type] || o.type,
    description: o.description || '',
    optional: !!o.optional,
    maps: [...new Set((o.maps || []).map((m) => mapId(m.name)))],
    bring: [],   // ВЗЯТЬ С СОБОЙ / ЗАЛОЖИТЬ
    handIn: [],  // НАЙТИ/КУПИТЬ И СДАТЬ
    keys: [],    // ключи (каждая запись = "один из")
    count: o.count || null,
    target: null,
  };

  for (const grp of o.requiredKeys || []) {
    const ids = (grp || []).map((k) => { regItem(k); return k.id; });
    if (ids.length) out.keys.push(ids.length === 1 ? ids[0] : { anyOf: ids });
  }

  switch (o.type) {
    case 'findItem':
      for (const it of o.items || []) { regItem(it); out.handIn.push({ item: it.id, count: o.count || 1, fir: !!o.foundInRaid, kind: 'find' }); }
      break;
    case 'giveItem': {
      const ids = (o.items || []).map((it) => { regItem(it); return it.id; });
      const e = { count: o.count || 1, fir: !!o.foundInRaid };
      if (ids.length >= CATEGORY_THRESHOLD) out.handIn.push({ ...e, category: o.description || 'категория предметов', items: ids, kind: 'category' });
      else if (ids.length > 1) out.handIn.push({ ...e, anyOf: ids, kind: 'handin' });
      else if (ids.length === 1) out.handIn.push({ ...e, item: ids[0], kind: 'handin' });
      break;
    }
    case 'findQuestItem':
    case 'giveQuestItem':
      if (o.questItem) { regItem(o.questItem, true); out.handIn.push({ item: o.questItem.id, count: o.count || 1, fir: true, quest: true, kind: 'handin' }); }
      break;
    case 'plantItem':
      for (const it of o.items || []) {
        regItem(it);
        const cam = isCamera(it.name);
        if (cam) out.action = 'Камера';
        out.bring.push({ item: it.id, count: o.count || 1, kind: cam ? 'camera' : 'plant' });
      }
      break;
    case 'plantQuestItem':
      if (o.questItem) {
        regItem(o.questItem, true);
        const cam = isCamera(o.questItem.name);
        if (cam) out.action = 'Камера';
        out.bring.push({ item: o.questItem.id, count: o.count || 1, kind: cam ? 'camera' : 'plant', quest: true });
      }
      break;
    case 'mark':
      if (o.markerItem) { regItem(o.markerItem); out.bring.push({ item: o.markerItem.id, count: 1, kind: 'marker' }); }
      break;
    case 'useItem': {
      const ids = (o.useAny || []).map((it) => { regItem(it); return it.id; });
      if (ids.length === 1) out.bring.push({ item: ids[0], count: o.count || 1, kind: 'use' });
      else if (ids.length > 1) out.bring.push({ anyOf: ids, count: o.count || 1, kind: 'use' });
      break;
    }
    case 'buildWeapon':
      if (o.item) { regItem(o.item); out.handIn.push({ item: o.item.id, count: 1, kind: 'build' }); }
      break;
    case 'shoot': {
      out.target = (o.targetNames || []).join(', ') || null;
      const ids = (o.usingWeapon || []).map((w) => { regItem(w); return w.id; });
      if (ids.length === 1) out.bring.push({ item: ids[0], count: 1, kind: 'weapon' });
      else if (ids.length > 1) out.bring.push({ anyOf: ids, count: 1, kind: 'weapon' });
      break;
    }
    case 'extract':
      out.target = o.exitName || null;
      break;
  }

  // координаты цели (для маркеров на карте): zones и possibleLocations (x,z + высота y для этажа)
  const r1 = (n) => Math.round(n * 10) / 10;
  const coords = [];
  for (const zn of o.zones || []) if (zn && zn.position && zn.map) coords.push({ m: mapId(zn.map.name), x: r1(zn.position.x), z: r1(zn.position.z), y: r1(zn.position.y) });
  for (const pl of o.possibleLocations || []) if (pl && pl.map) for (const p of pl.positions || []) coords.push({ m: mapId(pl.map.name), x: r1(p.x), z: r1(p.z), y: r1(p.y) });
  if (coords.length) out.coords = coords;

  return out;
}

// ---- Группы заданий торговцев (патч 1.1) --------------------------------
// После переработки квесты торговца приходят группами: квест открывается, когда скрытый счётчик
// группы (globalVariable) >= N (обычно ступени 1 / 3 / 5). Что увеличивает счётчик, tarkov.dev
// не отдаёт, поэтому группы используются для отображения/раскладки, а не для блокировки.
const groupsByVar = new Map(); // variableId -> {id, trader, values:Set}
for (const t of tasks)
  for (const o of t.otherRequirements || [])
    if (o.type === 'globalVariable') {
      if (!groupsByVar.has(o.variableId)) groupsByVar.set(o.variableId, { variableId: o.variableId, trader: t.trader?.id, values: new Set(), minVal: Infinity });
      const g = groupsByVar.get(o.variableId);
      g.values.add(o.value);
      g.minVal = Math.min(g.minVal, o.value);
    }
// нумерация групп внутри торговца: стабильно по variableId (id в BSG растут со временем)
const groupsArr = [];
const perTrader = {};
for (const g of [...groupsByVar.values()].sort((a, b) => a.variableId.localeCompare(b.variableId))) {
  perTrader[g.trader] = (perTrader[g.trader] || 0) + 1;
  g.id = 'g' + (groupsArr.length + 1);
  groupsArr.push({ id: g.id, var: g.variableId, trader: g.trader, n: perTrader[g.trader], tiers: [...g.values].sort((a, b) => a - b) });
}

// ---- Build tasks -------------------------------------------------------
const outTasks = tasks.map((t) => {
  const objectives = (t.objectives || []).map(classify);
  const objMaps = new Set();
  for (const o of objectives) o.maps.forEach((m) => objMaps.add(m));
  if (objMaps.size === 0 && t.map) objMaps.add(mapId(t.map.name));

  const failedBy = (t.failConditions || [])
    .filter((f) => f.__typename === 'TaskObjectiveTaskStatus' && f.task && (f.status || []).includes('complete'))
    .map((f) => f.task.id);

  // условия открытия по торговцу (после патча осени 2026 большая часть веток открывается так):
  // level — уровень лояльности (LL), reputation — репутация
  const unlock = (t.traderRequirements || [])
    .filter((r) => r.trader && (r.requirementType === 'level' || r.requirementType === 'reputation'))
    .map((r) => ({ trader: regTrader(r.trader), type: r.requirementType, cmp: r.compareMethod, value: r.value }));
  const gv = (t.otherRequirements || []).find((o) => o.type === 'globalVariable');
  const gate = gv ? { group: groupsByVar.get(gv.variableId).id, value: gv.value } : undefined;
  const talkTo = (t.otherRequirements || []).filter((o) => o.type === 'dialogue').flatMap((o) => (o.traders || []).map(regTrader));
  const neededKeys = (t.neededKeys || [])
    .map((nk) => ({ map: nk.map ? mapId(nk.map.name) : null, keys: (nk.keys || []).map((k) => { regItem(k); return k.id; }) }))
    .filter((nk) => nk.keys.length);

  return {
    id: t.id,
    name: t.name,
    normalizedName: t.normalizedName,
    trader: regTrader(t.trader),
    faction: t.factionName && t.factionName !== 'Any' ? t.factionName : null,
    minLevel: t.minPlayerLevel || null,
    prestige: t.requiredPrestige ? t.requiredPrestige.prestigeLevel : undefined,
    kappa: !!t.kappaRequired,
    lightkeeper: !!t.lightkeeperRequired,
    restartable: !!t.restartable,
    wiki: t.wikiLink || null,
    image: t.taskImageLink || null,
    maps: [...objMaps],
    requires: (t.taskRequirements || [])
      .filter((r) => r.task)
      .map((r) => ({ task: r.task.id, status: r.status || ['complete'] })),
    unlock: unlock.length ? unlock : undefined,
    gate,
    talkTo: talkTo.length ? talkTo : undefined,
    // задержка (сек) между выполнением предыдущего квеста и появлением этого
    delay: t.availableDelaySecondsMax ? { min: t.availableDelaySecondsMin || 0, max: t.availableDelaySecondsMax } : undefined,
    neededKeys: neededKeys.length ? neededKeys : undefined,
    failedBy: [...new Set(failedBy)],
    objectives,
  };
});

// ---- Assemble ----------------------------------------------------------
const mapsArr = [...canonMaps.values()].filter((m) => !m.unused).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
// уровни лояльности (LL -> нужный уровень игрока / репутация) — из fetch.mjs
const traderInfo = new Map((raw.data.traders || []).map((t) => [t.id, t]));
const tradersArr = Object.values(traders)
  .map((t) => {
    const info = traderInfo.get(t.id);
    const levels = (info?.levels || [])
      .filter((l) => l.level >= 1)
      .map((l) => ({ ll: l.level, playerLevel: l.requiredPlayerLevel, rep: l.requiredReputation }));
    return levels.length > 1 ? { ...t, levels } : t;
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

const data = {
  meta: {
    source: raw.source || 'https://api.tarkov.dev/graphql',
    fetchedAt: raw.fetchedAt || undefined,
    lang: 'ru',
    taskCount: outTasks.length,
    itemCount: Object.keys(items).length,
    note: 'Сгенерировано из tarkov.dev. bring=взять с собой/заложить, handIn=найти-купить-сдать, keys=ключи.',
  },
  maps: mapsArr,
  traders: tradersArr,
  groups: groupsArr,
  items,
  tasks: outTasks,
};

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
const json = JSON.stringify(data);
fs.writeFileSync(path.join(ROOT, 'data', 'quests.json'), json, 'utf8');
// Fallback for opening index.html directly via file:// (fetch of local json is blocked there)
fs.writeFileSync(path.join(ROOT, 'data', 'quests-data.js'), 'window.__QUESTS__=' + json + ';\n', 'utf8');

// pretty stats
const size = fs.statSync(path.join(ROOT, 'data', 'quests.json')).size;
console.log('tasks:', outTasks.length, '| items:', Object.keys(items).length, '| maps:', mapsArr.length, '| traders:', tradersArr.length);
console.log('quests.json size:', (size / 1024).toFixed(1), 'KB');
console.log('maps:', mapsArr.map((m) => m.name).join(', '));
const failTasks = outTasks.filter((t) => t.failedBy.length).length;
console.log('tasks with auto-fail dependency:', failTasks);
