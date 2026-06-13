'use strict';
/* ============================================================
   Tarkov Help — quest tracker, raid planner & loot finder
   Data: data/quests.json, data/items.json (from api.tarkov.dev)
   State: IndexedDB (fallback localStorage / memory)
   ============================================================ */

// ---------- Storage: IndexedDB with localStorage / memory fallback ------
// Versioning (see migrateData() below):
//   DB_VERSION   — структурная версия IndexedDB (объектные хранилища). Бамп => onupgradeneeded.
//   DATA_VERSION — версия ФОРМАТА хранимых значений. Бамп => миграции данных в migrateData().
// Это позволяет безопасно обновлять сайт на gh-pages: у существующих пользователей
// данные мигрируются, а не ломаются.
const DB_VERSION = 1;
const DATA_VERSION = 1;
const DB = (() => {
  const NAME = 'tarkov_help', STORE = 'kv', OPEN_TIMEOUT = 2500;
  let mode = 'idb', dbp = null;
  const mem = {};
  function lsOk() { try { localStorage.setItem('__th_test', '1'); localStorage.removeItem('__th_test'); return true; } catch { return false; } }
  function openIdb() {
    return new Promise((res, rej) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; rej(new Error('idb open timeout')); } }, OPEN_TIMEOUT);
      let r;
      try { r = indexedDB.open(NAME, DB_VERSION); } catch (e) { clearTimeout(to); return rej(e); }
      r.onupgradeneeded = (ev) => {
        const db = r.result, old = ev.oldVersion || 0;
        // Лестница структурных миграций. Новые версии добавляйте ниже, не меняя прошлые.
        if (old < 1) { if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }); }
        // if (old < 2) { ... добавить/изменить хранилища для DB_VERSION=2 ... }
      };
      r.onsuccess = () => { if (done) return; done = true; clearTimeout(to); res(r.result); };
      r.onerror = () => { if (done) return; done = true; clearTimeout(to); rej(r.error || new Error('idb error')); };
    });
  }
  async function ensure() {
    if (mode !== 'idb') return;
    if (!('indexedDB' in window) || !window.indexedDB) { mode = lsOk() ? 'ls' : 'mem'; return; }
    if (!dbp) dbp = openIdb();
    try { await dbp; } catch { dbp = null; mode = lsOk() ? 'ls' : 'mem'; console.warn('[storage] IndexedDB недоступен, переключаюсь на', mode); }
  }
  async function get(key, def) {
    await ensure();
    if (mode === 'idb') {
      try { const db = await dbp; return await new Promise((res) => { const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key); tx.onsuccess = () => res(tx.result ? tx.result.value : def); tx.onerror = () => res(def); }); }
      catch { mode = lsOk() ? 'ls' : 'mem'; }
    }
    if (mode === 'ls') { try { const v = localStorage.getItem('th_' + key); return v == null ? def : JSON.parse(v); } catch { return def; } }
    return key in mem ? mem[key] : def;
  }
  async function set(key, value) {
    await ensure();
    if (mode === 'idb') {
      try { const db = await dbp; return await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put({ key, value }); tx.oncomplete = () => res(); tx.onerror = () => res(); }); }
      catch { mode = lsOk() ? 'ls' : 'mem'; }
    }
    if (mode === 'ls') { try { localStorage.setItem('th_' + key, JSON.stringify(value)); } catch {} return; }
    mem[key] = value;
  }
  return { get, set, mode: () => mode };
})();

// ---------- Global state ------------------------------------------------
let data = null;
const taskById = new Map();
const itemById = new Map();
const mapById = new Map();
const traderById = new Map();
const unlocksMap = new Map();      // taskId -> [taskIds it unlocks]
const failsOnComplete = new Map(); // taskId -> [taskIds that fail when this completes]
let failedAll = new Set();
let collectorTask = null;          // квест "Коллекционер" (предметы для Каппы)

// ---- Прогресс по целям квестов (сделано из N) -------------------------
const objDone = (id) => state.progress[id] || 0;
const NON_TRACKABLE = new Set(['skill', 'traderLevel', 'traderStanding', 'experience', 'playerLevel', 'taskStatus']);
const trackable = (o) => !NON_TRACKABLE.has(o.type);
const objTotal = (o) => o.count || 1;
const objRemaining = (o) => Math.max(0, objTotal(o) - objDone(o.id));

const state = {
  completed: new Set(),
  failed: new Set(),
  active: new Set(),       // "мои квесты"
  plan: new Set(),         // выбраны для рейда
  planChoices: {},
  findGroups: [],          // [{id,name,desc,items:[{id,found,qty}]}]
  progress: {},            // objectiveId -> сколько единиц цели уже сделано
};
const ui = {
  view: 'mine',
  expanded: new Set(),
  onbQuery: '',
  plannerTab: 'plan',
  map: { z: 0, x: 0, y: 0 },
  mapLayers: { extracts: true, bosses: true, quests: true },
  mapFullscreen: false,
  mapFloor: null,
  kappaSearch: '',
  kappaHideFound: false,
  sort: { col: 'status', dir: 1 },
  filters: { search: '', map: '', trader: '', action: '', status: '', faction: '', kappa: false, plan: false, showdone: false, showmine: false },
};

