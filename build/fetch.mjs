// Fetches all Escape from Tarkov quests from the tarkov.dev JSON API (json.tarkov.dev, Russian)
// and saves them to build/tasks_raw.json in the same shape the old GraphQL query returned
// (so transform.mjs reads it unchanged), plus extra fields: traderRequirements, start delays,
// neededKeys, trader loyalty levels.
// Run: node build/fetch.mjs
//
// Почему не GraphQL: api.tarkov.dev/graphql с осени 2026 отвечает «GraphQL server unavailable»,
// а сайт tarkov.dev сам перешёл на статичные JSON (см. the-hideout/tarkov-data-manager,
// data/json_api_endpoints.json). В этих JSON все ссылки — id, а тексты — ключи словаря *_ru.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dir, 'tasks_raw.json');
const BASE = 'https://json.tarkov.dev/regular/';

async function get(name) {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`${name}: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const [tasksD, tasksRu, itemsD, itemsRu, mapsD, mapsRu, tradersD, tradersRu] = await Promise.all(
  ['tasks', 'tasks_ru', 'items', 'items_ru', 'maps', 'maps_ru', 'traders', 'traders_ru'].map(get),
);

// ключ словаря -> русский текст (ключи без перевода оставляем как есть)
const tr = (dict) => (k) => (k == null ? k : dict[k] ?? k);
const tT = tr(tasksRu), tI = tr(itemsRu), tM = tr(mapsRu), tTr = tr(tradersRu);

const mapRef = (id) => {
  const m = mapsD.maps[id];
  return m ? { id, name: tM(m.name), normalizedName: m.normalizedName } : null;
};
const traderRef = (id) => {
  const t = tradersD[id];
  return t ? { id, name: tTr(t.name) } : null;
};
const itemRef = (id) => {
  const it = itemsD.items[id];
  if (!it) return null;
  return { id, name: tI(it.name), shortName: tI(it.shortName), iconLink: it.iconLink, image512pxLink: it.image512pxLink };
};
const questItemRef = (id) => {
  const it = tasksD.questItems[id];
  if (!it) return null;
  return { id, name: tT(it.name), shortName: tT(it.shortName), iconLink: it.iconLink, image512pxLink: it.image512pxLink };
};
const taskRef = (id) => {
  const t = tasksD.tasks[id];
  return { id, name: t ? tT(t.name) : id };
};
const items = (ids) => (ids || []).map(itemRef).filter(Boolean);
const zones = (zs) => (zs || []).map((z) => ({ map: mapRef(z.map), position: z.position })).filter((z) => z.map);

function objective(o) {
  const out = {
    id: o.id,
    type: o.type,
    description: tT(o.description),
    optional: !!o.optional,
    maps: (o.maps || []).map(mapRef).filter(Boolean),
  };
  if (o.requiredKeys) out.requiredKeys = o.requiredKeys.map((grp) => items(grp));
  if (o.zones) out.zones = zones(o.zones);
  if (o.count != null) out.count = o.count;
  if (o.foundInRaid != null) out.foundInRaid = o.foundInRaid;
  if (o.items) out.items = items(o.items);
  if (o.markerItem) out.markerItem = itemRef(o.markerItem);
  if (o.questItem) out.questItem = questItemRef(o.questItem);
  if (o.possibleLocations)
    out.possibleLocations = o.possibleLocations
      .map((pl) => ({ map: mapRef(pl.map), positions: pl.positions }))
      .filter((pl) => pl.map);
  if (o.targetNames) {
    out.targetNames = o.targetNames.map(tT);
    out.targetKeys = o.targetNames; // исходные ключи (bossKilla, followerBully…) — для привязки к картам боссов
  }
  if (o.shotType) out.shotType = o.shotType;
  if (o.usingWeapon) out.usingWeapon = items(o.usingWeapon);
  if (o.exitName) out.exitName = tT(o.exitName);
  if (o.useAny) out.useAny = items(o.useAny);
  if (o.item) out.item = itemRef(o.item);
  if (o.type === 'taskStatus' && o.task) {
    out.task = taskRef(o.task);
    out.status = o.status;
  }
  if (o.trader) out.trader = traderRef(o.trader);
  if (o.level != null) out.level = o.level;
  return out;
}

const tasks = Object.values(tasksD.tasks).map((t) => {
  const prestige = t.requiredPrestige ? tasksD.prestige.find((p) => p.id === t.requiredPrestige) : null;
  return {
    id: t.id,
    name: tT(t.name),
    normalizedName: t.normalizedName,
    experience: t.experience,
    minPlayerLevel: t.minPlayerLevel,
    kappaRequired: t.kappaRequired,
    lightkeeperRequired: t.lightkeeperRequired,
    factionName: t.factionName,
    restartable: t.restartable,
    requiredPrestige: prestige ? { prestigeLevel: prestige.prestigeLevel } : null,
    wikiLink: t.wikiLink,
    taskImageLink: t.taskImageLink,
    trader: traderRef(t.trader),
    map: t.map ? mapRef(t.map) : null,
    taskRequirements: t.taskRequirements.map((r) => ({ task: taskRef(r.task), status: r.status })),
    // новое после патча: квест открывается по уровню лояльности / репутации торговца
    traderRequirements: (t.traderRequirements || []).map((r) => ({
      trader: traderRef(r.trader),
      requirementType: r.requirementType,
      compareMethod: r.compareMethod,
      value: r.value,
    })),
    // прочие условия открытия: globalVariable — скрытый счётчик «группы» заданий торговца
    // (что его увеличивает, в данных нет), dialogue — разговор с торговцем
    otherRequirements: (t.otherRequirements || []).map((o) =>
      o.type === 'globalVariable'
        ? { type: o.type, variableId: o.variableId, compareMethod: o.compareMethod, value: o.value }
        : { type: o.type, traders: (o.traders || []).map(traderRef).filter(Boolean) },
    ),
    availableDelaySecondsMin: t.availableDelaySecondsMin ?? null,
    availableDelaySecondsMax: t.availableDelaySecondsMax ?? null,
    neededKeys: (t.neededKeys || []).map((nk) => ({ map: mapRef(nk.map), keys: items(nk.keys) })),
    failConditions: (t.failConditions || []).map((f) =>
      f.type === 'taskStatus'
        ? { __typename: 'TaskObjectiveTaskStatus', task: taskRef(f.task), status: f.status }
        : { __typename: 'TaskObjective', type: f.type },
    ),
    objectives: t.objectives.map(objective),
  };
});

// уровни лояльности торговцев: LL -> нужный уровень игрока и репутация
const traders = Object.values(tradersD).map((t) => ({
  id: t.id,
  name: tTr(t.name),
  normalizedName: t.normalizedName,
  levels: (t.levels || []).map((l) => ({
    level: l.level,
    requiredPlayerLevel: l.requiredPlayerLevel,
    requiredReputation: l.requiredReputation,
  })),
}));

// боссы и карты, где они появляются (для целей «убить босса» без указанной локации).
// Терминал пропускаем: в данных там перечислены почти все боссы.
const bosses = {};
for (const m of Object.values(mapsD.maps)) {
  if (m.normalizedName === 'terminal') continue;
  for (const b of m.bosses || []) {
    if (!(b.spawnChance > 0)) continue;
    const e = (bosses[b.mob] ||= { key: b.mob, name: tM(mapsD.mobs[b.mob]?.name ?? b.mob), maps: [] });
    if (!e.maps.some((x) => x.id === m.id)) e.maps.push(mapRef(m.id));
  }
}

const json = { data: { tasks, traders, bosses: Object.values(bosses) }, fetchedAt: new Date().toISOString(), source: BASE };
fs.writeFileSync(OUT, JSON.stringify(json), 'utf8');
console.log(`Fetched ${tasks.length} tasks -> ${path.relative(path.join(__dir, '..'), OUT)} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