const STATUS_RU = { available: 'Доступен', locked: 'Заблокирован', completed: 'Выполнен', failed: 'Провален' };
const STATUS_RANK = { available: 0, locked: 1, completed: 2, failed: 3 };
const MAP_COLORS = {
  'Таможня': '#b8945f', 'Завод': '#8a8f98', 'Лес': '#6f8f4e', 'Берег': '#4e9f9f',
  'Резерв': '#b5604a', 'Маяк': '#5b8fc9', 'Улицы Таркова': '#9b7fc9', 'Развязка': '#d08a3e',
  'Лаборатория': '#c75d8f', 'Эпицентр': '#d4b94e', 'Лабиринт': '#7d5fb0', 'Ледокол': '#7fb0c9',
};
function mapColor(id) {
  const m = mapById.get(id); if (!m) return '#777';
  if (MAP_COLORS[m.name]) return MAP_COLORS[m.name];
  let h = 0; for (const c of m.name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 55%)`;
}

// ---------- Helpers -----------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const itemName = (id) => { const i = itemById.get(id); return i ? i.name : id; };
const itemShort = (id) => { const i = itemById.get(id); return i ? (i.shortName || i.name) : id; };
const itemIcon = (id) => { const i = itemById.get(id); return i ? i.icon : null; };
const itemImg = (id) => { const i = itemById.get(id); return i ? (i.img || i.icon) : null; };
const mapName = (id) => { const m = mapById.get(id); return m ? m.name : id; };
const traderName = (id) => { const t = traderById.get(id); return t ? t.name : id; };
const shorten = (s, n = 60) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- Cookies (для флага первого визита) -------------------------
function getCookie(name) {
  const m = document.cookie.match('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)');
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(name, value, days) {
  let s = name + '=' + encodeURIComponent(value) + '; path=/; SameSite=Lax';
  if (days) s += '; max-age=' + days * 86400;
  try { document.cookie = s; } catch {}
}

// item icon chip (with lightbox hook). cls adds styling.
function itImg(id) { const ic = itemIcon(id); return ic ? `<img src="${ic}" data-item="${id}" loading="lazy" onerror="this.style.display='none'">` : ''; }

// ---------- Status / dependency logic -----------------------------------
function recomputeFailed() {
  const fa = new Set(state.failed);
  for (const t of data.tasks) {
    if (state.completed.has(t.id)) continue;
    if (t.failedBy && t.failedBy.some((fid) => state.completed.has(fid))) fa.add(t.id);
  }
  for (const id of state.completed) fa.delete(id);
  failedAll = fa;
}
function reqMet(t) {
  for (const r of t.requires || []) {
    const st = r.status || ['complete']; let ok = false;
    if ((st.includes('complete') || st.includes('active')) && state.completed.has(r.task)) ok = true;
    if (st.includes('failed') && failedAll.has(r.task)) ok = true;
    if (!ok) return false;
  }
  return true;
}
function statusOf(t) {
  if (state.completed.has(t.id)) return 'completed';
  if (failedAll.has(t.id)) return 'failed';
  if (reqMet(t)) return 'available';
  return 'locked';
}

// ---------- Build indices ----------------------------------------------
function buildIndices() {
  data.tasks.forEach((t) => taskById.set(t.id, t));
  Object.values(data.items).forEach((i) => itemById.set(i.id, i));
  data.maps.forEach((m) => mapById.set(m.id, m));
  data.traders.forEach((t) => traderById.set(t.id, t));
  for (const t of data.tasks) {
    for (const r of t.requires || []) {
      if ((r.status || ['complete']).includes('complete')) {
        if (!unlocksMap.has(r.task)) unlocksMap.set(r.task, []);
        unlocksMap.get(r.task).push(t.id);
      }
    }
    for (const fid of t.failedBy || []) {
      if (!failsOnComplete.has(fid)) failsOnComplete.set(fid, []);
      failsOnComplete.get(fid).push(t.id);
    }
  }
  for (const t of data.tasks) {
    const parts = [t.name, traderName(t.trader)];
    for (const o of t.objectives) {
      parts.push(o.description, o.action);
      for (const b of o.bring) if (b.item) parts.push(itemName(b.item));
      for (const h of o.handIn) { if (h.item) parts.push(itemName(h.item)); if (h.category) parts.push(h.category); }
    }
    for (const mid of t.maps) parts.push(mapName(mid));
    t._search = parts.join(' ').toLowerCase();
  }
  collectorTask = data.tasks.find((t) => t.normalizedName === 'collector') || data.tasks.find((t) => t.name === 'Коллекционер') || null;
}

// ---------- Persistence -------------------------------------------------
async function persistProgress() { await DB.set('completed', [...state.completed]); await DB.set('failed', [...state.failed]); await DB.set('active', [...state.active]); }
async function persistObjProgress() { await DB.set('progress', state.progress); }
async function persistPlan() { await DB.set('plan', [...state.plan]); await DB.set('planChoices', state.planChoices); }
async function persistFinder() { await DB.set('findGroups', state.findGroups); }
// Миграции ФОРМАТА хранимых данных. Запускается до loadState().
async function migrateData() {
  let v = await DB.get('dataVersion', null);
  if (v === null) {
    // Нет версии: либо новый пользователь, либо старый (до версионирования).
    const existing = (await DB.get('findGroups', null)) !== null || (await DB.get('completed', null)) !== null || (await DB.get('active', null)) !== null;
    v = existing ? 0 : DATA_VERSION;
  }
  // Лестница миграций данных. Каждый шаг переводит формат на +1.
  if (v < 1) {
    // v0 -> v1: у предметов в "Списке находок" появилось поле qty (искомое количество).
    const groups = await DB.get('findGroups', []);
    let changed = false;
    for (const g of groups) for (const it of g.items || []) if (it.qty == null) { it.qty = 1; changed = true; }
    if (changed) await DB.set('findGroups', groups);
    v = 1;
  }
  // if (v < 2) { ...; v = 2; }
  if (v !== DATA_VERSION) await DB.set('dataVersion', DATA_VERSION);
}
async function loadState() {
  state.completed = new Set(await DB.get('completed', []));
  state.failed = new Set(await DB.get('failed', []));
  state.active = new Set(await DB.get('active', []));
  state.plan = new Set(await DB.get('plan', []));
  state.planChoices = (await DB.get('planChoices', {})) || {};
  state.findGroups = (await DB.get('findGroups', [])) || [];
  state.progress = (await DB.get('progress', {})) || {};
}

// ---------- Mutations ---------------------------------------------------
function setStatus(id, st) {
  state.completed.delete(id); state.failed.delete(id);
  if (st === 'completed') state.completed.add(id);
  else if (st === 'failed') state.failed.add(id);
  recomputeFailed();
  // auto-add newly unlocked quests into "мои квесты"
  if (st === 'completed') {
    const added = [];
    for (const uid of unlocksMap.get(id) || []) {
      if (state.completed.has(uid) || failedAll.has(uid) || state.active.has(uid)) continue;
      const ut = taskById.get(uid);
      if (ut && reqMet(ut)) { state.active.add(uid); added.push(ut.name); }
    }
    if (added.length) toast('В мои квесты добавлено: ' + added.join(', '));
  }
  persistProgress();
  renderStats(); renderActiveViews();
}
function toggleActive(id) {
  if (state.active.has(id)) state.active.delete(id); else state.active.add(id);
  persistProgress();
  renderStats(); renderActiveViews();
}
// "У меня сейчас этот квест": все предыдущие по ветке -> Выполнен, сам квест -> активен.
function markAsCurrent(id) {
  const toComplete = new Set();
  (function collect(qid) {
    const t = taskById.get(qid); if (!t) return;
    for (const r of t.requires || []) {
      const st = r.status || ['complete'];
      if ((st.includes('complete') || st.includes('active')) && !toComplete.has(r.task)) { toComplete.add(r.task); collect(r.task); }
    }
  })(id);
  for (const q of toComplete) { state.completed.add(q); state.failed.delete(q); }
  state.completed.delete(id); state.failed.delete(id);
  state.active.add(id);
  recomputeFailed();
  persistProgress();
  ui.onbQuery = '';
  renderStats(); renderActiveViews();
  toast(`«${taskById.get(id).name}» — текущий. Предыдущих отмечено выполненными: ${toComplete.size}.`);
}
function resetProgress() {
  if (!confirm('Сбросить весь прогресс по квестам (выполненные, проваленные, мои квесты, прогресс целей)?\n\nПлан рейда и список находок останутся.')) return;
  state.completed.clear(); state.failed.clear(); state.active.clear(); state.progress = {};
  recomputeFailed(); persistProgress(); persistObjProgress();
  renderStats(); renderActiveViews();
  toast('Прогресс по квестам сброшен.');
}
function setProgress(objId, val) {
  val = Math.max(0, val || 0);
  if (val <= 0) delete state.progress[objId]; else state.progress[objId] = val;
  persistObjProgress();
  if (ui.view === 'planner') renderPlanner();
  else if (ui.view === 'kappa') renderKappa();
  else renderActiveViews();
}
// общие обработчики прогресса (степпер / чекбокс) для всех вкладок
function progressClick(e) {
  const stb = e.target.closest('.st-btn'); if (!stb) return false;
  const sp = stb.closest('.stepper'); const id = sp.dataset.obj; const total = +sp.dataset.total;
  setProgress(id, Math.max(0, Math.min(total, objDone(id) + (+stb.dataset.step)))); return true;
}
function progressChange(e) {
  const oc = e.target.closest('[data-objchk]'); if (!oc) return false;
  setProgress(oc.dataset.objchk, oc.checked ? (+oc.dataset.total || 1) : 0); return true;
}
function trackControlHtml(o) {
  if (!trackable(o)) return '';
  const total = objTotal(o), done = objDone(o.id);
  if (total === 1) {
    return `<label class="track-chk"><input type="checkbox" data-objchk="${o.id}" data-total="1" ${done >= 1 ? 'checked' : ''}> <span>${done >= 1 ? 'сделано' : 'отметить'}</span></label>`;
  }
  return `<span class="stepper" data-obj="${o.id}" data-total="${total}">
    <button class="st-btn" data-step="-1" title="убавить">−</button>
    <b class="st-val ${done >= total ? 'done' : ''}">${done}</b><span class="st-tot">/ ${total}</span>
    <button class="st-btn" data-step="1" title="прибавить">+</button>
    ${done > 0 && done < total ? `<span class="st-rem">осталось ${total - done}</span>` : ''}
  </span>`;
}
function togglePlan(id) {
  if (state.plan.has(id)) state.plan.delete(id); else state.plan.add(id);
  persistPlan();
  renderStats();
  if (ui.view === 'planner') renderPlanner();
  document.querySelectorAll(`.plan-cb[data-id="${id}"]`).forEach((cb) => { cb.checked = state.plan.has(id); });
}
function renderActiveViews() { if (ui.view === 'mine') renderQuests('mine'); else if (ui.view === 'all') renderQuests('all'); else if (ui.view === 'planner') renderPlanner(); }
function toggleAllPlan(scope, checked) {
  const list = filteredTasks(scope);
  if (checked) {
    const toAdd = list.filter((t) => !state.plan.has(t.id));
    if (toAdd.length > 5 && !confirm(`В План рейда будут добавлены все ${toAdd.length} показанных квестов. Продолжить?`)) { renderQuests(scope); return; }
    list.forEach((t) => state.plan.add(t.id));
  } else {
    list.forEach((t) => state.plan.delete(t.id));
  }
  persistPlan(); renderStats(); renderQuests(scope);
}

// ---------- Filtering & sorting ----------------------------------------
function baseTasks(scope) { return scope === 'mine' ? data.tasks.filter((t) => state.active.has(t.id)) : data.tasks; }
function filteredTasks(scope) {
  const f = ui.filters, q = f.search.trim().toLowerCase();
  let list = baseTasks(scope).filter((t) => {
    if (f.faction && t.faction !== f.faction) return false;
    if (f.kappa && !t.kappa) return false;
    if (f.plan && !state.plan.has(t.id)) return false;
    if (scope === 'all' && !f.showmine && state.active.has(t.id)) return false; // в "Все квесты" по умолчанию прячем уже взятые
    if (f.trader && t.trader !== f.trader) return false;
    if (f.map === '__none__') { if (t.maps.length || t.objectives.some((o) => o.maps.length)) return false; }
    else if (f.map && !t.maps.includes(f.map) && !t.objectives.some((o) => o.maps.includes(f.map))) return false;
    if (f.action && !t.objectives.some((o) => o.action === f.action)) return false;
    const st = statusOf(t);
    if (f.status && st !== f.status) return false;
    // По умолчанию выполненные скрыты; показываем только если включён фильтр или явно выбран статус "Выполненные".
    if (!f.showdone && f.status !== 'completed' && st === 'completed') return false;
    if (q && !t._search.includes(q)) return false;
    return true;
  });
  const { col, dir } = ui.sort;
  const key = (t) => col === 'name' ? t.name.toLowerCase()
    : col === 'loc' ? (t.maps.map(mapName).sort()[0] || 'яяя')
    : col === 'trader' ? traderName(t.trader)
    : /* status */ STATUS_RANK[statusOf(t)];
  list.sort((a, b) => { const ka = key(a), kb = key(b); if (ka < kb) return -dir; if (ka > kb) return dir; return a.name.localeCompare(b.name, 'ru'); });
  return list;
}

// ---------- Filter option lists ----------------------------------------
function fillFilterOptions() {
  const mapSel = document.getElementById('f-map');
  data.maps.forEach((m) => mapSel.insertAdjacentHTML('beforeend', `<option value="${m.id}">${esc(m.name)}</option>`));
  mapSel.insertAdjacentHTML('beforeend', `<option value="__none__">Без локации</option>`);
  const trSel = document.getElementById('f-trader');
  data.traders.forEach((t) => trSel.insertAdjacentHTML('beforeend', `<option value="${t.id}">${esc(t.name)}</option>`));
  const actions = [...new Set(data.tasks.flatMap((t) => t.objectives.map((o) => o.action)))].sort((a, b) => a.localeCompare(b, 'ru'));
  const acSel = document.getElementById('f-action');
  actions.forEach((a) => acSel.insertAdjacentHTML('beforeend', `<option value="${esc(a)}">${esc(a)}</option>`));
}

// ---------- Stats -------------------------------------------------------
function renderStats() {
  let done = 0, avail = 0, fail = 0;
  for (const t of data.tasks) { const s = statusOf(t); if (s === 'completed') done++; else if (s === 'available') avail++; else if (s === 'failed') fail++; }
  document.getElementById('stats').innerHTML =
    `<span>Мои квесты: <b>${state.active.size}</b></span>` +
    `<span class="dot">•</span><span>Доступно: <b>${avail}</b></span>` +
    `<span class="dot">•</span><span>Выполнено: <b>${done}</b> / ${data.tasks.length}</span>` +
    `<span class="dot">•</span><span>Провалено: <b>${fail}</b></span>` +
    `<span class="dot">•</span><span>В плане рейда: <b>${state.plan.size}</b></span>`;
}

// ---------- Quest table -------------------------------------------------
function bringMini(t) {
  const m = new Map();
  for (const o of t.objectives) for (const b of o.bring) {
    const id = b.item || (b.anyOf && b.anyOf[0]); if (!id) continue;
    const e = m.get(id) || { id, count: 0 }; e.count += (b.count || 1); m.set(id, e);
  }
  const html = [...m.values()].slice(0, 5).map((e) => `<span class="it" title="${esc(itemName(e.id))} — взять с собой">${itImg(e.id)}<span class="cnt">${e.count}</span></span>`).join('');
  return html || '<span class="muted">—</span>';
}
function handInMini(t) {
  const m = new Map(); let cats = 0, builds = 0, anyN = 0;
  for (const o of t.objectives) for (const h of o.handIn) {
    if (h.kind === 'category') { cats++; continue; }
    if (h.kind === 'build') { builds++; continue; }
    if (h.anyOf) { anyN++; continue; }
    if (h.item) { const c = h.count || 1; const cur = m.get(h.item); if (!cur || c > cur.count) m.set(h.item, { id: h.item, count: c, fir: h.fir }); }
  }
  let html = [...m.values()].slice(0, 4).map((e) => `<span class="it hand" title="${esc(itemName(e.id))} — ${e.fir ? 'найти в рейде и сдать' : 'купить/найти и сдать'}">${itImg(e.id)}<span class="cnt">${e.count}</span></span>`).join('');
  if (cats) html += `<span class="more" title="любой предмет категории">📋${cats > 1 ? '×' + cats : ''}</span>`;
  if (builds) html += `<span class="more" title="собрать оружие и сдать">🔧${builds > 1 ? '×' + builds : ''}</span>`;
  if (anyN) html += `<span class="more" title="один из нескольких">…</span>`;
  return html || '<span class="muted">—</span>';
}
function questRowHtml(t, scope) {
  const st = statusOf(t);
  const inPlan = state.plan.has(t.id), inActive = state.active.has(t.id);
  const locChips = t.maps.map((mid) => `<span class="chip loc" style="border-left-color:${mapColor(mid)}">${esc(mapName(mid))}</span>`).join('') || '<span class="muted">—</span>';
  const sub = [esc(traderName(t.trader))];
  if (t.minLevel) sub.push('ур. ' + t.minLevel);
  if (t.faction) sub.push(t.faction);
  if (t.kappa) sub.push('<span class="star" title="Требуется для Каппы">★ Каппа</span>');
  const cls = `qrow${st === 'completed' ? ' done' : ''}${st === 'failed' ? ' failed' : ''}${inActive ? ' in-active' : ''}`;
  return `<div class="${cls}" data-id="${t.id}">
    <input type="checkbox" class="plan-cb" data-id="${t.id}" ${inPlan ? 'checked' : ''} title="Добавить в план рейда">
    <div><span class="badge b-${st}">${STATUS_RU[st]}</span></div>
    <div class="qname">${esc(t.name)}${inActive ? ' <span class="mine-tag" title="В моих квестах">★</span>' : ''}<span class="sub">${sub.join(' · ')}</span></div>
    <div class="chips">${locChips}</div>
    <div class="bring-mini">${bringMini(t)}</div>
    <div class="bring-mini">${handInMini(t)}</div>
    <div class="qctrl">
      <button class="ico done ${st === 'completed' ? 'on-done' : ''}" data-act="done" data-id="${t.id}" title="Выполнен">✓</button>
      <button class="ico fail ${st === 'failed' ? 'on-fail' : ''}" data-act="fail" data-id="${t.id}" title="Провален">✗</button>
      <button class="ico reset" data-act="reset" data-id="${t.id}" title="Сбросить статус">↺</button>
    </div>
  </div>`;
}
function sortArrow(col) { return ui.sort.col === col ? `<span class="arr">${ui.sort.dir > 0 ? '▲' : '▼'}</span>` : ''; }
function headerHtml(list) {
  const allChecked = list.length > 0 && list.every((t) => state.plan.has(t.id));
  return `<div class="qrow head">
    <div><input type="checkbox" class="plan-all-cb" ${allChecked ? 'checked' : ''} title="Добавить все показанные квесты в План рейда"></div>
    <div class="sortable" data-sort="status">Статус ${sortArrow('status')}</div>
    <div class="sortable" data-sort="name">Квест ${sortArrow('name')}</div>
    <div class="sortable" data-sort="loc">Локации ${sortArrow('loc')}</div>
    <div>Взять с собой</div>
    <div>Сдать</div>
    <div></div>
  </div>`;
}

function anyChip(e, title) { return `<span class="it bring" title="${esc(title)}">${itImg(e.anyOf[0])}${esc(itemShort(e.anyOf[0]))} +${e.anyOf.length - 1}${e.count > 1 ? ` <span class="cnt">×${e.count}</span>` : ''}</span>`; }
function objHtml(o, wiki) {
  const its = [];
  for (const b of o.bring) {
    if (b.anyOf) { its.push(anyChip(b, 'взять с собой — одно из')); continue; }
    const t = b.kind === 'marker' ? 'маркер' : b.kind === 'camera' ? 'камера' : b.kind === 'weapon' ? 'оружие' : b.kind === 'use' ? 'использовать' : 'заложить';
    its.push(`<span class="it bring" title="ВЗЯТЬ С СОБОЙ — ${t}">${itImg(b.item)}${esc(itemShort(b.item))}<span class="cnt">×${b.count || 1}</span></span>`);
  }
  for (const h of o.handIn) {
    if (h.kind === 'category') { its.push(`<span class="it cat" title="${esc(h.category)}">📋 ${esc(shorten(h.category, 48))}<span class="cnt">×${h.count || 1}</span><span class="firlbl">${h.fir ? 'найти в рейде' : 'купить/найти'}</span></span>`); continue; }
    if (h.anyOf) { its.push(anyChip(h, 'найти/сдать — одно из')); continue; }
    if (h.kind === 'build') { its.push(`<span class="it build" title="Собрать и сдать">🔧 ${esc(itemShort(h.item))}<span class="cnt">×${h.count || 1}</span></span>`); continue; }
    its.push(`<span class="it handin" title="${esc(itemName(h.item))} — ${h.fir ? 'найти в рейде и сдать' : 'купить/найти и сдать'}">${itImg(h.item)}${esc(itemShort(h.item))}<span class="cnt">×${h.count || 1}</span><span class="firlbl">${h.fir ? 'FiR' : 'куп.'}</span></span>`);
  }
  for (const k of o.keys) {
    if (typeof k === 'object') { its.push(`<span class="it key" title="ключ (один из ${k.anyOf.length})">🔑 ${esc(itemShort(k.anyOf[0]))}…</span>`); continue; }
    its.push(`<span class="it key" title="${esc(itemName(k))} — ключ">${itImg(k)}🔑 ${esc(itemShort(k))}</span>`);
  }
  const loc = o.maps.length ? o.maps.map(mapName).join(', ') : '';
  const isDone = trackable(o) && objRemaining(o) === 0 && objDone(o.id) > 0;
  const track = trackControlHtml(o);
  return `<div class="obj${o.optional ? ' opt' : ''}${isDone ? ' obj-done' : ''}">
    <div class="act">${esc(o.action)}${loc ? `<span class="loc-tag">${esc(loc)}</span>` : ''}</div>
    <div class="desc">${esc(o.description)}${o.optional ? ' <span class="opt-tag">(необязательно)</span>' : ''}${o.target ? ` <span class="opt-tag">→ ${esc(o.target)}</span>` : ''}${wiki ? ` <a class="obj-guide" href="${esc(wiki)}" target="_blank" rel="noopener" title="Гайд по квесту: где искать / закладывать">где? ↗</a>` : ''}</div>
    <div class="obj-items">${its.join('')}</div>
    ${track ? `<div class="obj-track">${track}</div>` : ''}
  </div>`;
}
function qLink(id) { const t = taskById.get(id); if (!t) return esc(id); return `<span class="q-link cstate-${statusOf(t)}" data-goto="${id}">${esc(t.name)}</span>`; }
function depsHtml(t) {
  const lines = [];
  if (t.requires && t.requires.length) {
    const parts = t.requires.map((r) => { const s = (r.status || ['complete']).map((x) => ({ complete: '✔', active: '▶', failed: '✖' }[x] || x)).join(''); return `${qLink(r.task)} <span class="muted">[${s}]</span>`; });
    lines.push(`<div class="line"><b>Требует:</b> ${parts.join(', ')}</div>`);
  }
  const u = unlocksMap.get(t.id) || [];
  if (u.length) lines.push(`<div class="line"><b>Открывает:</b> ${u.map(qLink).join(', ')}</div>`);
  if (t.failedBy && t.failedBy.length) lines.push(`<div class="line warn"><b>⚠ Провалится</b> при выполнении: ${t.failedBy.map(qLink).join(', ')}</div>`);
  const fc = failsOnComplete.get(t.id) || [];
  if (fc.length) lines.push(`<div class="line warn"><b>⚠ Выполнение провалит:</b> ${fc.map(qLink).join(', ')}</div>`);
  if (t.wiki) lines.push(`<div class="line"><a href="${esc(t.wiki)}" target="_blank" rel="noopener">Открыть на Wiki ↗</a></div>`);
  return `<div class="deps">${lines.join('')}</div>`;
}
function questDetailHtml(t) {
  const inActive = state.active.has(t.id);
  const addBtn = `<button class="btn-add-mine ${inActive ? 'remove' : ''}" data-act="active" data-id="${t.id}">${inActive ? '− Убрать из моих квестов' : '+ Добавить в мои квесты'}</button>`;
  return `<div class="qdetail" data-detail="${t.id}"><div class="qd-add">${addBtn}</div>${t.objectives.map((o) => objHtml(o, t.wiki)).join('')}${depsHtml(t)}</div>`;
}

function onbResultsHtml() {
  const q = ui.onbQuery.trim().toLowerCase();
  if (q.length < 2) return '';
  const res = data.tasks.filter((t) => t.name.toLowerCase().includes(q)).slice(0, 12);
  if (!res.length) return '<div class="onb-r empty-note">Ничего не найдено</div>';
  return res.map((t) => `<div class="onb-r"><div><b>${esc(t.name)}</b> <span class="muted">${esc(traderName(t.trader))}${t.minLevel ? ' · ур. ' + t.minLevel : ''}</span></div><button class="btn-ghost" data-current="${t.id}">Это мой текущий →</button></div>`).join('');
}
function onboardingHtml() {
  return `<div class="onboarding">
    <div class="onb-row">
      <div class="onb-text"><b>Быстрая настройка прогресса.</b> Если вы уже в середине игры — найдите квест, который у вас сейчас активен. Все предыдущие по ветке отметятся «Выполнен» автоматически.</div>
      <button class="btn-ghost danger" id="reset-progress">Сбросить весь прогресс</button>
    </div>
    <div class="onb-search">
      <input type="text" id="onb-input" placeholder="Найти текущий квест (напр. «Оружейник. Часть 6»)…" value="${esc(ui.onbQuery)}" autocomplete="off" />
      <div class="onb-results" id="onb-results">${onbResultsHtml()}</div>
    </div>
  </div>`;
}
function renderQuests(scope) {
  const list = filteredTasks(scope);
  const cont = document.getElementById(scope === 'mine' ? 'view-mine' : 'view-all');
  let html = scope === 'mine' ? onboardingHtml() : '';
  html += `<div class="qtable">${headerHtml(list)}`;
  if (!list.length) {
    html += scope === 'mine'
      ? `<div class="loading">Список «Мои квесты» пуст.<br><br>Перейдите во вкладку <b>«Все квесты»</b> и добавьте нужные кнопкой <b>+</b>.<br>При выполнении квеста следующие по цепочке добавятся сюда автоматически.</div>`
      : `<div class="loading">Ничего не найдено. Измените фильтры.</div>`;
  } else {
    for (const t of list) { html += questRowHtml(t, scope); if (ui.expanded.has(t.id)) html += questDetailHtml(t); }
  }
  html += '</div>';
  cont.innerHTML = html;
}

// ---------- Planner -----------------------------------------------------
function aggregate(taskIds) {
  const locs = new Map();
  const handInItems = new Map(), handInCats = new Map(), handInChoices = [], builds = new Map();
  const locOf = (l) => { if (!locs.has(l)) locs.set(l, { bring: new Map(), choices: [], quests: new Map() }); return locs.get(l); };
  const addBring = (map, id, count, kind) => { const e = map.get(id) || { id, count: 0, kind }; e.count = kind === 'key' ? 1 : e.count + count; if (kind === 'key' || kind === 'weapon') e.kind = kind; map.set(id, e); };

  for (const tid of taskIds) {
    const t = taskById.get(tid); if (!t) continue;
    const qHand = new Map(); // per-quest dedupe of handIn items (merge find+give -> max)
    for (const o of t.objectives) {
      const total = objTotal(o), rem = objRemaining(o);
      const objDoneFully = trackable(o) && rem === 0; // полностью выполнена
      const eff = (cnt) => (cnt === total ? rem : cnt); // уменьшаем только то, что масштабируется с прогрессом
      const loc = (o.maps && o.maps[0]) || 'none';
      const b = locOf(loc);
      // выполненную цель ОСТАВЛЯЕМ в списке задач (зачёркнутой), но не берём/сдаём её
      if (o.bring.length || o.keys.length || loc !== 'none' || o.handIn.length) { if (!b.quests.has(tid)) b.quests.set(tid, []); b.quests.get(tid).push(o); }
      if (objDoneFully) continue;
      o.bring.forEach((br, idx) => {
        if (br.anyOf) { const key = `${o.id}|b${idx}`; b.choices.push({ key, kind: br.kind, options: br.anyOf, chosen: state.planChoices[key] || br.anyOf[0], count: eff(br.count || 1) }); }
        else addBring(b.bring, br.item, eff(br.count || 1), br.kind || 'plant');
      });
      (o.keys || []).forEach((k, idx) => {
        if (typeof k === 'object' && k.anyOf) { const key = `${o.id}|k${idx}`; b.choices.push({ key, kind: 'key', options: k.anyOf, chosen: state.planChoices[key] || k.anyOf[0], count: 1 }); }
        else addBring(b.bring, k, 1, 'key');
      });
      o.handIn.forEach((h, idx) => {
        if (h.kind === 'build') { const e = builds.get(h.item) || { id: h.item, count: 0 }; e.count += eff(h.count || 1); builds.set(h.item, e); return; }
        if (h.kind === 'category') { const e = handInCats.get(h.category) || { label: h.category, count: 0, fir: h.fir }; e.count += eff(h.count || 1); e.fir = e.fir || h.fir; handInCats.set(h.category, e); return; }
        if (h.anyOf) { const key = `${o.id}|h${idx}`; handInChoices.push({ key, options: h.anyOf, chosen: state.planChoices[key] || h.anyOf[0], count: eff(h.count || 1), fir: h.fir }); return; }
        if (h.item) { const c = eff(h.count || 1); const cur = qHand.get(h.item); if (!cur || c > cur.count) qHand.set(h.item, { count: c, fir: h.fir || (cur && cur.fir) }); }
      });
    }
    for (const [id, info] of qHand) { const e = handInItems.get(id) || { id, count: 0, fir: info.fir }; e.count += info.count; e.fir = e.fir || info.fir; handInItems.set(id, e); }
  }
  return { locs, handInItems, handInCats, handInChoices, builds };
}
function takeHtml(e) {
  const cntTxt = e.kind === 'key' ? '' : `<span class="cnt">×${e.count}</span>`;
  const extra = e.kind === 'key' ? '🔑 ' : e.kind === 'weapon' ? '🔫 ' : '';
  return `<span class="take ${e.kind === 'key' ? 'key' : ''} ${e.kind === 'weapon' ? 'weapon' : ''}" title="${esc(itemName(e.id))}">${itImg(e.id)}<span>${extra}${esc(itemShort(e.id))}</span>${cntTxt}</span>`;
}
function handInItemHtml(e) {
  return `<span class="take handin" title="${esc(itemName(e.id))} — ${e.fir ? 'найти в рейде и сдать' : 'купить/найти и сдать'}">${itImg(e.id)}<span>${esc(itemShort(e.id))}</span><span class="cnt">×${e.count}</span></span>`;
}
function choiceHtml(c, sectionFir) {
  const opts = c.options.map((id) => `<option value="${id}" ${id === c.chosen ? 'selected' : ''}>${esc(itemShort(id))}</option>`).join('');
  const label = c.kind === 'key' ? '🔑 ключ (одно из)' : c.kind === 'weapon' ? '🔫 оружие (одно из)' : 'одно из';
  return `<span class="take ${c.kind === 'key' ? 'key' : ''} ${c.kind === 'weapon' ? 'weapon' : ''} ${sectionFir !== undefined ? 'handin' : ''}">
    <span class="muted" style="font-size:11px">${label}:</span>
    <select data-choice="${c.key}">${opts}</select><span class="cnt">×${c.count}</span>${sectionFir !== undefined ? `<span class="firlbl">${c.fir ? 'FiR' : 'куп.'}</span>` : ''}</span>`;
}

// Один блок: все предметы из всех групп находок, у каждого — пометка, для какой группы.
function findingsBlockHtml() {
  const rows = [];
  for (const g of state.findGroups) {
    for (const it of g.items) {
      const ci = catItem(it.id); const ic = ci.icon || ci.img;
      const img = ic ? `<img src="${ic}" data-item="${it.id}" data-itemimg="${ci.img || ci.icon || ''}" onerror="this.style.display='none'">` : '';
      rows.push(`<li class="${it.found ? 'found' : ''}">${img}<span class="nm">${esc(ci.name)}</span><span class="cnt">×${it.qty || 1}</span><span class="fg-tag" title="Для группы «${esc(g.name)}»">${esc(g.name)}</span></li>`);
    }
  }
  if (!rows.length) return '';
  return `<div class="summary-card findings-card">
    <h3>Список находок</h3>
    <div class="empty-note" style="margin:-4px 0 8px">найти в любых рейдах — из вкладки «Список находок»</div>
    <ul class="fg-items">${rows.join('')}</ul>
  </div>`;
}

// случайный, но стабильный и контрастный цвет для квеста
function questColor(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 68% 62%)`; }
// русское имя локации -> slug интерактивной карты tarkov.dev
const MAP_SLUG = { 'Завод': 'factory', 'Таможня': 'customs', 'Лес': 'woods', 'Маяк': 'lighthouse', 'Берег': 'shoreline', 'Резерв': 'reserve', 'Развязка': 'interchange', 'Улицы Таркова': 'streets-of-tarkov', 'Лаборатория': 'the-lab', 'Эпицентр': 'ground-zero', 'Лабиринт': 'the-labyrinth', 'Ледокол': 'icebreaker' };
const mapSlug = (id) => MAP_SLUG[mapName(id)] || null;

// гео-конфиг карт (SVG + трансформация координат), грузится лениво
let mapsGeo = null;
async function loadMapsGeo() {
  if (mapsGeo) return mapsGeo;
  try { const r = await fetch('data/maps-geo.json', { cache: 'no-cache' }); if (r.ok) { mapsGeo = await r.json(); return mapsGeo; } } catch {}
  if (window.__MAPSGEO__) { mapsGeo = window.__MAPSGEO__; return mapsGeo; }
  try { await injectScript('data/maps-geo.js'); mapsGeo = window.__MAPSGEO__ || {}; } catch { mapsGeo = {}; }
  return mapsGeo;
}
const geoFor = (mapId) => (mapsGeo && mapsGeo[mapSlug(mapId)]) || null;
// карты, у которых есть гео, но нет квестов (их нет в data.maps) — добавляем как просматриваемые
const GEO_ONLY_NAME = { terminal: 'Терминал' };
function addGeoOnlyMaps() {
  if (!mapsGeo) return;
  const covered = new Set(data.maps.map((m) => mapSlug(m.id)).filter(Boolean));
  for (const slug of Object.keys(mapsGeo)) {
    if (covered.has(slug) || !GEO_ONLY_NAME[slug]) continue;
    const name = GEO_ONLY_NAME[slug], id = 'map_geo_' + slug, m = { id, name };
    data.maps.push(m); mapById.set(id, m); MAP_SLUG[name] = slug;
  }
}
// inline-SVG карты (чтобы при зуме оставалась векторно-чёткой)
const svgCache = {};
async function loadSvg(url) {
  if (url in svgCache) return svgCache[url];
  try { const r = await fetch(url, { cache: 'force-cache' }); svgCache[url] = r.ok ? await r.text() : ''; } catch { svgCache[url] = ''; }
  return svgCache[url];
}
// игровые координаты {x,z} -> доля {left,top} на SVG-карте (формула из getCRS tarkov.dev)
function geoFrac(x, z, g) {
  const rot = (px, pz) => { const a = (g.rotation || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [px * c - pz * s, px * s + pz * c]; };
  const lp = (px, pz) => { const [rx, ry] = rot(px, pz); return [g.sx * rx, g.sy * ry]; };
  const [mx, my] = lp(x, z);
  const [a0x, a0y] = lp(g.bounds[0][0], g.bounds[0][1]);
  const [a1x, a1y] = lp(g.bounds[1][0], g.bounds[1][1]);
  const minx = Math.min(a0x, a1x), maxx = Math.max(a0x, a1x), miny = Math.min(a0y, a1y), maxy = Math.max(a0y, a1y);
  return { left: (mx - minx) / (maxx - minx) * 100, top: (my - miny) / (maxy - miny) * 100 };
}
// строка задачи (li) с зачёркиванием выполненной, гайдом и контролом прогресса
function objLiHtml(o, wiki) {
  const isDone = trackable(o) && objRemaining(o) === 0 && objDone(o.id) > 0;
  const guide = wiki ? ` <a class="obj-guide" href="${esc(wiki)}" target="_blank" rel="noopener" title="Открыть гайд по квесту (где искать/закладывать)">где? ↗</a>` : '';
  return `<li class="${isDone ? 'li-done' : ''}" data-li-obj="${o.id}"><span class="a">${esc(o.action)}:</span> ${esc(o.description)}${guide} <span class="li-track">${trackControlHtml(o)}</span></li>`;
}
// локации с активными квестами
function activeLocations() {
  const s = new Set();
  for (const tid of state.active) { const t = taskById.get(tid); if (!t) continue; for (const o of t.objectives) for (const m of o.maps) s.add(m); }
  return s;
}
// локации для под-вкладок: все карты с гео + те, где есть активные квесты (карта показывается всегда)
function plannerLocations() {
  const act = activeLocations();
  const s = new Set(act);
  for (const m of data.maps) if (geoFor(m.id)) s.add(m.id);
  return [...s].sort((a, b) => mapName(a).localeCompare(mapName(b), 'ru'));
}
function plannerSubnav() {
  const act = activeLocations();
  const btn = (tab, label, color, dot) => `<button class="psub ${ui.plannerTab === tab ? 'active' : ''}" data-ptab="${tab}" ${color ? `style="--c:${color}"` : ''}>${esc(label)}${dot ? ' <span class="psub-dot"></span>' : ''}</button>`;
  return `<div class="planner-subnav">${btn('plan', 'Мой план')}${plannerLocations().map((m) => btn(m, mapName(m), mapColor(m), act.has(m))).join('')}</div>`;
}

function renderPlanner() {
  const root = document.getElementById('view-planner');
  // под-вкладка по локации
  if (ui.plannerTab && ui.plannerTab !== 'plan') {
    if (!plannerLocations().includes(ui.plannerTab)) ui.plannerTab = 'plan';
    else {
      if (!mapsGeo) { loadMapsGeo().then(() => { if (ui.view === 'planner') renderPlanner(); }); }
      root.innerHTML = plannerSubnav() + plannerLocationHtml(ui.plannerTab);
      initMap();
      return;
    }
  }
  const findings = findingsBlockHtml();
  const refreshCat = () => { if (state.findGroups.length && !catalog) loadCatalog().then(() => { if (ui.view === 'planner') renderPlanner(); }); };
  // выбор карты + "Показать карту" (открывает локацию на весь экран)
  const plocs = plannerLocations();
  const actCount = {};
  for (const tid of state.active) { const t = taskById.get(tid); if (!t) continue; const s = new Set(); for (const o of t.objectives) for (const m of o.maps) s.add(m); for (const m of s) actCount[m] = (actCount[m] || 0) + 1; }
  const mapPicker = plocs.length ? `<select id="map-pick" class="map-pick">${plocs.map((m) => `<option value="${m}">${esc(mapName(m))}${actCount[m] ? ` (${actCount[m]} кв.)` : ''}</option>`).join('')}</select><button class="btn-ghost" id="map-show">Показать карту</button>` : '';
  if (!state.plan.size) {
    root.innerHTML = plannerSubnav() + `<div class="page-head"><h2>Мой план</h2><span class="ph-sub">отметьте квесты галочкой ⚑</span><div class="ph-actions">${mapPicker}</div></div>
      <div class="plan-cols"><div><div class="planner-empty">План пуст.<br><br>Отметьте квесты галочкой <b>⚑</b> во вкладках «Мои квесты» / «Все квесты» — или используйте вкладки локаций выше / выбор карты, куда автоматически попадают все ваши квесты.</div></div><div class="plan-right">${findings}</div></div>`;
    refreshCat(); return;
  }
  const agg = aggregate(state.plan);
  const order = [...agg.locs.keys()].filter((k) => k !== 'none').sort((a, b) => mapName(a).localeCompare(mapName(b), 'ru'));
  if (agg.locs.has('none')) order.push('none');

  const bringTotals = new Map();
  for (const [, b] of agg.locs) {
    for (const e of b.bring.values()) { const x = bringTotals.get(e.id) || { id: e.id, count: 0, kind: e.kind }; x.count = e.kind === 'key' ? 1 : x.count + e.count; if (e.kind === 'key' || e.kind === 'weapon') x.kind = e.kind; bringTotals.set(e.id, x); }
    for (const c of b.choices) { const x = bringTotals.get(c.chosen) || { id: c.chosen, count: 0, kind: c.kind }; x.count = c.kind === 'key' ? 1 : x.count + c.count; if (c.kind === 'key' || c.kind === 'weapon') x.kind = c.kind; bringTotals.set(c.chosen, x); }
  }

  let cards = '';
  for (const loc of order) {
    const b = agg.locs.get(loc);
    const color = loc === 'none' ? '#666' : mapColor(loc);
    const title = loc === 'none' ? 'Без привязки к локации' : mapName(loc);
    const takes = [...b.bring.values()].map(takeHtml).join('') + b.choices.map((c) => choiceHtml(c)).join('');
    const groups = [...b.quests.entries()].map(([tid, objs]) => {
      const t = taskById.get(tid);
      const lis = objs.map((o) => objLiHtml(o, t.wiki)).join('');
      return `<div class="qg"><div class="qt">${esc(t.name)}</div><ul class="ol">${lis}</ul></div>`;
    }).join('');
    cards += `<div class="loc-card">
      <h3 style="border-left-color:${color}">${esc(title)} <span class="n">${b.quests.size} квест(ов)</span></h3>
      <div class="loc-body">
        <div class="sec-label">Взять с собой / заложить</div>
        ${takes ? `<div class="take-list">${takes}</div>` : '<div class="empty-note">Ничего закладывать не нужно.</div>'}
        <div class="obj-by-quest"><div class="sec-label">Задачи на локации</div>${groups}</div>
      </div>
    </div>`;
  }

  const bringList = [...bringTotals.values()].sort((a, b) => b.count - a.count).map(takeHtml).join('') || '<span class="empty-note">—</span>';

  // разделяем "сдать": что можно купить/найти на барахолке vs только из рейда (FiR)
  const buyParts = [], firParts = [];
  for (const e of [...agg.handInItems.values()].sort((a, b) => b.count - a.count)) (e.fir ? firParts : buyParts).push(handInItemHtml(e));
  for (const c of agg.handInChoices) (c.fir ? firParts : buyParts).push(choiceHtml(c, c.fir));
  for (const e of agg.handInCats.values()) (e.fir ? firParts : buyParts).push(`<span class="take cat" title="${esc(e.label)}">📋 <span>${esc(e.label)}</span><span class="cnt">×${e.count}</span></span>`);
  for (const e of agg.builds.values()) buyParts.push(`<span class="take build" title="Собрать и сдать">🔧 <span>${esc(itemShort(e.id))}</span><span class="cnt">×${e.count}</span></span>`);
  const handSection = (buyParts.length || firParts.length)
    ? `${buyParts.length ? `<div class="sub-h find">Купить / найти и сдать</div><div class="take-list">${buyParts.join('')}</div>` : ''}${firParts.length ? `<div class="sub-h find">Только из рейда (FiR) и сдать</div><div class="take-list">${firParts.join('')}</div>` : ''}`
    : `<div class="sub-h find">Найти / купить и сдать</div><div class="take-list"><span class="empty-note">—</span></div>`;

  const planList = [...state.plan].map((tid) => { const t = taskById.get(tid); if (!t) return ''; const locs = t.maps.map(mapName).join(', ') || '—'; return `<li><span class="ql" data-goto="${tid}">${esc(t.name)}</span> <span class="loc">${esc(locs)}</span><span class="rm" data-rm="${tid}" title="Убрать из плана">✕</span></li>`; }).join('');

  root.innerHTML = plannerSubnav() + `
    <div class="page-head">
      <h2>Мой план</h2>
      <span class="ph-sub">${state.plan.size} квест(ов) · ${order.length} локаци(й)</span>
      <div class="ph-actions">${mapPicker}<button class="btn-ghost" id="plan-clear">Очистить план</button></div>
    </div>
    <div class="plan-cols">
      <div>${cards}</div>
      <div class="plan-right">
        <aside class="summary-card">
          <h3>Итого взять с собой / заложить</h3>
          <div class="take-list">${bringList}</div>
          ${handSection}
          <div class="sub-h">Квесты в плане</div>
          <ul class="plan-quest-list">${planList}</ul>
        </aside>
        ${findings}
      </div>
    </div>`;
  refreshCat();
}

const extractColor = (f) => f === 'pmc' ? '#5b8fc9' : f === 'scav' ? '#d08a3e' : '#6fae54';
const factionRu = (f) => f === 'pmc' ? 'ЧВК' : f === 'scav' ? 'Дикий' : 'Общий';
const FLOOR_RU = { Ground_Level: 'Земля', Ground_Floor: 'Земля', Underground_Level: 'Подвал', Basement: 'Подвал', First_Floor: '1 этаж', Second_Floor: '2 этаж', Third_Floor: '3 этаж', Fourth_Floor: '4 этаж', Fifth_Floor: '5 этаж', Bunkers: 'Бункеры' };

// под-вкладка локации: карта (всегда, если есть гео) + квесты/выходы/боссы
function plannerLocationHtml(mapId) {
  const agg = aggregate(state.active);
  const b = agg.locs.get(mapId);
  const geo = geoFor(mapId);
  const slug = mapSlug(mapId);
  const mapLink = slug ? `<a class="btn-ghost" href="https://tarkov.dev/map/${slug}" target="_blank" rel="noopener">tarkov.dev ↗</a>` : '';

  const pins = [], noCoord = [], questGroups = [];
  if (b) for (const [tid, objs] of b.quests) {
    const t = taskById.get(tid), col = questColor(tid);
    for (const o of objs) {
      if (trackable(o) && objRemaining(o) === 0 && objDone(o.id) > 0) continue;
      const cs = (o.coords || []).filter((c) => c.m === mapId);
      if (geo && cs.length) { for (const c of cs) { const f = geoFrac(c.x, c.z, geo); if (isFinite(f.left) && isFinite(f.top)) pins.push(`<div class="pin-dot" style="left:${f.left.toFixed(2)}%;top:${f.top.toFixed(2)}%;--c:${col}" data-pinobj="${o.id}" title="${esc(t.name)} — ${esc(o.action)}: ${esc(o.description)}"></div>`); } }
      else if (!geo) noCoord.push(`<div class="marker" style="--c:${col}"><span class="pin"></span><div class="m-body"><div class="m-q">${esc(t.name)}</div><div class="m-txt"><b>${esc(o.action)}:</b> ${esc(o.description)}</div></div><span class="m-track">${trackControlHtml(o)}</span></div>`);
    }
    questGroups.push(`<div class="qg"><div class="qt" style="color:${col}">${esc(t.name)}</div><ul class="ol">${objs.map((o) => objLiHtml(o, t.wiki)).join('')}</ul></div>`);
  }
  const exPins = geo ? (geo.extracts || []).map((e) => { const f = geoFrac(e.x, e.z, geo); return isFinite(f.left) ? `<div class="pin-ex" style="left:${f.left.toFixed(2)}%;top:${f.top.toFixed(2)}%;--c:${extractColor(e.faction)}" title="Выход (${factionRu(e.faction)}): ${esc(e.name)}"></div>` : ''; }).join('') : '';
  const bossPins = geo ? (geo.bossSpawns || []).map((s) => { const f = geoFrac(s.x, s.z, geo); return isFinite(f.left) ? `<div class="pin-boss" style="left:${f.left.toFixed(2)}%;top:${f.top.toFixed(2)}%" title="Спавн босса: ${esc((s.bosses || []).join(', '))}"></div>` : ''; }).join('') : '';
  const bossLegend = geo && geo.bosses && geo.bosses.length ? `<div class="boss-legend">☠ Боссы: ${geo.bosses.map((x) => `${esc(x.name)} <span class="muted">${x.chance}%</span>`).join(' · ')}</div>` : '';

  const cornerPanel = `<div class="map-quests"><div class="mq-head">Текущие задачи</div>${questGroups.join('') || '<div class="empty-note">Нет активных задач на этой локации.</div>'}</div>`;
  const lyr = (k, label) => `<label><input type="checkbox" data-layer="${k}" ${ui.mapLayers[k] ? 'checked' : ''}> ${label}</label>`;
  const mapPanel = geo ? `<div class="map-view ${ui.mapFullscreen ? 'fs' : ''}">
      <div class="map-zoom">
        <button data-mz="+" title="Приблизить">+</button>
        <button data-mz="-" title="Отдалить">−</button>
        <button data-mz="fit" title="Показать целиком">⤢</button>
        <button data-mz="fs" title="${ui.mapFullscreen ? 'Свернуть' : 'Во весь экран'}">${ui.mapFullscreen ? '✕' : '⛶'}</button>
      </div>
      <div class="map-layers">${lyr('quests', 'Квесты (' + pins.length + ')')}${lyr('extracts', 'Выходы')}${lyr('bosses', 'Боссы')}</div>
      ${geo.floors ? `<div class="map-floors">${geo.floors.map((fl) => `<button data-floor="${fl}" class="${(ui.mapFloor || geo.floors[0]) === fl ? 'active' : ''}">${esc(FLOOR_RU[fl] || fl)}</button>`).join('')}</div>` : ''}
      <div class="map-canvas" id="map-canvas"><div class="map-inner" id="map-inner">
        <div class="map-svg" id="map-svg"></div>
        <div class="layer-quests" ${ui.mapLayers.quests ? '' : 'hidden'}>${pins.join('')}</div>
        <div class="layer-extracts" ${ui.mapLayers.extracts ? '' : 'hidden'}>${exPins}</div>
        <div class="layer-bosses" ${ui.mapLayers.bosses ? '' : 'hidden'}>${bossPins}</div>
      </div></div>
      ${cornerPanel}
    </div>` : `<div class="empty-note" style="margin:8px 0">Векторная карта для этой локации недоступна. ${mapLink || ''}</div>`;

  const takes = b ? [...b.bring.values()].map(takeHtml).join('') + b.choices.map((c) => choiceHtml(c)).join('') : '';
  return `
    <div class="page-head"><h2 style="color:${geo ? mapColor(mapId) : 'var(--gold)'}">${esc(mapName(mapId))}</h2><span class="ph-sub">${b ? b.quests.size : 0} квест(ов) · ${pins.length} маркер(ов) задач</span><div class="ph-actions">${mapLink}</div></div>
    ${bossLegend}
    <div class="loc-layout">
      <div class="loc-board-wrap">
        ${mapPanel}
        ${noCoord.length ? `<div class="sec-label" style="margin-top:12px">Задачи без точки на карте</div><div class="marker-board">${noCoord.join('')}</div>` : ''}
      </div>
      <aside class="loc-side">
        <div class="loc-card"><div class="loc-body">
          <div class="sec-label">Взять с собой / заложить</div>
          ${takes ? `<div class="take-list">${takes}</div>` : '<div class="empty-note">Ничего закладывать не нужно.</div>'}
          <div class="obj-by-quest"><div class="sec-label">Задачи <span class="muted" style="font-weight:400">— отметьте выполнение, маркер скроется</span></div>${questGroups.join('') || '<div class="empty-note">Нет активных задач.</div>'}</div>
        </div></div>
      </aside>
    </div>`;
}

// инициализация интерактива карты (inline-SVG, зум по ширине = вектор чёткий)
function initMap() {
  const canvas = document.getElementById('map-canvas'), inner = document.getElementById('map-inner'), holder = document.getElementById('map-svg');
  if (!canvas || !inner || !holder) return;
  const geo = geoFor(ui.plannerTab);
  let aspect = 2;
  // z — масштаб относительно ширины канваса: ширина карты = clientWidth * z (вектор перерисовывается чётко)
  const apply = () => { const cw = canvas.clientWidth; inner.style.width = (cw * ui.map.z) + 'px'; inner.style.transform = `translate(${ui.map.x}px, ${ui.map.y}px)`; };
  const fit = () => { const cw = canvas.clientWidth, ch = canvas.clientHeight; const z = Math.min(1, ch * aspect / cw); ui.map = { z, x: (cw - cw * z) / 2, y: (ch - cw * z / aspect) / 2 }; apply(); };
  const clampZoom = (z) => Math.max(0.1, Math.min(8, z));
  const zoomAt = (cx, cy, nz) => { nz = clampZoom(nz); const z = ui.map.z; const wx = (cx - ui.map.x) / z, wy = (cy - ui.map.y) / z; ui.map.x = cx - wx * nz; ui.map.y = cy - wy * nz; ui.map.z = nz; apply(); };
  const applyFloor = () => {
    if (!geo || !geo.floors) return;
    const svg = holder.querySelector('svg'); if (!svg) return;
    const sel = ui.mapFloor || geo.floors[0], ground = geo.floors[0];
    for (const fl of geo.floors) { let g; try { g = svg.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(fl) : fl)); } catch { g = svg.getElementById && svg.getElementById(fl); } if (g) g.style.display = (fl === sel || fl === ground) ? '' : 'none'; }
  };
  const ready = () => {
    const svg = holder.querySelector('svg');
    if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); svg.style.width = '100%'; svg.style.height = 'auto'; svg.style.display = 'block'; const vb = (svg.getAttribute('viewBox') || '0 0 2 1').split(/[\s,]+/); aspect = (+vb[2]) / (+vb[3]) || 2; }
    applyFloor();
    if (ui.map.z === 0) fit(); else apply();
  };
  const mapView = canvas.closest('.map-view');
  mapView.querySelectorAll('.map-floors button').forEach((bt) => bt.addEventListener('click', (e) => {
    e.stopPropagation(); ui.mapFloor = bt.dataset.floor;
    mapView.querySelectorAll('.map-floors button').forEach((b) => b.classList.toggle('active', b === bt));
    applyFloor();
  }));
  // вставляем inline-SVG (из кэша синхронно, иначе грузим)
  const url = geo && geo.svg;
  if (url && url in svgCache) { holder.innerHTML = svgCache[url]; ready(); }
  else if (url) { holder.innerHTML = '<div class="map-loading">загрузка карты…</div>'; loadSvg(url).then((t) => { if (document.getElementById('map-svg') === holder) { holder.innerHTML = t || '<div class="map-loading">карта недоступна</div>'; ready(); } }); }

  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, ui.map.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)); }, { passive: false });
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { if (e.target.closest('.pin-dot')) return; drag = { x: e.clientX - ui.map.x, y: e.clientY - ui.map.y }; canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging'); });
  canvas.addEventListener('pointermove', (e) => { if (!drag) return; ui.map.x = e.clientX - drag.x; ui.map.y = e.clientY - drag.y; apply(); });
  const end = () => { drag = null; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.closest('.map-view').querySelectorAll('.map-zoom button').forEach((bt) => bt.addEventListener('click', (e) => {
    e.stopPropagation(); const m = bt.dataset.mz;
    if (m === 'fit') return fit();
    if (m === 'fs') { ui.mapFullscreen = !ui.mapFullscreen; ui.map.z = 0; renderPlanner(); syncHash(); return; }
    const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, ui.map.z * (m === '+' ? 1.4 : 1 / 1.4));
  }));
}

// ---------- Finder (Список находок) ------------------------------------
let catalog = null;
function injectScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
async function loadCatalog() {
  if (catalog) return catalog;
  try { const r = await fetch('data/items.json', { cache: 'force-cache' }); if (r.ok) { catalog = (await r.json()).items; return catalog; } } catch {}
  if (window.__ITEMS__) { catalog = window.__ITEMS__.items; return catalog; }
  try { await injectScript('data/items-data.js'); catalog = (window.__ITEMS__ || { items: [] }).items; } catch { catalog = []; }
  return catalog;
}
const catItem = (id) => (catalog || []).find((i) => i.id === id) || itemById.get(id) || { id, name: id, shortName: id };
function searchCatalog(q) {
  q = q.trim().toLowerCase(); if (q.length < 2 || !catalog) return [];
  const res = [];
  for (const i of catalog) { const n = (i.name + ' ' + i.shortName).toLowerCase(); if (n.includes(q)) { res.push(i); if (res.length >= 25) break; } }
  return res;
}
function groupItemsHtml(g) {
  if (!g.items.length) return '<li class="empty-note" style="border:none">Пока пусто. Добавьте предметы ниже.</li>';
  return g.items.map((it) => {
    const ci = catItem(it.id); const ic = ci.icon || ci.img;
    const img = ic ? `<img src="${ic}" data-item="${it.id}" data-itemimg="${ci.img || ci.icon || ''}" onerror="this.style.display='none'">` : '';
    return `<li class="${it.found ? 'found' : ''}">
      <input type="checkbox" data-found="${it.id}" data-group="${g.id}" ${it.found ? 'checked' : ''} title="Отметить найденным">
      ${img}<span class="nm">${esc(ci.name)}</span>${ci.cat ? `<span class="cat-mini">${esc(ci.cat)}</span>` : ''}
      <span class="qty-wrap" title="Сколько нужно найти">×<input type="number" min="1" class="qty-input" data-qty="${it.id}" data-group="${g.id}" value="${it.qty || 1}"></span>
      <span class="rm" data-rmitem="${it.id}" data-group="${g.id}" title="Убрать">✕</span>
    </li>`;
  }).join('');
}
function groupHtml(g) {
  const foundN = g.items.filter((i) => i.found).length;
  return `<div class="fgroup" data-group="${g.id}">
    <div class="fg-head">
      <span class="fg-del" data-delgroup="${g.id}" title="Удалить группу">🗑 удалить</span>
      <input class="fg-name" data-name="${g.id}" value="${esc(g.name)}" placeholder="Название группы" />
      <textarea class="fg-desc" data-desc="${g.id}" placeholder="Описание (зачем нужны эти предметы)">${esc(g.desc || '')}</textarea>
    </div>
    <div class="fg-body">
      <div class="fg-count">${g.items.length} предмет(ов)${foundN ? ` · найдено ${foundN}` : ''}</div>
      <ul class="fg-items">${groupItemsHtml(g)}</ul>
      <div class="fg-search">
        <input type="text" data-fsearch="${g.id}" placeholder="Добавить предмет: поиск по названию…" autocomplete="off" />
        <div class="fg-results" id="res-${g.id}"></div>
      </div>
    </div>
  </div>`;
}
function renderFinder() {
  const root = document.getElementById('view-finder');
  const groups = state.findGroups.map(groupHtml).join('');
  root.innerHTML = `
    <div class="page-head">
      <h2>Список находок</h2>
      <span class="ph-sub">что хочу найти в рейдах — по группам с описанием</span>
      <div class="ph-actions"><button class="btn-gold" id="add-group">+ Новая группа</button></div>
    </div>
    ${state.findGroups.length ? `<div class="finder-grid">${groups}</div>` : '<div class="planner-empty">Пока нет групп.<br><br>Создайте группу (например «На увеличение схрона») и добавьте предметы, которые хотите найти.</div>'}`;
  if (!catalog) loadCatalog().then(() => { if (ui.view === 'finder') renderFinder(); });
}
function findGroup(id) { return state.findGroups.find((g) => g.id === id); }

// ---------- Kappa (предметы для Каппы / квест «Коллекционер») -----------
function kappaItems() {
  return collectorTask.objectives.filter((o) => o.handIn.some((h) => h.item)).map((o) => {
    const h = o.handIn.find((x) => x.item);
    return { objId: o.id, item: h.item, total: objTotal(o), done: objDone(o.id) };
  });
}
function kappaGridHtml(items) {
  const q = ui.kappaSearch.trim().toLowerCase();
  const list = items.filter((i) => {
    if (ui.kappaHideFound && i.done >= i.total) return false;
    if (q && !(itemName(i.item) + ' ' + itemShort(i.item)).toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => itemName(a.item).localeCompare(itemName(b.item), 'ru'));
  if (!list.length) return '<div class="empty-note">Ничего не найдено.</div>';
  return list.map((i) => {
    const ic = itemIcon(i.item);
    const img = ic ? `<img src="${ic}" data-item="${i.item}" onerror="this.style.display='none'">` : '';
    return `<label class="kappa-item ${i.done >= i.total ? 'got' : ''}" title="${esc(itemName(i.item))}">
      <input type="checkbox" data-objchk="${i.objId}" data-total="${i.total}" ${i.done >= i.total ? 'checked' : ''}>
      ${img}<span class="kn">${esc(itemName(i.item))}</span>
    </label>`;
  }).join('');
}
function renderKappa() {
  const root = document.getElementById('view-kappa');
  if (!collectorTask) { root.innerHTML = `<div class="page-head"><h2>Предметы для Каппы</h2></div><div class="planner-empty">Квест «Коллекционер» не найден в данных.</div>`; return; }
  const items = kappaItems();
  const total = items.length, got = items.filter((i) => i.done >= i.total).length;
  const pct = total ? Math.round(got / total * 100) : 0;
  root.innerHTML = `
    <div class="page-head"><h2>Предметы для Каппы</h2><span class="ph-sub">квест «Коллекционер» — собрать и сдать ${total} предметов</span></div>
    <div class="kappa-progress"><div class="kappa-bar"><div class="kappa-fill" style="width:${pct}%"></div></div><b>${got} / ${total}</b> <span class="muted">(${pct}%)</span></div>
    <div class="kappa-controls">
      <input type="text" id="kappa-search" placeholder="Поиск предмета…" value="${esc(ui.kappaSearch)}" autocomplete="off" />
      <label class="chk"><input type="checkbox" id="kappa-hidefound" ${ui.kappaHideFound ? 'checked' : ''}> Скрыть собранные</label>
    </div>
    <div class="kappa-grid" id="kappa-grid">${kappaGridHtml(items)}</div>`;
}

// ---------- Lightbox ----------------------------------------------------
function openLightbox(src, name) {
  if (!src) return;
  const im = document.getElementById('lb-img'), nm = document.getElementById('lb-name');
  nm.textContent = name || '';
  im.style.display = '';
  im.onerror = () => { im.style.display = 'none'; nm.textContent = (name ? name + ' — ' : '') + 'изображение недоступно'; };
  im.src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}
function closeLightbox() { document.getElementById('lightbox').classList.add('hidden'); document.getElementById('lb-img').src = ''; }

// ---------- View switching ---------------------------------------------
// держим URL-хэш в актуальном состоянии, чтобы обновление страницы не сбрасывало вкладку
function syncHash() {
  let t = 'mine';
  const v = ui.view;
  if (v === 'home') t = 'home';
  else if (v === 'all') t = 'all';
  else if (v === 'finder') t = 'finder';
  else if (v === 'kappa') t = 'kappa';
  else if (v === 'planner') t = ui.plannerTab === 'plan' ? 'planner' : (ui.mapFullscreen ? 'fs=' : 'loc=') + ui.plannerTab;
  try { history.replaceState(null, '', '#' + t); } catch { try { location.hash = t; } catch {} }
}
function setView(v) {
  ui.view = v;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  ['home', 'mine', 'all', 'planner', 'finder', 'kappa'].forEach((x) => document.getElementById('view-' + x).classList.toggle('hidden', x !== v));
  const questView = v === 'mine' || v === 'all';
  document.getElementById('filters').classList.toggle('hidden', !questView);
  document.getElementById('stats').classList.toggle('hidden', !(questView || v === 'planner'));
  if (v === 'mine') renderQuests('mine');
  else if (v === 'all') renderQuests('all');
  else if (v === 'planner') renderPlanner();
  else if (v === 'finder') renderFinder();
  else if (v === 'kappa') renderKappa();
  syncHash();
}
function gotoQuest(id) {
  setView('all');
  ui.expanded.add(id);
  renderQuests('all');
  const el = document.querySelector(`#view-all .qrow[data-id="${id}"]`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid var(--gold)'; setTimeout(() => (el.style.outline = ''), 1500); }
  else toast('Квест скрыт фильтрами');
}

// ---------- Events ------------------------------------------------------
function questTableClick(e, scope) {
  if (progressClick(e)) return;
  const cur = e.target.closest('[data-current]'); if (cur) { markAsCurrent(cur.dataset.current); return; }
  if (e.target.id === 'reset-progress') { resetProgress(); return; }
  const goto = e.target.closest('[data-goto]'); if (goto) { gotoQuest(goto.dataset.goto); return; }
  const img = e.target.closest('img[data-item]'); if (img) { e.stopPropagation(); openLightbox(itemImg(img.dataset.item), itemName(img.dataset.item)); return; }
  const cb = e.target.closest('.plan-cb'); if (cb) { e.stopPropagation(); togglePlan(cb.dataset.id); return; }
  const sort = e.target.closest('[data-sort]'); if (sort) { const c = sort.dataset.sort; if (ui.sort.col === c) ui.sort.dir *= -1; else ui.sort = { col: c, dir: 1 }; renderQuests(scope); return; }
  const btn = e.target.closest('[data-act]');
  if (btn) {
    e.stopPropagation(); const id = btn.dataset.id;
    if (btn.dataset.act === 'done') setStatus(id, state.completed.has(id) ? null : 'completed');
    else if (btn.dataset.act === 'fail') setStatus(id, state.failed.has(id) ? null : 'failed');
    else if (btn.dataset.act === 'active') toggleActive(id);
    else setStatus(id, null);
    return;
  }
  if (e.target.tagName === 'A') return;
  const row = e.target.closest('.qrow:not(.head)');
  if (row) { const id = row.dataset.id; if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id); renderQuests(scope); }
}

function wireEvents() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  const f = ui.filters;
  const bind = (id, key) => document.getElementById(id).addEventListener('change', (e) => { f[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderStats(); renderQuests(ui.view === 'mine' ? 'mine' : 'all'); });
  document.getElementById('f-search').addEventListener('input', (e) => { f.search = e.target.value; renderQuests(ui.view === 'mine' ? 'mine' : 'all'); });
  ['f-map:map', 'f-trader:trader', 'f-action:action', 'f-status:status', 'f-faction:faction', 'f-kappa:kappa', 'f-plan:plan', 'f-showmine:showmine', 'f-showdone:showdone'].forEach((s) => { const [i, k] = s.split(':'); bind(i, k); });
  document.getElementById('f-reset').addEventListener('click', () => {
    Object.assign(f, { search: '', map: '', trader: '', action: '', status: '', faction: '', kappa: false, plan: false, showmine: false, showdone: false });
    document.getElementById('f-search').value = '';
    ['f-map', 'f-trader', 'f-action', 'f-status', 'f-faction'].forEach((i) => (document.getElementById(i).value = ''));
    ['f-kappa', 'f-plan', 'f-showmine', 'f-showdone'].forEach((i) => (document.getElementById(i).checked = false));
    renderStats(); renderQuests(ui.view === 'mine' ? 'mine' : 'all');
  });

  document.getElementById('view-mine').addEventListener('click', (e) => questTableClick(e, 'mine'));
  document.getElementById('view-all').addEventListener('click', (e) => questTableClick(e, 'all'));
  document.getElementById('view-mine').addEventListener('change', (e) => { if (progressChange(e)) return; if (e.target.classList.contains('plan-all-cb')) toggleAllPlan('mine', e.target.checked); });
  document.getElementById('view-all').addEventListener('change', (e) => { if (progressChange(e)) return; if (e.target.classList.contains('plan-all-cb')) toggleAllPlan('all', e.target.checked); });
  document.getElementById('view-mine').addEventListener('input', (e) => {
    if (e.target.id === 'onb-input') { ui.onbQuery = e.target.value; const box = document.getElementById('onb-results'); if (box) box.innerHTML = onbResultsHtml(); }
  });

  // planner
  const planView = document.getElementById('view-planner');
  planView.addEventListener('click', (e) => {
    const psub = e.target.closest('[data-ptab]'); if (psub) { ui.plannerTab = psub.dataset.ptab; ui.map = { z: 0, x: 0, y: 0 }; ui.mapFloor = null; renderPlanner(); syncHash(); return; }
    if (e.target.id === 'map-show') { const sel = document.getElementById('map-pick'); if (sel && sel.value) { ui.plannerTab = sel.value; ui.mapFullscreen = true; ui.map = { z: 0, x: 0, y: 0 }; ui.mapFloor = null; renderPlanner(); syncHash(); } return; }
    const pin = e.target.closest('[data-pinobj]'); if (pin) { const li = document.querySelector(`#view-planner [data-li-obj="${pin.dataset.pinobj}"]`); if (li) { li.scrollIntoView({ behavior: 'smooth', block: 'center' }); li.classList.add('li-flash'); setTimeout(() => li.classList.remove('li-flash'), 1200); } return; }
    if (progressClick(e)) return;
    const goto = e.target.closest('[data-goto]'); if (goto) { gotoQuest(goto.dataset.goto); return; }
    const img = e.target.closest('img[data-item]'); if (img) { openLightbox(img.dataset.itemimg || itemImg(img.dataset.item), itemName(img.dataset.item)); return; }
    const rm = e.target.closest('[data-rm]'); if (rm) { togglePlan(rm.dataset.rm); return; }
    if (e.target.id === 'plan-clear') { state.plan.clear(); persistPlan(); renderStats(); renderPlanner(); }
  });
  planView.addEventListener('change', (e) => {
    const ly = e.target.closest('[data-layer]'); if (ly) { ui.mapLayers[ly.dataset.layer] = ly.checked; const el = document.querySelector('.layer-' + ly.dataset.layer); if (el) el.hidden = !ly.checked; return; }
    if (progressChange(e)) return;
    const sel = e.target.closest('[data-choice]'); if (sel) { state.planChoices[sel.dataset.choice] = sel.value; persistPlan(); renderPlanner(); }
  });

  // finder
  const finder = document.getElementById('view-finder');
  finder.addEventListener('click', (e) => {
    if (e.target.id === 'add-group') { state.findGroups.push({ id: (crypto.randomUUID ? crypto.randomUUID() : 'g' + Date.now()), name: 'Новая группа', desc: '', items: [] }); persistFinder(); renderFinder(); return; }
    const del = e.target.closest('[data-delgroup]'); if (del) { state.findGroups = state.findGroups.filter((g) => g.id !== del.dataset.delgroup); persistFinder(); renderFinder(); return; }
    const add = e.target.closest('[data-additem]'); if (add) { const g = findGroup(add.dataset.group); if (g && !g.items.some((i) => i.id === add.dataset.additem)) { g.items.push({ id: add.dataset.additem, found: false, qty: 1 }); persistFinder(); renderFinder(); } return; }
    const rmi = e.target.closest('[data-rmitem]'); if (rmi) { const g = findGroup(rmi.dataset.group); if (g) { g.items = g.items.filter((i) => i.id !== rmi.dataset.rmitem); persistFinder(); renderFinder(); } return; }
    const img = e.target.closest('img[data-item]'); if (img) { openLightbox(img.dataset.itemimg || img.src, ''); return; }
  });
  finder.addEventListener('input', (e) => {
    const qi = e.target.closest('[data-qty]');
    if (qi) { const g = findGroup(qi.dataset.group); const it = g && g.items.find((i) => i.id === qi.dataset.qty); if (it) { it.qty = Math.max(1, parseInt(qi.value, 10) || 1); persistFinder(); } return; }
    const s = e.target.closest('[data-fsearch]');
    if (s) {
      const box = document.getElementById('res-' + s.dataset.fsearch);
      const run = () => { const res = searchCatalog(s.value); box.innerHTML = res.map((i) => `<div class="r" data-additem="${i.id}" data-group="${s.dataset.fsearch}">${i.icon ? `<img src="${i.icon}" onerror="this.style.display='none'">` : ''}<span>${esc(i.name)}</span>${i.cat ? `<span class="cat-mini">${esc(i.cat)}</span>` : ''}</div>`).join(''); };
      if (catalog) run(); else { box.innerHTML = '<div class="r">загрузка каталога…</div>'; loadCatalog().then(run); }
    }
  });
  finder.addEventListener('change', (e) => {
    const found = e.target.closest('[data-found]'); if (found) { const g = findGroup(found.dataset.group); const it = g && g.items.find((i) => i.id === found.dataset.found); if (it) { it.found = found.checked; persistFinder(); renderFinder(); } return; }
    const nm = e.target.closest('[data-name]'); if (nm) { const g = findGroup(nm.dataset.name); if (g) { g.name = nm.value; persistFinder(); } return; }
    const ds = e.target.closest('[data-desc]'); if (ds) { const g = findGroup(ds.dataset.desc); if (g) { g.desc = ds.value; persistFinder(); } return; }
  });

  // kappa
  const kappa = document.getElementById('view-kappa');
  kappa.addEventListener('change', (e) => {
    if (e.target.id === 'kappa-hidefound') { ui.kappaHideFound = e.target.checked; renderKappa(); return; }
    if (progressChange(e)) return;
  });
  kappa.addEventListener('input', (e) => { if (e.target.id === 'kappa-search') { ui.kappaSearch = e.target.value; const g = document.getElementById('kappa-grid'); if (g) g.innerHTML = kappaGridHtml(kappaItems()); } });
  kappa.addEventListener('click', (e) => { const img = e.target.closest('img[data-item]'); if (img) { openLightbox(itemImg(img.dataset.item), itemName(img.dataset.item)); } });

  // brand -> home
  document.getElementById('brand').addEventListener('click', () => setView('home'));

  // lightbox
  document.getElementById('lightbox').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
    if (ui.mapFullscreen) { ui.mapFullscreen = false; ui.map.z = 0; renderPlanner(); syncHash(); }
  });
}

// ---------- Boot --------------------------------------------------------
async function loadData() {
  try { const r = await fetch('data/quests.json', { cache: 'no-cache' }); if (r.ok) return await r.json(); throw new Error('http ' + r.status); }
  catch (e) { if (window.__QUESTS__) return window.__QUESTS__; throw e; }
}
(async function boot() {
  try { data = await loadData(); }
  catch (e) { document.getElementById('view-mine').innerHTML = `<div class="loading">Не удалось загрузить data/quests.json.<br>Откройте через локальный сервер.<br><br>${esc(e.message)}</div>`; return; }
  buildIndices();
  await migrateData();
  await loadState();
  await loadMapsGeo();
  addGeoOnlyMaps();
  recomputeFailed();
  fillFilterOptions();
  wireEvents();
  document.getElementById('meta').textContent = 'планировщик рейда EFT';
  renderStats();
  // первое открытие (по куке) — главная + плашка про куки, далее — «Мои квесты»
  const firstVisit = !getCookie('th_visited');
  if (firstVisit) {
    setCookie('th_visited', '1', 365);
    const bar = document.getElementById('cookie-bar');
    bar.classList.remove('hidden');
    document.getElementById('cookie-ok').addEventListener('click', () => bar.classList.add('hidden'));
  }
  // восстановление вкладки из URL-хэша (исходный хэш читаем ДО setView, т.к. syncHash его перезапишет)
  const hash = location.hash;
  if (hash === '#planner') setView('planner');
  else if (hash === '#finder') setView('finder');
  else if (hash === '#all') setView('all');
  else if (hash === '#kappa') setView('kappa');
  else if (hash === '#home') setView('home');
  else if (hash === '#mine') setView('mine');
  else if (hash.startsWith('#loc=')) { ui.plannerTab = decodeURIComponent(hash.slice(5)); setView('planner'); }
  else if (hash.startsWith('#fs=')) { ui.plannerTab = decodeURIComponent(hash.slice(4)); ui.mapFullscreen = true; setView('planner'); }
  else if (hash.startsWith('#q=')) gotoQuest(decodeURIComponent(hash.slice(3)));
  else setView(firstVisit ? 'home' : 'mine');
})();
