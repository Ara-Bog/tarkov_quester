"use strict";
/* ============================================================
   Tarkov Help — quest tracker, raid planner & loot finder
   Data: data/quests.json, data/items.json (from api.tarkov.dev)
   State: IndexedDB (fallback localStorage / memory)
   ============================================================ */

// Service worker — чтобы сайт обновлялся без Ctrl+Shift+R (см. sw.js).
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
	navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------- Storage: IndexedDB with localStorage / memory fallback ------
// Versioning (see migrateData() below):
//   DB_VERSION   — структурная версия IndexedDB (объектные хранилища). Бамп => onupgradeneeded.
//   DATA_VERSION — версия ФОРМАТА хранимых значений. Бамп => миграции данных в migrateData().
// Это позволяет безопасно обновлять сайт на gh-pages: у существующих пользователей
// данные мигрируются, а не ломаются.
const DB_VERSION = 1;
const DATA_VERSION = 1;
const DB = (() => {
	const NAME = "tarkov_help",
		STORE = "kv",
		OPEN_TIMEOUT = 2500;
	let mode = "idb",
		dbp = null;
	const mem = {};
	function lsOk() {
		try {
			localStorage.setItem("__th_test", "1");
			localStorage.removeItem("__th_test");
			return true;
		} catch {
			return false;
		}
	}
	function openIdb() {
		return new Promise((res, rej) => {
			let done = false;
			const to = setTimeout(() => {
				if (!done) {
					done = true;
					rej(new Error("idb open timeout"));
				}
			}, OPEN_TIMEOUT);
			let r;
			try {
				r = indexedDB.open(NAME, DB_VERSION);
			} catch (e) {
				clearTimeout(to);
				return rej(e);
			}
			r.onupgradeneeded = (ev) => {
				const db = r.result,
					old = ev.oldVersion || 0;
				// Лестница структурных миграций. Новые версии добавляйте ниже, не меняя прошлые.
				if (old < 1) {
					if (!db.objectStoreNames.contains(STORE))
						db.createObjectStore(STORE, { keyPath: "key" });
				}
				// if (old < 2) { ... добавить/изменить хранилища для DB_VERSION=2 ... }
			};
			r.onsuccess = () => {
				if (done) return;
				done = true;
				clearTimeout(to);
				res(r.result);
			};
			r.onerror = () => {
				if (done) return;
				done = true;
				clearTimeout(to);
				rej(r.error || new Error("idb error"));
			};
		});
	}
	async function ensure() {
		if (mode !== "idb") return;
		if (!("indexedDB" in window) || !window.indexedDB) {
			mode = lsOk() ? "ls" : "mem";
			return;
		}
		if (!dbp) dbp = openIdb();
		try {
			await dbp;
		} catch {
			dbp = null;
			mode = lsOk() ? "ls" : "mem";
			console.warn(
				"[storage] IndexedDB недоступен, переключаюсь на",
				mode,
			);
		}
	}
	async function get(key, def) {
		await ensure();
		if (mode === "idb") {
			try {
				const db = await dbp;
				return await new Promise((res) => {
					const tx = db
						.transaction(STORE, "readonly")
						.objectStore(STORE)
						.get(key);
					tx.onsuccess = () => res(tx.result ? tx.result.value : def);
					tx.onerror = () => res(def);
				});
			} catch {
				mode = lsOk() ? "ls" : "mem";
			}
		}
		if (mode === "ls") {
			try {
				const v = localStorage.getItem("th_" + key);
				return v == null ? def : JSON.parse(v);
			} catch {
				return def;
			}
		}
		return key in mem ? mem[key] : def;
	}
	async function set(key, value) {
		await ensure();
		if (mode === "idb") {
			try {
				const db = await dbp;
				return await new Promise((res) => {
					const tx = db.transaction(STORE, "readwrite");
					tx.objectStore(STORE).put({ key, value });
					tx.oncomplete = () => res();
					tx.onerror = () => res();
				});
			} catch {
				mode = lsOk() ? "ls" : "mem";
			}
		}
		if (mode === "ls") {
			try {
				localStorage.setItem("th_" + key, JSON.stringify(value));
			} catch {}
			return;
		}
		mem[key] = value;
	}
	return { get, set, mode: () => mode };
})();

// ---------- Global state ------------------------------------------------
let data = null;
const taskById = new Map();
const itemById = new Map();
const itemByName = new Map(); // имя (lowercase) -> id, для разрешения именованных предметов сюжетки
const mapById = new Map();
const mapIdByName = new Map(); // имя локации -> id (для определения карты по описанию цели)
// названия локаций в описаниях целей (капитализированные, разные падежи) -> каноническое имя.
// Нужно, когда у findItem-цели нет maps в данных tarkov.dev, но локация указана в тексте.
const MAP_NAME_RE = [
	[/Таможн/, "Таможня"],
	[/Лес[уае]|\bЛес\b/, "Лес"],
	[/Берег/, "Берег"],
	[/Маяк/, "Маяк"],
	[/Развязк/, "Развязка"],
	[/Резерв/, "Резерв"],
	[/Завод/, "Завод"],
	[/Лаборатор/, "Лаборатория"],
	[/Улиц/, "Улицы Таркова"],
	[/Эпицентр/, "Эпицентр"],
	[/Лабиринт/, "Лабиринт"],
	[/Ледокол/, "Ледокол"],
	[/Терминал/, "Терминал"],
];
function mapsFromText(text) {
	const s = String(text || "");
	const ids = [];
	for (const [re, name] of MAP_NAME_RE) {
		if (re.test(s)) {
			const id = mapIdByName.get(name);
			if (id && !ids.includes(id)) ids.push(id);
		}
	}
	return ids;
}
// эффективные локации цели: из данных, иначе вычисленные по описанию
function effectiveMaps(o) {
	if (o.maps && o.maps.length) return o.maps;
	return mapsFromText(o.description);
}
const traderById = new Map();
const unlocksMap = new Map(); // taskId -> [taskIds it unlocks] (требование status=complete)
const failedUnlocksMap = new Map(); // taskId -> [taskIds, которые открываются, когда этот ПРОВАЛЕН]
const failsOnComplete = new Map(); // taskId -> [taskIds that fail when this completes]
let failedAll = new Set();
let collectorTask = null; // квест "Коллекционер" (предметы для Каппы)
// типы целей, выполняемые НЕПОСРЕДСТВЕННО в рейде — их показываем для безлокационных
// квестов на любой карте. «Сдать» торговцу, навыки, сборка, репутация и т.п. — не рейдовые.
const IN_RAID_TYPES = new Set([
	"findItem",
	"findQuestItem",
	"plantItem",
	"plantQuestItem",
	"mark",
	"shoot",
	"extract",
	"visit",
	"useItem",
]);

// emoji-иконка для категории/именованного предмета по ключевым словам (различать по картинке, не по тексту)
const CAT_EMOJI = [
	[/оружи|пистолет|винтовк|автомат|дробовик|пулемёт|пулемет|снайпер|weapon/i, "🔫"],
	[/патрон|боеприпас|ammo/i, "🟡"],
	[/медицин|медик|медикамент|лекарств|аптеч|таблет|стимул|инъект|meds|medical/i, "💊"],
	[/строймат|строительн|building/i, "🧱"],
	[/инструмент|tool/i, "🔧"],
	[/ремонт|ремкомпл|repair/i, "🧰"],
	[/жетон|dogtag/i, "🏷️"],
	[/батаре|аккумулятор|battery/i, "🔋"],
	[/электрон|микросхем|плата|платы|чип|компьютер|комплектующ|electronic/i, "🔌"],
	[/контейнер|кейс|container|case/i, "🧳"],
	[/(?<![а-яё])еда(?![а-яё])|напитк|провизи|питани|пайк|консерв|сухпай|снэк|провиант|food/i, "🥫"],
	[/ключ|key/i, "🔑"],
	[/брон|armor|защит|шлем|каск/i, "🛡️"],
	[/ценн|бартер|valuable|драгоцен/i, "💎"],
	[/информ|документ|кассет|флешк|жёстк|жестк|записк|отчёт|отчет|стенограмм|носител|intel|data/i, "💾"],
	[/топлив|fuel|бензин|горюч/i, "⛽"],
	[/одежд|снаряж|разгруз|рюкзак|сумк|gear/i, "🎒"],
	[/табак|сигарет|алкогол/i, "🚬"],
];
function catEmoji(text, isCat) {
	const s = String(text || "");
	for (const [re, e] of CAT_EMOJI) if (re.test(s)) return e;
	return isCat ? "📋" : "📦";
}

// ---- Прогресс по целям квестов (сделано из N) -------------------------
const objDone = (id) => state.progress[id] || 0;
const NON_TRACKABLE = new Set([
	"skill",
	"traderLevel",
	"traderStanding",
	"experience",
	"playerLevel",
	"taskStatus",
]);
const trackable = (o) => !NON_TRACKABLE.has(o.type);
const objTotal = (o) => o.count || 1;
const objRemaining = (o) => Math.max(0, objTotal(o) - objDone(o.id));

const state = {
	completed: new Set(),
	failed: new Set(),
	active: new Set(), // "мои квесты"
	plan: new Set(), // выбраны для рейда
	planChoices: {},
	findGroups: [], // [{id,name,desc,items:[{id,found,qty}]}]
	progress: {}, // objectiveId -> сколько единиц цели уже сделано
	storyDone: new Set(), // id выполненных подзадач сюжетных квестов
	storyBranch: {}, // questId -> выбранная ветка (концовка) сюжетного квеста
	storyStarted: new Set(), // id начатых сюжетных квестов («Начать главу»)
	found: {}, // ключ предмета в «Найти в рейде» -> сколько найдено (чек-лист рейда)
};
const ui = {
	view: "mine",
	expanded: new Set(),
	onbQuery: "",
	plannerTab: "plan",
	map: { z: 0, x: 0, y: 0 },
	mapLayers: { extracts: true, bosses: true, quests: true },
	mapFullscreen: false,
	mapFloor: null,
	showFindings: true, // карточка «Найти в рейде» (предметы квестов + список находок)
	kappaSearch: "",
	kappaHideFound: false,
	sort: { col: "status", dir: 1 },
	filters: {
		search: "",
		map: "",
		trader: "",
		action: "",
		status: "",
		faction: "",
		kappa: false,
		plan: false,
		showdone: false,
	},
};

const STATUS_RU = {
	available: "Доступен",
	locked: "Заблокирован",
	completed: "Выполнен",
	failed: "Провален",
};
const STATUS_RANK = { available: 0, locked: 1, completed: 2, failed: 3 };
// упрощённый статус для отображения: без «Доступен»/«Заблокирован» — только выполнен/невыполнен/провален
const dispStatus = (st) =>
	st === "completed" || st === "failed" ? st : "todo";
const DISP_RU = { completed: "Выполнен", failed: "Провален", todo: "Невыполнен" };
const MAP_COLORS = {
	Таможня: "#b8945f",
	Завод: "#8a8f98",
	Лес: "#6f8f4e",
	Берег: "#4e9f9f",
	Резерв: "#b5604a",
	Маяк: "#5b8fc9",
	"Улицы Таркова": "#9b7fc9",
	Развязка: "#d08a3e",
	Лаборатория: "#c75d8f",
	Эпицентр: "#d4b94e",
	Лабиринт: "#7d5fb0",
	Ледокол: "#7fb0c9",
};
function mapColor(id) {
	const m = mapById.get(id);
	if (!m) return "#777";
	if (MAP_COLORS[m.name]) return MAP_COLORS[m.name];
	let h = 0;
	for (const c of m.name) h = (h * 31 + c.charCodeAt(0)) % 360;
	return `hsl(${h} 45% 55%)`;
}

// ---------- Helpers -----------------------------------------------------
const esc = (s) =>
	String(s == null ? "" : s).replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	);
// нормализация для поиска: нижний регистр + ё→е (чтобы е/ё считались одной буквой)
const searchNorm = (s) => String(s).toLowerCase().replace(/ё/g, "е");
const itemName = (id) => {
	const i = itemById.get(id);
	return i ? i.name : id;
};
const itemShort = (id) => {
	const i = itemById.get(id);
	return i ? i.shortName || i.name : id;
};
const itemIcon = (id) => {
	const i = itemById.get(id);
	return i ? i.icon : null;
};
const itemImg = (id) => {
	const i = itemById.get(id);
	return i ? i.img || i.icon : null;
};
const mapName = (id) => {
	const m = mapById.get(id);
	return m ? m.name : id;
};
const traderName = (id) => {
	const t = traderById.get(id);
	return t ? t.name : id;
};
const shorten = (s, n = 60) =>
	s && s.length > n ? s.slice(0, n - 1) + "…" : s;
// ссылка на русскую вики EFT по названию квеста
const ruWiki = (name) =>
	"https://escapefromtarkov.fandom.com/ru/wiki/" +
	encodeURIComponent(String(name).replace(/ /g, "_"));
const wikiLink = (name, cls = "obj-guide") =>
	name
		? `<a class="${cls}" href="${ruWiki(name)}" target="_blank" rel="noopener" title="Открыть квест на вики">wiki ↗</a>`
		: "";

function toast(msg) {
	const el = document.getElementById("toast");
	el.textContent = msg;
	el.classList.add("show");
	clearTimeout(toast._t);
	toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- Cookies (для флага первого визита) -------------------------
function getCookie(name) {
	const m = document.cookie.match(
		"(?:^|; )" +
			name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") +
			"=([^;]*)",
	);
	return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(name, value, days) {
	let s = name + "=" + encodeURIComponent(value) + "; path=/; SameSite=Lax";
	if (days) s += "; max-age=" + days * 86400;
	try {
		document.cookie = s;
	} catch {}
}

// item icon chip (with lightbox hook). cls adds styling.
function itImg(id) {
	const ic = itemIcon(id);
	return ic
		? `<img src="${ic}" data-item="${id}" loading="lazy" onerror="this.style.display='none'">`
		: "";
}

// ---------- Status / dependency logic -----------------------------------
function recomputeFailed() {
	const fa = new Set(state.failed);
	for (const t of data.tasks) {
		if (state.completed.has(t.id)) continue;
		if (t.failedBy && t.failedBy.some((fid) => state.completed.has(fid)))
			fa.add(t.id);
	}
	for (const id of state.completed) fa.delete(id);
	failedAll = fa;
}
function reqMet(t) {
	for (const r of t.requires || []) {
		const st = r.status || ["complete"];
		let ok = false;
		// complete — предыдущий квест выполнен
		if (st.includes("complete") && state.completed.has(r.task)) ok = true;
		// active — предыдущий квест взят/в работе (или уже выполнен); НЕ требует завершения
		if (
			st.includes("active") &&
			(state.active.has(r.task) || state.completed.has(r.task))
		)
			ok = true;
		// failed — предыдущий квест должен быть провален (ветка-альтернатива)
		if (st.includes("failed") && failedAll.has(r.task)) ok = true;
		if (!ok) return false;
	}
	return true;
}
function statusOf(t) {
	if (state.completed.has(t.id)) return "completed";
	if (failedAll.has(t.id)) return "failed";
	if (reqMet(t)) return "available";
	return "locked";
}

// одноимённые квесты (напр. «Новое начало» ×4 — престиж 0/1/2/3, «Обновка» — BEAR/USEC)
// делаем различимыми: дописываем к названию престиж / фракцию / номер
function disambiguateNames() {
	const byName = new Map();
	for (const t of data.tasks)
		(byName.get(t.name) || byName.set(t.name, []).get(t.name)).push(t);
	for (const [name, list] of byName) {
		if (list.length < 2) continue;
		const anyPrestige = list.some((t) => t.prestige != null);
		const allFaction = list.every((t) => t.faction);
		list.forEach((t, i) => {
			let suffix;
			if (anyPrestige) suffix = `Престиж ${t.prestige || 0}`;
			else if (allFaction) suffix = t.faction;
			else suffix = String(i + 1);
			t.name = `${name} (${suffix})`;
		});
	}
}

// ---------- Build indices ----------------------------------------------
function buildIndices() {
	disambiguateNames();
	data.tasks.forEach((t) => taskById.set(t.id, t));
	Object.values(data.items).forEach((i) => {
		itemById.set(i.id, i);
		if (i.name) itemByName.set(i.name.toLowerCase(), i.id);
	});
	data.maps.forEach((m) => {
		mapById.set(m.id, m);
		mapIdByName.set(m.name, m.id);
	});
	data.traders.forEach((t) => traderById.set(t.id, t));
	for (const t of data.tasks) {
		for (const r of t.requires || []) {
			const rst = r.status || ["complete"];
			if (rst.includes("complete")) {
				if (!unlocksMap.has(r.task)) unlocksMap.set(r.task, []);
				unlocksMap.get(r.task).push(t.id);
			}
			if (rst.includes("failed")) {
				if (!failedUnlocksMap.has(r.task)) failedUnlocksMap.set(r.task, []);
				failedUnlocksMap.get(r.task).push(t.id);
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
			for (const h of o.handIn) {
				if (h.item) parts.push(itemName(h.item));
				if (h.category) parts.push(h.category);
			}
		}
		for (const mid of t.maps) parts.push(mapName(mid));
		t._search = searchNorm(parts.join(" "));
	}
	collectorTask =
		data.tasks.find((t) => t.normalizedName === "collector") ||
		data.tasks.find((t) => t.name === "Коллекционер") ||
		null;
}

// ---------- Persistence -------------------------------------------------
async function persistProgress() {
	await DB.set("completed", [...state.completed]);
	await DB.set("failed", [...state.failed]);
	await DB.set("active", [...state.active]);
}
async function persistObjProgress() {
	await DB.set("progress", state.progress);
}
async function persistPlan() {
	await DB.set("plan", [...state.plan]);
	await DB.set("planChoices", state.planChoices);
}
async function persistFinder() {
	await DB.set("findGroups", state.findGroups);
}
// Миграции ФОРМАТА хранимых данных. Запускается до loadState().
async function migrateData() {
	let v = await DB.get("dataVersion", null);
	if (v === null) {
		// Нет версии: либо новый пользователь, либо старый (до версионирования).
		const existing =
			(await DB.get("findGroups", null)) !== null ||
			(await DB.get("completed", null)) !== null ||
			(await DB.get("active", null)) !== null;
		v = existing ? 0 : DATA_VERSION;
	}
	// Лестница миграций данных. Каждый шаг переводит формат на +1.
	if (v < 1) {
		// v0 -> v1: у предметов в "Списке находок" появилось поле qty (искомое количество).
		const groups = await DB.get("findGroups", []);
		let changed = false;
		for (const g of groups)
			for (const it of g.items || [])
				if (it.qty == null) {
					it.qty = 1;
					changed = true;
				}
		if (changed) await DB.set("findGroups", groups);
		v = 1;
	}
	// if (v < 2) { ...; v = 2; }
	if (v !== DATA_VERSION) await DB.set("dataVersion", DATA_VERSION);
}
async function loadState() {
	state.completed = new Set(await DB.get("completed", []));
	state.failed = new Set(await DB.get("failed", []));
	state.active = new Set(await DB.get("active", []));
	state.plan = new Set(await DB.get("plan", []));
	state.planChoices = (await DB.get("planChoices", {})) || {};
	state.findGroups = (await DB.get("findGroups", [])) || [];
	state.progress = (await DB.get("progress", {})) || {};
	state.storyDone = new Set(await DB.get("storyDone", []));
	state.storyBranch = (await DB.get("storyBranch", {})) || {};
	state.storyStarted = new Set(await DB.get("storyStarted", []));
	state.found = (await DB.get("found", {})) || {};
}
async function persistFound() {
	await DB.set("found", state.found);
}
async function persistStory() {
	await DB.set("storyDone", [...state.storyDone]);
	await DB.set("storyBranch", state.storyBranch);
	await DB.set("storyStarted", [...state.storyStarted]);
}

// ---------- Mutations ---------------------------------------------------
function setStatus(id, st) {
	state.completed.delete(id);
	state.failed.delete(id);
	if (st === "completed") state.completed.add(id);
	else if (st === "failed") state.failed.add(id);
	recomputeFailed();
	// auto-add newly unlocked quests into "мои квесты"
	if (st === "completed") {
		// кандидаты: прямые разблокировки (требование complete) +
		// разблокировки через провал альтернатив, которые провалились из-за этого завершения
		const candidates = new Set(unlocksMap.get(id) || []);
		for (const nf of failsOnComplete.get(id) || []) {
			if (failedAll.has(nf))
				for (const u of failedUnlocksMap.get(nf) || []) candidates.add(u);
		}
		const added = [];
		for (const uid of candidates) {
			if (
				state.completed.has(uid) ||
				failedAll.has(uid) ||
				state.active.has(uid)
			)
				continue;
			const ut = taskById.get(uid);
			if (ut && reqMet(ut)) {
				state.active.add(uid);
				added.push(ut.name);
			}
		}
		if (added.length) toast("В мои квесты добавлено: " + added.join(", "));
	}
	persistProgress();
	renderStats();
	renderActiveViews();
}
function toggleActive(id) {
	if (state.active.has(id)) state.active.delete(id);
	else state.active.add(id);
	persistProgress();
	renderStats();
	renderActiveViews();
}
// "У меня сейчас этот квест": все предыдущие по ветке -> Выполнен, сам квест -> активен.
function markAsCurrent(id) {
	const toComplete = new Set();
	(function collect(qid) {
		const t = taskById.get(qid);
		if (!t) return;
		for (const r of t.requires || []) {
			// идём только по основной ветке (status=complete); active/failed-ветки
			// не достраиваем — это альтернативные/опциональные предыдущие квесты
			const st = r.status || ["complete"];
			if (st.includes("complete") && !st.includes("failed") && !toComplete.has(r.task)) {
				toComplete.add(r.task);
				collect(r.task);
			}
		}
	})(id);
	for (const q of toComplete) {
		state.completed.add(q);
		state.failed.delete(q);
	}
	state.completed.delete(id);
	state.failed.delete(id);
	state.active.add(id);
	recomputeFailed();
	persistProgress();
	ui.onbQuery = "";
	renderStats();
	renderActiveViews();
	toast(
		`«${taskById.get(id).name}» — текущий. Предыдущих отмечено выполненными: ${toComplete.size}.`,
	);
}
function resetProgress() {
	if (
		!confirm(
			"Сбросить весь прогресс по квестам (выполненные, проваленные, мои квесты, прогресс целей)?\n\nПлан рейда и список находок останутся.",
		)
	)
		return;
	state.completed.clear();
	state.failed.clear();
	state.active.clear();
	state.progress = {};
	recomputeFailed();
	persistProgress();
	persistObjProgress();
	renderStats();
	renderActiveViews();
	toast("Прогресс по квестам сброшен.");
}
function setProgress(objId, val) {
	val = Math.max(0, val || 0);
	if (val <= 0) delete state.progress[objId];
	else state.progress[objId] = val;
	persistObjProgress();
	if (ui.view === "planner") renderPlanner();
	else if (ui.view === "kappa") renderKappa();
	else renderActiveViews();
}
// общие обработчики прогресса (степпер / чекбокс) для всех вкладок
function progressClick(e) {
	const stb = e.target.closest(".st-btn");
	if (!stb) return false;
	const sp = stb.closest(".stepper");
	if (!sp) return false; // не степпер цели (напр. чек-лист «нашёл в рейде»)
	const id = sp.dataset.obj;
	const total = +sp.dataset.total;
	setProgress(
		id,
		Math.max(0, Math.min(total, objDone(id) + +stb.dataset.step)),
	);
	return true;
}
function progressChange(e) {
	const oc = e.target.closest("[data-objchk]");
	if (!oc) return false;
	setProgress(oc.dataset.objchk, oc.checked ? +oc.dataset.total || 1 : 0);
	return true;
}
function trackControlHtml(o) {
	if (!trackable(o)) return "";
	const total = objTotal(o),
		done = objDone(o.id);
	if (total === 1) {
		return `<input type="checkbox" class="track-chk" data-objchk="${o.id}" data-total="1" ${done >= 1 ? "checked" : ""} title="${done >= 1 ? "Выполнено" : "Отметить выполнение"}">`;
	}
	return `<span class="stepper" data-obj="${o.id}" data-total="${total}">
    <button class="st-btn" data-step="-1" title="убавить">−</button>
    <b class="st-val ${done >= total ? "done" : ""}">${done}</b><span class="st-tot">/ ${total}</span>
    <button class="st-btn" data-step="1" title="прибавить">+</button>
    ${done > 0 && done < total ? `<span class="st-rem">осталось ${total - done}</span>` : ""}
  </span>`;
}
function togglePlan(id) {
	if (state.plan.has(id)) state.plan.delete(id);
	else state.plan.add(id);
	persistPlan();
	renderStats();
	if (ui.view === "planner") renderPlanner();
	document.querySelectorAll(`.plan-cb[data-id="${id}"]`).forEach((cb) => {
		cb.checked = state.plan.has(id);
	});
}
// «выбрать все» в шапке «Мои квесты» — добавить/убрать все показанные квесты из плана рейда
function toggleAllPlan(scope, checked) {
	const list = filteredTasks(scope);
	if (checked) {
		const toAdd = list.filter((t) => !state.plan.has(t.id));
		if (
			toAdd.length > 5 &&
			!confirm(
				`В план рейда будут добавлены все ${toAdd.length} показанных квестов. Продолжить?`,
			)
		) {
			renderQuests(scope);
			return;
		}
		list.forEach((t) => state.plan.add(t.id));
	} else {
		list.forEach((t) => state.plan.delete(t.id));
	}
	persistPlan();
	renderStats();
	renderQuests(scope);
}
function renderActiveViews() {
	if (ui.view === "mine") renderQuests("mine");
	else if (ui.view === "all") renderQuests("all");
	else if (ui.view === "planner") renderPlanner();
}
// ---------- Filtering & sorting ----------------------------------------
function baseTasks(scope) {
	return scope === "mine"
		? data.tasks.filter((t) => state.active.has(t.id))
		: data.tasks;
}
function filteredTasks(scope) {
	const f = ui.filters,
		q = searchNorm(f.search.trim());
	let list = baseTasks(scope).filter((t) => {
		if (f.faction && t.faction !== f.faction) return false;
		if (f.kappa && !t.kappa) return false;
		if (f.plan && !state.plan.has(t.id)) return false;
		if (f.trader && t.trader !== f.trader) return false;
		if (f.map === "__none__") {
			if (t.maps.length || t.objectives.some((o) => o.maps.length))
				return false;
		} else if (
			f.map &&
			!t.maps.includes(f.map) &&
			!t.objectives.some((o) => o.maps.includes(f.map))
		)
			return false;
		if (f.action && !t.objectives.some((o) => o.action === f.action))
			return false;
		const st = statusOf(t);
		if (f.status && dispStatus(st) !== f.status) return false;
		// По умолчанию выполненные скрыты; показываем только если включён фильтр или явно выбран статус "Выполненные".
		if (!f.showdone && f.status !== "completed" && st === "completed")
			return false;
		if (q && !t._search.includes(q)) return false;
		return true;
	});
	const { col, dir } = ui.sort;
	const key = (t) =>
		col === "name"
			? t.name.toLowerCase()
			: col === "loc"
				? t.maps.map(mapName).sort()[0] || "яяя"
				: col === "trader"
					? traderName(t.trader)
					: /* status */ STATUS_RANK[statusOf(t)];
	list.sort((a, b) => {
		const ka = key(a),
			kb = key(b);
		if (ka < kb) return -dir;
		if (ka > kb) return dir;
		return a.name.localeCompare(b.name, "ru");
	});
	return list;
}

// ---------- Filter option lists ----------------------------------------
function fillFilterOptions() {
	const mapSel = document.getElementById("f-map");
	data.maps.forEach((m) =>
		mapSel.insertAdjacentHTML(
			"beforeend",
			`<option value="${m.id}">${esc(m.name)}</option>`,
		),
	);
	mapSel.insertAdjacentHTML(
		"beforeend",
		`<option value="__none__">Без локации</option>`,
	);
	const trSel = document.getElementById("f-trader");
	data.traders.forEach((t) =>
		trSel.insertAdjacentHTML(
			"beforeend",
			`<option value="${t.id}">${esc(t.name)}</option>`,
		),
	);
	const actions = [
		...new Set(
			data.tasks.flatMap((t) => t.objectives.map((o) => o.action)),
		),
	].sort((a, b) => a.localeCompare(b, "ru"));
	const acSel = document.getElementById("f-action");
	actions.forEach((a) =>
		acSel.insertAdjacentHTML(
			"beforeend",
			`<option value="${esc(a)}">${esc(a)}</option>`,
		),
	);
}

// ---------- Stats -------------------------------------------------------
function renderStats() {
	let done = 0,
		avail = 0,
		fail = 0;
	for (const t of data.tasks) {
		const s = statusOf(t);
		if (s === "completed") done++;
		else if (s === "available") avail++;
		else if (s === "failed") fail++;
	}
	document.getElementById("stats").innerHTML =
		`<span>Мои квесты: <b>${state.active.size}</b></span>` +
		`<span class="dot">•</span><span>Доступно: <b>${avail}</b></span>` +
		`<span class="dot">•</span><span>Выполнено: <b>${done}</b> / ${data.tasks.length}</span>` +
		`<span class="dot">•</span><span>Провалено: <b>${fail}</b></span>` +
		`<span class="dot">•</span><span>В плане рейда: <b>${state.plan.size}</b></span>`;
}

// ---------- Quest table -------------------------------------------------
function bringMini(t) {
	const m = new Map();
	for (const o of t.objectives)
		for (const b of o.bring) {
			const id = b.item || (b.anyOf && b.anyOf[0]);
			if (!id) continue;
			const e = m.get(id) || { id, count: 0 };
			e.count += b.count || 1;
			m.set(id, e);
		}
	const html = [...m.values()]
		.slice(0, 5)
		.map(
			(e) =>
				`<span class="it" title="${esc(itemName(e.id))} — взять с собой">${itImg(e.id)}<span class="cnt">${e.count}</span></span>`,
		)
		.join("");
	return html || '<span class="muted">—</span>';
}
function handInMini(t) {
	const m = new Map();
	const cats = [];
	let builds = 0,
		anyN = 0;
	for (const o of t.objectives)
		for (const h of o.handIn) {
			if (h.kind === "category") {
				cats.push({ emoji: catEmoji(h.category, true), label: h.category, count: h.count || 1 });
				continue;
			}
			if (h.kind === "build") {
				builds++;
				continue;
			}
			if (h.anyOf) {
				anyN++;
				continue;
			}
			if (h.item) {
				const c = h.count || 1;
				const cur = m.get(h.item);
				if (!cur || c > cur.count)
					m.set(h.item, { id: h.item, count: c, fir: h.fir });
			}
		}
	let html = [...m.values()]
		.slice(0, 4)
		.map(
			(e) =>
				`<span class="it hand" title="${esc(itemName(e.id))} — ${e.fir ? "найти в рейде и сдать" : "купить/найти и сдать"}">${itImg(e.id)}<span class="cnt">${e.count}</span></span>`,
		)
		.join("");
	// категория — иконка-эмодзи размером с превью предмета (как у остальных)
	html += cats
		.slice(0, 4)
		.map(
			(c) =>
				`<span class="it hand cat" title="${esc(c.label)}"><span class="cat-emoji">${c.emoji}</span><span class="cnt">${c.count}</span></span>`,
		)
		.join("");
	if (builds)
		html += `<span class="more" title="собрать оружие и сдать">🔧${builds > 1 ? "×" + builds : ""}</span>`;
	if (anyN) html += `<span class="more" title="один из нескольких">…</span>`;
	return html || '<span class="muted">—</span>';
}
function questRowHtml(t, scope) {
	const st = statusOf(t);
	const inActive = state.active.has(t.id);
	const locChips =
		t.maps
			.map(
				(mid) =>
					`<span class="chip loc" style="border-left-color:${mapColor(mid)}">${esc(mapName(mid))}</span>`,
			)
			.join("") || '<span class="muted">—</span>';
	const sub = [esc(traderName(t.trader))];
	if (t.minLevel) sub.push("ур. " + t.minLevel);
	if (t.faction) sub.push(t.faction);
	if (t.kappa)
		sub.push(
			'<span class="star" title="Требуется для Каппы">★ Каппа</span>',
		);
	const cls = `qrow${st === "completed" ? " done" : ""}${st === "failed" ? " failed" : ""}${inActive ? " in-active" : ""}`;
	// «Мои квесты» — чекбокс «в план рейда»; «Все квесты» — кнопка «+» (добавить в мои квесты)
	const firstCell =
		scope === "mine"
			? `<input type="checkbox" class="plan-cb" data-id="${t.id}" ${state.plan.has(t.id) ? "checked" : ""} title="Добавить в план рейда">`
			: `<button class="ico plan-add${inActive ? " on-active" : ""}" data-act="active" data-id="${t.id}" title="${inActive ? "Убрать из моих квестов" : "Добавить в мои квесты"}">${inActive ? "✓" : "+"}</button>`;
	return `<div class="${cls}" data-id="${t.id}">
    ${firstCell}
    <div><span class="badge b-${dispStatus(st)}">${DISP_RU[dispStatus(st)]}</span></div>
    <div class="qname">${esc(t.name)}${inActive ? ' <span class="mine-tag" title="В моих квестах">★</span>' : ""}<span class="sub">${sub.join(" · ")}</span></div>
    <div class="chips">${locChips}</div>
    <div class="bring-mini">${bringMini(t)}</div>
    <div class="bring-mini">${handInMini(t)}</div>
    <div class="qctrl">
      <button class="ico done ${st === "completed" ? "on-done" : ""}" data-act="done" data-id="${t.id}" title="Выполнен">✓</button>
      <button class="ico fail ${st === "failed" ? "on-fail" : ""}" data-act="fail" data-id="${t.id}" title="Провален">✗</button>
      <button class="ico reset" data-act="reset" data-id="${t.id}" title="Сбросить статус">↺</button>
    </div>
  </div>`;
}
function sortArrow(col) {
	return ui.sort.col === col
		? `<span class="arr">${ui.sort.dir > 0 ? "▲" : "▼"}</span>`
		: "";
}
function headerHtml(list, scope) {
	const firstHead =
		scope === "mine"
			? `<div><input type="checkbox" class="plan-all-cb" ${list.length > 0 && list.every((t) => state.plan.has(t.id)) ? "checked" : ""} title="Добавить все показанные квесты в план рейда"></div>`
			: `<div title="Добавить в мои квесты">+</div>`;
	return `<div class="qrow head">
    ${firstHead}
    <div class="sortable" data-sort="status">Статус ${sortArrow("status")}</div>
    <div class="sortable" data-sort="name">Квест ${sortArrow("name")}</div>
    <div class="sortable" data-sort="loc">Локации ${sortArrow("loc")}</div>
    <div>Взять с собой</div>
    <div>Сдать</div>
    <div></div>
  </div>`;
}

function anyChip(e, title) {
	return `<span class="it bring" title="${esc(title)}">${itImg(e.anyOf[0])}${esc(itemShort(e.anyOf[0]))} +${e.anyOf.length - 1}${e.count > 1 ? ` <span class="cnt">×${e.count}</span>` : ""}</span>`;
}
function objHtml(o, qname) {
	const its = [];
	for (const b of o.bring) {
		if (b.anyOf) {
			its.push(anyChip(b, "взять с собой — одно из"));
			continue;
		}
		const t =
			b.kind === "marker"
				? "маркер"
				: b.kind === "camera"
					? "камера"
					: b.kind === "weapon"
						? "оружие"
						: b.kind === "use"
							? "использовать"
							: "заложить";
		its.push(
			`<span class="it bring" title="ВЗЯТЬ С СОБОЙ — ${t}">${itImg(b.item)}${esc(itemShort(b.item))}<span class="cnt">×${b.count || 1}</span></span>`,
		);
	}
	for (const h of o.handIn) {
		if (h.kind === "category") {
			const head = `<span class="cat-ic">${catEmoji(h.category, true)}</span>${esc(shorten(h.category, 60))}<span class="cnt">×${h.count || 1}</span><span class="firlbl">${h.fir ? "найти в рейде" : "купить/найти"}</span>`;
			const list = h.items || [];
			if (list.length) {
				// раскрывающийся список всех подходящих предметов категории
				its.push(
					`<details class="it cat catx" title="${esc(h.category)}"><summary class="cat-sum">${head}<span class="cat-n">${list.length} предм.</span></summary><div class="cat-items">${list
						.map(
							(id) =>
								`<span class="ci" title="${esc(itemName(id))}">${itImg(id)}${esc(itemShort(id))}</span>`,
						)
						.join("")}</div></details>`,
				);
			} else {
				its.push(`<span class="it cat" title="${esc(h.category)}">${head}</span>`);
			}
			continue;
		}
		if (h.anyOf) {
			its.push(anyChip(h, "найти/сдать — одно из"));
			continue;
		}
		if (h.kind === "build") {
			its.push(
				`<span class="it build" title="Собрать и сдать">🔧 ${esc(itemShort(h.item))}<span class="cnt">×${h.count || 1}</span></span>`,
			);
			continue;
		}
		its.push(
			`<span class="it handin" title="${esc(itemName(h.item))} — ${h.fir ? "найти в рейде и сдать" : "купить/найти и сдать"}">${itImg(h.item)}${esc(itemShort(h.item))}<span class="cnt">×${h.count || 1}</span><span class="firlbl">${h.fir ? "FiR" : "куп."}</span></span>`,
		);
	}
	for (const k of o.keys) {
		if (typeof k === "object") {
			its.push(
				`<span class="it key" title="ключ (один из ${k.anyOf.length})">🔑 ${esc(itemShort(k.anyOf[0]))}…</span>`,
			);
			continue;
		}
		its.push(
			`<span class="it key" title="${esc(itemName(k))} — ключ">${itImg(k)}🔑 ${esc(itemShort(k))}</span>`,
		);
	}
	const loc = o.maps.length ? o.maps.map(mapName).join(", ") : "";
	const isDone = trackable(o) && objRemaining(o) === 0 && objDone(o.id) > 0;
	const track = trackControlHtml(o);
	return `<div class="obj${o.optional ? " opt" : ""}${isDone ? " obj-done" : ""}">
    <div class="act">${esc(o.action)}${loc ? `<span class="loc-tag">${esc(loc)}</span>` : ""}</div>
    <div class="desc">${esc(o.description)}${o.optional ? ' <span class="opt-tag">(необязательно)</span>' : ""}${o.target ? ` <span class="opt-tag">→ ${esc(o.target)}</span>` : ""} ${wikiLink(qname)}</div>
    <div class="obj-items">${its.join("")}</div>
    ${track ? `<div class="obj-track">${track}</div>` : ""}
  </div>`;
}
function qLink(id) {
	const t = taskById.get(id);
	if (!t) return esc(id);
	return `<a class="q-link cstate-${statusOf(t)}" href="${questUrl(id)}">${esc(t.name)}</a>`;
}
function depsHtml(t) {
	const lines = [];
	if (t.requires && t.requires.length) {
		const parts = t.requires.map((r) => {
			const s = (r.status || ["complete"])
				.map(
					(x) =>
						({ complete: "✔", active: "▶", failed: "✖" })[x] || x,
				)
				.join("");
			return `${qLink(r.task)} <span class="muted">[${s}]</span>`;
		});
		lines.push(
			`<div class="line"><b>Требует:</b> ${parts.join(", ")}</div>`,
		);
	}
	const u = unlocksMap.get(t.id) || [];
	if (u.length)
		lines.push(
			`<div class="line"><b>Открывает:</b> ${u.map(qLink).join(", ")}</div>`,
		);
	if (t.failedBy && t.failedBy.length)
		lines.push(
			`<div class="line warn"><b>⚠ Провалится</b> при выполнении: ${t.failedBy.map(qLink).join(", ")}</div>`,
		);
	const fc = failsOnComplete.get(t.id) || [];
	if (fc.length)
		lines.push(
			`<div class="line warn"><b>⚠ Выполнение провалит:</b> ${fc.map(qLink).join(", ")}</div>`,
		);
	lines.push(
		`<div class="line"><a href="${ruWiki(t.name)}" target="_blank" rel="noopener">Открыть на русской вики ↗</a></div>`,
	);
	return `<div class="deps">${lines.join("")}</div>`;
}
function questDetailHtml(t) {
	return `<div class="qdetail" data-detail="${t.id}">${t.objectives.map((o) => objHtml(o, t.name)).join("")}${depsHtml(t)}</div>`;
}

function onbResultsHtml() {
	const q = searchNorm(ui.onbQuery.trim());
	if (q.length < 2) return "";
	const res = data.tasks
		.filter((t) => searchNorm(t.name).includes(q))
		.slice(0, 12);
	if (!res.length)
		return '<div class="onb-r empty-note">Ничего не найдено</div>';
	return res
		.map(
			(t) =>
				`<div class="onb-r"><div><b>${esc(t.name)}</b> <span class="muted">${esc(traderName(t.trader))}${t.minLevel ? " · ур. " + t.minLevel : ""}</span></div><button class="btn-ghost" data-current="${t.id}">Добавить →</button></div>`,
		)
		.join("");
}
function onboardingHtml() {
	return `<div class="onboarding">
    <div class="onb-row">
      <div class="onb-text"><b>Добавить квест.</b> Найдите квест и добавьте его в «Мои квесты». Все предыдущие по ветке отметятся «Выполнен» автоматически.</div>
      <button class="btn-ghost danger" id="reset-progress">Сбросить весь прогресс</button>
    </div>
    <div class="onb-search">
      <input type="text" id="onb-input" placeholder="Найти квест (напр. «Оружейник. Часть 6»)…" value="${esc(ui.onbQuery)}" autocomplete="off" />
      <div class="onb-results" id="onb-results">${onbResultsHtml()}</div>
    </div>
  </div>`;
}
function renderQuests(scope) {
	const list = filteredTasks(scope);
	const cont = document.getElementById(
		scope === "mine" ? "view-mine" : "view-all",
	);
	// поле «Добавить квест» — над фильтрами (отдельная секция, только на «Мои квесты»)
	if (scope === "mine") {
		const aq = document.getElementById("addquest");
		if (aq) aq.innerHTML = onboardingHtml();
	}
	let html = `<div class="qtable">${headerHtml(list, scope)}`;
	if (!list.length) {
		html +=
			scope === "mine"
				? `<div class="loading">Список «Мои квесты» пуст.<br><br>Добавьте квест через поле <b>«Добавить квест»</b> сверху.<br>При выполнении квеста следующие по цепочке добавятся сюда автоматически.</div>`
				: `<div class="loading">Ничего не найдено. Измените фильтры.</div>`;
	} else {
		for (const t of list) {
			html += questRowHtml(t, scope);
			if (ui.expanded.has(t.id)) html += questDetailHtml(t);
		}
	}
	html += "</div>";
	cont.innerHTML = html;
}

// ---------- Planner -----------------------------------------------------
function aggregate(taskIds) {
	const locs = new Map();
	const handInItems = new Map(),
		handInCats = new Map(),
		handInChoices = [],
		builds = new Map();
	const locOf = (l) => {
		if (!locs.has(l))
			locs.set(l, { bring: new Map(), choices: [], quests: new Map() });
		return locs.get(l);
	};
	const addBring = (map, id, count, kind) => {
		const e = map.get(id) || { id, count: 0, kind };
		e.count = kind === "key" ? 1 : e.count + count;
		if (kind === "key" || kind === "weapon") e.kind = kind;
		map.set(id, e);
	};

	for (const tid of taskIds) {
		const t = taskById.get(tid);
		if (!t) continue;
		if (state.completed.has(tid) || failedAll.has(tid)) continue; // выполненные/проваленные не планируем
		const qHand = new Map(); // per-quest dedupe of handIn items (merge find+give -> max)
		for (const o of t.objectives) {
			const total = objTotal(o),
				rem = objRemaining(o);
			const objDoneFully = trackable(o) && rem === 0; // полностью выполнена
			const eff = (cnt) => (cnt === total ? rem : cnt); // уменьшаем только то, что масштабируется с прогрессом
			const em = effectiveMaps(o);
			const loc = em[0] || "none";
			const b = locOf(loc);
			// выполненную цель ОСТАВЛЯЕМ в списке задач (зачёркнутой), но не берём/сдаём её
			if (
				o.bring.length ||
				o.keys.length ||
				loc !== "none" ||
				o.handIn.length ||
				IN_RAID_TYPES.has(o.type) // безлокационные рейдовые цели (убить/выйти и т.п.) без предметов
			) {
				if (!b.quests.has(tid)) b.quests.set(tid, []);
				b.quests.get(tid).push(o);
			}
			if (objDoneFully) continue;
			o.bring.forEach((br, idx) => {
				if (br.anyOf) {
					const key = `${o.id}|b${idx}`;
					b.choices.push({
						key,
						kind: br.kind,
						options: br.anyOf,
						chosen: state.planChoices[key] || br.anyOf[0],
						count: eff(br.count || 1),
					});
				} else
					addBring(
						b.bring,
						br.item,
						eff(br.count || 1),
						br.kind || "plant",
					);
			});
			(o.keys || []).forEach((k, idx) => {
				if (typeof k === "object" && k.anyOf) {
					const key = `${o.id}|k${idx}`;
					b.choices.push({
						key,
						kind: "key",
						options: k.anyOf,
						chosen: state.planChoices[key] || k.anyOf[0],
						count: 1,
					});
				} else addBring(b.bring, k, 1, "key");
			});
			o.handIn.forEach((h, idx) => {
				if (h.kind === "build") {
					const e = builds.get(h.item) || { id: h.item, count: 0 };
					e.count += eff(h.count || 1);
					builds.set(h.item, e);
					return;
				}
				if (h.kind === "category") {
					const e = handInCats.get(h.category) || {
						label: h.category,
						count: 0,
						fir: h.fir,
					};
					e.count += eff(h.count || 1);
					e.fir = e.fir || h.fir;
					handInCats.set(h.category, e);
					return;
				}
				if (h.anyOf) {
					const key = `${o.id}|h${idx}`;
					handInChoices.push({
						key,
						options: h.anyOf,
						chosen: state.planChoices[key] || h.anyOf[0],
						count: eff(h.count || 1),
						fir: h.fir,
					});
					return;
				}
				if (h.item) {
					const c = eff(h.count || 1);
					const cur = qHand.get(h.item);
					if (!cur || c > cur.count)
						qHand.set(h.item, {
							count: c,
							fir: h.fir || (cur && cur.fir),
						});
				}
			});
		}
		for (const [id, info] of qHand) {
			const e = handInItems.get(id) || { id, count: 0, fir: info.fir };
			e.count += info.count;
			e.fir = e.fir || info.fir;
			handInItems.set(id, e);
		}
	}
	return { locs, handInItems, handInCats, handInChoices, builds };
}
// оставить в бакете только рейдовые цели (для слияния «без локации» в страницу локации)
function inRaidBucket(b) {
	if (!b) return null;
	const quests = new Map();
	for (const [tid, objs] of b.quests) {
		const kept = objs.filter((o) => IN_RAID_TYPES.has(o.type));
		if (kept.length) quests.set(tid, kept);
	}
	return { bring: b.bring, choices: b.choices, quests };
}
// объединить бакеты локаций (для показа квестов «без локации» на любой карте)
function combineBuckets(...bs) {
	const out = { bring: new Map(), choices: [], quests: new Map() };
	let any = false;
	for (const b of bs) {
		if (!b) continue;
		any = true;
		for (const [id, e] of b.bring) {
			const cur = out.bring.get(id);
			if (!cur) out.bring.set(id, { ...e });
			else cur.count = e.kind === "key" ? 1 : cur.count + e.count;
		}
		out.choices.push(...b.choices);
		for (const [tid, objs] of b.quests) {
			if (out.quests.has(tid)) out.quests.get(tid).push(...objs);
			else out.quests.set(tid, [...objs]);
		}
	}
	return any ? out : null;
}
function takeHtml(e) {
	const cntTxt =
		e.kind === "key" ? "" : `<span class="cnt">×${e.count}</span>`;
	const extra = e.kind === "key" ? "🔑 " : e.kind === "weapon" ? "🔫 " : "";
	return `<span class="take ${e.kind === "key" ? "key" : ""} ${e.kind === "weapon" ? "weapon" : ""}" title="${esc(itemName(e.id))}">${itImg(e.id)}<span>${extra}${esc(itemShort(e.id))}</span>${cntTxt}</span>`;
}
function handInItemHtml(e) {
	return `<span class="take handin" title="${esc(itemName(e.id))} — ${e.fir ? "найти в рейде и сдать" : "купить/найти и сдать"}">${itImg(e.id)}<span>${esc(itemShort(e.id))}</span><span class="cnt">×${e.count}</span></span>`;
}
function choiceHtml(c, sectionFir) {
	const opts = c.options
		.map(
			(id) =>
				`<option value="${id}" ${id === c.chosen ? "selected" : ""}>${esc(itemShort(id))}</option>`,
		)
		.join("");
	const label =
		c.kind === "key"
			? "🔑 ключ (одно из)"
			: c.kind === "weapon"
				? "🔫 оружие (одно из)"
				: "одно из";
	return `<span class="take ${c.kind === "key" ? "key" : ""} ${c.kind === "weapon" ? "weapon" : ""} ${sectionFir !== undefined ? "handin" : ""}">
    <span class="muted" style="font-size:11px">${label}:</span>
    <select data-choice="${c.key}">${opts}</select><span class="cnt">×${c.count}</span>${sectionFir !== undefined ? `<span class="firlbl">${c.fir ? "FiR" : "куп."}</span>` : ""}</span>`;
}

// Строки списка находок (все группы, у каждого — пометка группы). Используется в нескольких местах.
function findingsRowsHtml() {
	const rows = [];
	for (const g of state.findGroups) {
		for (const it of g.items) {
			const ci = catItem(it.id);
			const ic = ci.icon || ci.img;
			const img = ic
				? `<img src="${ic}" data-item="${it.id}" data-itemimg="${ci.img || ci.icon || ""}" onerror="this.style.display='none'">`
				: "";
			rows.push(
				`<li class="${it.found ? "found" : ""}">${img}<span class="nm">${esc(ci.name)}</span><span class="cnt">×${it.qty || 1}</span><span class="fg-tag" title="Для группы «${esc(g.name)}»">${esc(g.name)}</span></li>`,
			);
		}
	}
	return rows;
}
// Один блок: все предметы из всех групп находок, у каждого — пометка, для какой группы.
function findingsBlockHtml() {
	const rows = findingsRowsHtml();
	if (!rows.length) return "";
	return `<div class="summary-card findings-card">
    <h3>Список находок</h3>
    <div class="empty-note" style="margin:-4px 0 8px">найти в любых рейдах — из вкладки «Список находок»</div>
    <ul class="fg-items">${rows.join("")}</ul>
  </div>`;
}

// Свитч показа/скрытия блока
const blkSwitch = (k, on) =>
	`<label class="switch" title="Показать / скрыть"><input type="checkbox" data-toggle="${k}" ${on ? "checked" : ""}><span class="sw"></span></label>`;

// Один общий список «найти в рейде»: предметы квестов с пометкой «найти в рейде» (из ВСЕХ активных
// задач — их находишь в любом рейде, поэтому показываем на каждой локации) + предметы «Список находок».
function findInRaidRows(mapId) {
	const rows = [];
	const byItem = new Map(); // id предмета -> { count, quests:Set }
	const byText = new Map(); // категория/название без id -> { count, quests:Set, cat:bool }

	// собрать цели поиска из квеста (обычного или сюжетного) на этой локации
	function consume(qname, objectives, isStory) {
		const pqItem = new Map(),
			pqText = new Map();
		for (const o of objectives) {
			if (isStory) {
				if (state.storyDone.has(o.id)) continue;
			} else {
				if (trackable(o) && objRemaining(o) === 0 && objDone(o.id) > 0)
					continue;
				// обычные квесты: только объективы, где предмет ИЩЕТСЯ (не «сдать предмет»)
				const isFind =
					o.type === "findItem" ||
					o.type === "findQuestItem" ||
					o.type === "giveItem";
				if (!isFind) continue;
			}
			const em = isStory ? o.maps || [] : effectiveMaps(o);
			const anywhere = em.length === 0;
			if (!anywhere && !em.includes(mapId)) continue; // на этой локации не добыть
			for (const h of o.handIn || []) {
				const fir = !!(h.fir || h.kind === "find"); // FiR — обязательно найти в рейде
				const cnt = h.count || 1;
				// именованный предмет пробуем разрешить в реальный id (тогда будет настоящая иконка)
				let iid = h.item;
				if (!iid && h.name) iid = itemByName.get(h.name.toLowerCase());
				if (iid) {
					const cur = pqItem.get(iid);
					pqItem.set(iid, {
						count: Math.max(cur ? cur.count : 0, cnt),
						fir: (cur ? cur.fir : false) || fir,
					});
				} else {
					const txt = h.category || h.name;
					if (!txt) continue;
					const cur = pqText.get(txt);
					pqText.set(txt, {
						count: Math.max(cur ? cur.count : 0, cnt),
						cat: !!h.category,
						fir: (cur ? cur.fir : false) || fir,
					});
				}
			}
		}
		for (const [iid, v] of pqItem) {
			const e = byItem.get(iid) || { count: 0, quests: new Set(), fir: false };
			e.count += v.count;
			e.quests.add(qname);
			e.fir = e.fir || v.fir;
			byItem.set(iid, e);
		}
		for (const [txt, v] of pqText) {
			const e = byText.get(txt) || {
				count: 0,
				quests: new Set(),
				cat: v.cat,
				fir: false,
			};
			e.count += v.count;
			e.quests.add(qname);
			e.fir = e.fir || v.fir;
			byText.set(txt, e);
		}
	}

	for (const id of state.active) {
		if (state.completed.has(id) || failedAll.has(id)) continue; // выполненные/проваленные не показываем
		const t = taskById.get(id);
		if (t) consume(t.name, t.objectives, false);
	}
	// сюжетные квесты (начатые, текущая стадия)
	for (const q of (storyData && storyData.quests) || []) {
		if (!(q.autostart || state.storyStarted.has(q.id))) continue;
		consume(q.name, storyActiveObjectives(q), true);
	}

	const tagHtml = (qn) =>
		`<span class="fg-tag quest" title="Для квеста: ${esc(qn.join(", "))}">${esc(qn.length === 1 ? qn[0] : qn.length + " квеста")}</span>`;
	const firBadge = (fir) =>
		fir
			? ` <span class="firlbl" title="Только найдено в рейде">FiR</span>`
			: "";
	// чек-лист «нашёл в рейде»: +/− у предмета (state.found по ключу)
	const lootStep = (key, need) => {
		const f = Math.min(state.found[key] || 0, need);
		return `<span class="loot-step" data-loot="${esc(key)}" data-need="${need}"><button class="st-btn" data-d="-1" title="убавить">−</button><b class="lv">${f}</b><span class="lt">/ ${need}</span><button class="st-btn" data-d="1" title="нашёл в рейде">+</button></span>`;
	};
	const lootDone = (key, need) => (state.found[key] || 0) >= need;
	for (const [id, e] of byItem) {
		const it = itemById.get(id) || {};
		const ic = it.icon || it.img;
		const img = ic
			? `<img src="${ic}" data-item="${id}" data-itemimg="${it.img || it.icon || ""}" onerror="this.style.display='none'">`
			: "";
		const key = "i:" + id;
		rows.push(
			`<li class="${lootDone(key, e.count) ? "loot-found" : ""}">${img}<span class="nm">${esc(itemName(id))}</span>${firBadge(e.fir)}${lootStep(key, e.count)}${tagHtml([...e.quests])}</li>`,
		);
	}
	for (const [txt, e] of byText) {
		const key = "t:" + txt;
		rows.push(
			`<li class="cat-row ${lootDone(key, e.count) ? "loot-found" : ""}"><span class="cat-ico" title="${e.cat ? "категория предметов" : "предмет"}">${catEmoji(txt, e.cat)}</span><span class="nm">${esc(txt)}</span>${firBadge(e.fir)}${lootStep(key, e.count)}${tagHtml([...e.quests])}</li>`,
		);
	}
	// предметы из вкладки «Список находок»
	rows.push(...findingsRowsHtml());
	return rows;
}
// Отдельная карточка под основной (в боковой панели локации)
function findingsLocCard(mapId) {
	const rows = findInRaidRows(mapId);
	if (!rows.length) return "";
	return `<div class="loc-card findings-loc-card" data-blk="findings"><div class="loc-body">
      <div class="le-head"><div class="sec-label">Найти в рейде</div>${blkSwitch("findings", ui.showFindings)}</div>
      <div class="le-body"${ui.showFindings ? "" : " hidden"}>
        <div class="empty-note" style="margin:0 0 8px">предметы для квестов + ваш «Список находок»</div>
        <ul class="fg-items">${rows.join("")}</ul>
      </div></div></div>`;
}
// Тот же список в углу полноэкранной карты
function findingsCornerBlock(mapId) {
	const rows = findInRaidRows(mapId);
	if (!rows.length) return "";
	return `<div class="loc-extra" data-blk="findings">
      <div class="le-head"><span class="sec-label">Найти в рейде</span>${blkSwitch("findings", ui.showFindings)}</div>
      <div class="le-body"${ui.showFindings ? "" : " hidden"}><ul class="fg-items">${rows.join("")}</ul></div>
    </div>`;
}
// блок сюжетных задач текущей стадии на этой локации (без точек на карте — у них нет координат)
function storyLocBlock(mapId) {
	const tasks = storyTasksForMap(mapId);
	if (!tasks.length) return "";
	return `<div class="obj-by-quest story-loc"><div class="sec-label">Сюжетные задачи</div><ul class="ol">${tasks
		.map(
			({ q, o }) =>
				`<li><span class="li-txt"><span class="a" style="color:var(--gold)">${esc(q.name)}</span> — <b>${esc(o.action)}:</b> ${esc(o.desc)}${o.fir ? ' <span class="firlbl">FiR</span>' : ""}</span></li>`,
		)
		.join("")}</ul></div>`;
}

// случайный, но стабильный и контрастный цвет для квеста
function questColor(id) {
	let h = 0;
	for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
	return `hsl(${h} 68% 62%)`;
}
// русское имя локации -> slug интерактивной карты tarkov.dev
const MAP_SLUG = {
	Завод: "factory",
	Таможня: "customs",
	Лес: "woods",
	Маяк: "lighthouse",
	Берег: "shoreline",
	Резерв: "reserve",
	Развязка: "interchange",
	"Улицы Таркова": "streets-of-tarkov",
	Лаборатория: "the-lab",
	Эпицентр: "ground-zero",
	Лабиринт: "the-labyrinth",
	Ледокол: "icebreaker",
};
const mapSlug = (id) => MAP_SLUG[mapName(id)] || null;

// гео-конфиг карт (SVG + трансформация координат), грузится лениво
let mapsGeo = null;
async function loadMapsGeo() {
	if (mapsGeo) return mapsGeo;
	try {
		const r = await fetch("data/maps-geo.json", { cache: "no-cache" });
		if (r.ok) {
			mapsGeo = await r.json();
			return mapsGeo;
		}
	} catch {}
	if (window.__MAPSGEO__) {
		mapsGeo = window.__MAPSGEO__;
		return mapsGeo;
	}
	try {
		await injectScript("data/maps-geo.js");
		mapsGeo = window.__MAPSGEO__ || {};
	} catch {
		mapsGeo = {};
	}
	return mapsGeo;
}
const geoFor = (mapId) => (mapsGeo && mapsGeo[mapSlug(mapId)]) || null;
// карты, у которых есть гео, но нет квестов (их нет в data.maps) — добавляем как просматриваемые
const GEO_ONLY_NAME = { terminal: "Терминал" };
function addGeoOnlyMaps() {
	if (!mapsGeo) return;
	const covered = new Set(
		data.maps.map((m) => mapSlug(m.id)).filter(Boolean),
	);
	for (const slug of Object.keys(mapsGeo)) {
		if (covered.has(slug) || !GEO_ONLY_NAME[slug]) continue;
		const name = GEO_ONLY_NAME[slug],
			id = "map_geo_" + slug,
			m = { id, name };
		data.maps.push(m);
		mapById.set(id, m);
		mapIdByName.set(name, id);
		MAP_SLUG[name] = slug;
	}
}
// inline-SVG карты (чтобы при зуме оставалась векторно-чёткой)
const svgCache = {};
async function loadSvg(url) {
	if (url in svgCache) return svgCache[url];
	try {
		const r = await fetch(url, { cache: "force-cache" });
		svgCache[url] = r.ok ? await r.text() : "";
	} catch {
		svgCache[url] = "";
	}
	return svgCache[url];
}
// игровые координаты {x,z} -> доля {left,top} на SVG-карте (формула из getCRS tarkov.dev)
function geoFrac(x, z, g) {
	const rot = (px, pz) => {
		const a = ((g.rotation || 0) * Math.PI) / 180,
			c = Math.cos(a),
			s = Math.sin(a);
		return [px * c - pz * s, px * s + pz * c];
	};
	const lp = (px, pz) => {
		const [rx, ry] = rot(px, pz);
		return [g.sx * rx, g.sy * ry];
	};
	const [mx, my] = lp(x, z);
	const [a0x, a0y] = lp(g.bounds[0][0], g.bounds[0][1]);
	const [a1x, a1y] = lp(g.bounds[1][0], g.bounds[1][1]);
	const minx = Math.min(a0x, a1x),
		maxx = Math.max(a0x, a1x),
		miny = Math.min(a0y, a1y),
		maxy = Math.max(a0y, a1y);
	return {
		left: ((mx - minx) / (maxx - minx)) * 100,
		top: ((my - miny) / (maxy - miny)) * 100,
	};
}
// маркер реально попадает на карту? отсекаем битые координаты вне поля
// (напр. у Терминала спавны tarkov.dev не совпадают с bounds карты)
const onMap = (f) =>
	isFinite(f.left) &&
	isFinite(f.top) &&
	f.left >= -5 &&
	f.left <= 105 &&
	f.top >= -5 &&
	f.top <= 105;
// определить этаж (svgLayer) по координате цели; иначе земля
function assignFloor(x, z, y, geo) {
	if (!geo || !geo.floors) return null;
	let best = geo.floors[0],
		bestIdx = 0;
	for (const floor in geo.extents || {}) {
		const idx = geo.floors.indexOf(floor);
		if (idx <= bestIdx) continue;
		for (const r of geo.extents[floor]) {
			const [x1, z1, x2, z2, hmin, hmax] = r;
			if (
				x >= Math.min(x1, x2) &&
				x <= Math.max(x1, x2) &&
				z >= Math.min(z1, z2) &&
				z <= Math.max(z1, z2) &&
				y >= hmin &&
				y <= hmax
			) {
				best = floor;
				bestIdx = idx;
				break;
			}
		}
	}
	return best;
}
// строка задачи (li) с зачёркиванием выполненной, ссылкой на вики и контролом прогресса
function objLiHtml(o, qname) {
	const isDone = trackable(o) && objRemaining(o) === 0 && objDone(o.id) > 0;
	const ctrl = trackControlHtml(o);
	return `<li class="${isDone ? "li-done" : ""}" data-li-obj="${o.id}">${ctrl ? `<span class="li-ctrl">${ctrl}</span>` : ""}<span class="li-txt"><span class="a">${esc(o.action)}:</span> ${esc(o.description)} ${wikiLink(qname)}</span></li>`;
}
// локации с активными квестами
function activeLocations() {
	const s = new Set();
	for (const tid of state.active) {
		if (state.completed.has(tid) || failedAll.has(tid)) continue;
		const t = taskById.get(tid);
		if (!t) continue;
		for (const o of t.objectives) for (const m of o.maps) s.add(m);
	}
	return s;
}
// локации для под-вкладок: все карты с гео + те, где есть активные квесты (карта показывается всегда)
function plannerLocations() {
	const act = activeLocations();
	const s = new Set(act);
	for (const m of data.maps) if (geoFor(m.id)) s.add(m.id);
	return [...s].sort((a, b) => mapName(a).localeCompare(mapName(b), "ru"));
}
function plannerSubnav() {
	const act = activeLocations();
	const link = (tab, label, color, dot) =>
		`<a class="psub ${ui.plannerTab === tab ? "active" : ""}" href="${tab === "plan" ? "planner.html" : "planner.html?loc=" + encodeURIComponent(tab)}" ${color ? `style="--c:${color}"` : ""}>${esc(label)}${dot ? ' <span class="psub-dot"></span>' : ""}</a>`;
	return `<div class="planner-subnav">${link("plan", "Мой план")}${plannerLocations()
		.map((m) => link(m, mapName(m), mapColor(m), act.has(m)))
		.join("")}</div>`;
}

function renderPlanner() {
	const root = document.getElementById("view-planner");
	// под-вкладка по локации
	if (ui.plannerTab && ui.plannerTab !== "plan") {
		if (!plannerLocations().includes(ui.plannerTab)) ui.plannerTab = "plan";
		else {
			if (!mapsGeo) {
				loadMapsGeo().then(() => {
					if (ui.view === "planner") renderPlanner();
				});
			}
			root.innerHTML =
				plannerSubnav() + plannerLocationHtml(ui.plannerTab);
			initMap();
			return;
		}
	}
	const findings = findingsBlockHtml();
	const refreshCat = () => {
		if (state.findGroups.length && !catalog)
			loadCatalog().then(() => {
				if (ui.view === "planner") renderPlanner();
			});
	};
	// выбор карты + "Показать карту" (открывает локацию на весь экран)
	const plocs = plannerLocations();
	const actCount = {};
	for (const tid of state.active) {
		const t = taskById.get(tid);
		if (!t) continue;
		const s = new Set();
		for (const o of t.objectives) for (const m of o.maps) s.add(m);
		for (const m of s) actCount[m] = (actCount[m] || 0) + 1;
	}
	const mapPicker = plocs.length
		? `<select id="map-pick" class="map-pick">${plocs.map((m) => `<option value="${m}">${esc(mapName(m))}${actCount[m] ? ` (${actCount[m]} кв.)` : ""}</option>`).join("")}</select><button class="btn-ghost" id="map-show">Показать карту</button>`
		: "";
	if (!state.plan.size) {
		root.innerHTML =
			plannerSubnav() +
			`<div class="page-head"><h2>Мой план</h2><span class="ph-sub">отметьте квесты галочкой ⚑</span><div class="ph-actions">${mapPicker}</div></div>
      <div class="plan-cols"><div><div class="planner-empty">План пуст.<br><br>Отметьте квесты галочкой <b>⚑</b> во вкладках «Мои квесты» / «Все квесты» — или используйте вкладки локаций выше / выбор карты, куда автоматически попадают все ваши квесты.</div></div><div class="plan-right">${findings}</div></div>`;
		refreshCat();
		return;
	}
	const agg = aggregate(state.plan);
	const order = [...agg.locs.keys()]
		.filter((k) => k !== "none")
		.sort((a, b) => mapName(a).localeCompare(mapName(b), "ru"));
	if (agg.locs.has("none")) order.push("none");

	const bringTotals = new Map();
	for (const [, b] of agg.locs) {
		for (const e of b.bring.values()) {
			const x = bringTotals.get(e.id) || {
				id: e.id,
				count: 0,
				kind: e.kind,
			};
			x.count = e.kind === "key" ? 1 : x.count + e.count;
			if (e.kind === "key" || e.kind === "weapon") x.kind = e.kind;
			bringTotals.set(e.id, x);
		}
		for (const c of b.choices) {
			const x = bringTotals.get(c.chosen) || {
				id: c.chosen,
				count: 0,
				kind: c.kind,
			};
			x.count = c.kind === "key" ? 1 : x.count + c.count;
			if (c.kind === "key" || c.kind === "weapon") x.kind = c.kind;
			bringTotals.set(c.chosen, x);
		}
	}

	let cards = "";
	for (const loc of order) {
		const b = agg.locs.get(loc);
		const color = loc === "none" ? "#666" : mapColor(loc);
		const title = loc === "none" ? "Без привязки к локации" : mapName(loc);
		const takes =
			[...b.bring.values()].map(takeHtml).join("") +
			b.choices.map((c) => choiceHtml(c)).join("");
		const groups = [...b.quests.entries()]
			.map(([tid, objs]) => {
				const t = taskById.get(tid);
				const lis = objs.map((o) => objLiHtml(o, t.name)).join("");
				return `<div class="qg"><div class="qt">${esc(t.name)}</div><ul class="ol">${lis}</ul></div>`;
			})
			.join("");
		cards += `<div class="loc-card">
      <h3 style="border-left-color:${color}">${esc(title)} <span class="n">${b.quests.size} квест(ов)</span></h3>
      <div class="loc-body">
        <div class="sec-label">Взять с собой / заложить</div>
        ${takes ? `<div class="take-list">${takes}</div>` : '<div class="empty-note">Ничего закладывать не нужно.</div>'}
        <div class="obj-by-quest"><div class="sec-label">Задачи на локации</div>${groups}</div>
      </div>
    </div>`;
	}

	const bringList =
		[...bringTotals.values()]
			.sort((a, b) => b.count - a.count)
			.map(takeHtml)
			.join("") || '<span class="empty-note">—</span>';

	// разделяем "сдать": что можно купить/найти на барахолке vs только из рейда (FiR)
	const buyParts = [],
		firParts = [];
	for (const e of [...agg.handInItems.values()].sort(
		(a, b) => b.count - a.count,
	))
		(e.fir ? firParts : buyParts).push(handInItemHtml(e));
	for (const c of agg.handInChoices)
		(c.fir ? firParts : buyParts).push(choiceHtml(c, c.fir));
	for (const e of agg.handInCats.values())
		(e.fir ? firParts : buyParts).push(
			`<span class="take cat" title="${esc(e.label)}">📋 <span>${esc(e.label)}</span><span class="cnt">×${e.count}</span></span>`,
		);
	for (const e of agg.builds.values())
		buyParts.push(
			`<span class="take build" title="Собрать и сдать">🔧 <span>${esc(itemShort(e.id))}</span><span class="cnt">×${e.count}</span></span>`,
		);
	const handSection =
		buyParts.length || firParts.length
			? `${buyParts.length ? `<div class="sub-h find">Купить / найти и сдать</div><div class="take-list">${buyParts.join("")}</div>` : ""}${firParts.length ? `<div class="sub-h find">Только из рейда (FiR) и сдать</div><div class="take-list">${firParts.join("")}</div>` : ""}`
			: `<div class="sub-h find">Найти / купить и сдать</div><div class="take-list"><span class="empty-note">—</span></div>`;

	const planList = [...state.plan]
		.map((tid) => {
			const t = taskById.get(tid);
			if (!t) return "";
			const locs = t.maps.map(mapName).join(", ") || "—";
			return `<li><a class="ql" href="${questUrl(tid)}">${esc(t.name)}</a> <span class="loc">${esc(locs)}</span><span class="rm" data-rm="${tid}" title="Убрать из плана">✕</span></li>`;
		})
		.join("");

	root.innerHTML =
		plannerSubnav() +
		`
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

const extractColor = (f) =>
	f === "pmc" ? "#5b8fc9" : f === "scav" ? "#d08a3e" : "#6fae54";
const factionRu = (f) =>
	f === "pmc" ? "ЧВК" : f === "scav" ? "Дикий" : "Общий";
const FLOOR_RU = {
	Ground_Level: "Земля",
	Ground_Floor: "Земля",
	Underground_Level: "Подвал",
	Basement: "Подвал",
	First_Floor: "1 этаж",
	Second_Floor: "2 этаж",
	Third_Floor: "3 этаж",
	Fourth_Floor: "4 этаж",
	Fifth_Floor: "5 этаж",
	Bunkers: "Бункеры",
	Tunnels: "Тоннели",
	Technical_Level: "Тех. уровень",
	First_Level: "1 уровень",
	Second_Level: "2 уровень",
};

// под-вкладка локации: карта (всегда, если есть гео) + квесты/выходы/боссы
function plannerLocationHtml(mapId) {
	const agg = aggregate(state.active);
	// квесты этой локации + рейдовые цели квестов без привязки к карте (их можно выполнить где угодно;
	// «Сдать» торговцу и прочее не-рейдовое для безлокационных квестов не показываем)
	const b = combineBuckets(
		agg.locs.get(mapId),
		inRaidBucket(agg.locs.get("none")),
	);
	const geo = geoFor(mapId);
	const slug = mapSlug(mapId);
	const mapLink = slug
		? `<a class="btn-ghost" href="https://tarkov.dev/map/${slug}" target="_blank" rel="noopener">tarkov.dev ↗</a>`
		: "";

	const pins = [],
		noCoord = [],
		questGroups = [];
	if (b)
		for (const [tid, objs] of b.quests) {
			const t = taskById.get(tid),
				col = questColor(tid);
			for (const o of objs) {
				if (trackable(o) && objRemaining(o) === 0 && objDone(o.id) > 0)
					continue;
				const cs = (o.coords || []).filter((c) => c.m === mapId);
				if (geo && cs.length) {
					for (const c of cs) {
						const f = geoFrac(c.x, c.z, geo);
						if (onMap(f)) {
							const fl = geo.floors
								? assignFloor(c.x, c.z, c.y || 0, geo)
								: "";
							pins.push(
								`<div class="pin-dot" style="left:${f.left.toFixed(2)}%;top:${f.top.toFixed(2)}%;--c:${col}" data-pinobj="${o.id}" data-quest="${tid}"${fl ? ` data-floor="${fl}"` : ""} title="${esc(t.name)} — ${esc(o.action)}: ${esc(o.description)}"></div>`,
							);
						}
					}
				} else if (!geo)
					noCoord.push(
						`<div class="marker" style="--c:${col}"><span class="pin"></span><div class="m-body"><div class="m-q">${esc(t.name)}</div><div class="m-txt"><b>${esc(o.action)}:</b> ${esc(o.description)}</div></div><span class="m-track">${trackControlHtml(o)}</span></div>`,
					);
			}
			const anyLoc = t.maps.length === 0;
			questGroups.push(
				`<div class="qg" data-quest="${tid}"><div class="qt" style="color:${col}">${esc(t.name)}${anyLoc ? ' <span class="anyloc-tag" title="Без привязки к локации — можно выполнить на любой карте">любая локация</span>' : ""}</div><ul class="ol">${objs.map((o) => objLiHtml(o, t.name)).join("")}</ul></div>`,
			);
		}
	const exPins = geo
		? (geo.extracts || [])
				.map((e) => {
					const f = geoFrac(e.x, e.z, geo);
					return onMap(f)
						? `<div class="mk mk-ex" style="left:${f.left.toFixed(2)}%;top:${f.top.toFixed(2)}%;--c:${extractColor(e.faction)}" title="Выход (${factionRu(e.faction)}): ${esc(e.name)}"><i class="mk-ico"></i><span class="mk-name">${esc(e.name)}</span></div>`
						: "";
				})
				.join("")
		: "";
	const bossPins = geo
		? (geo.bossSpawns || [])
				.map((s) => {
					const f = geoFrac(s.x, s.z, geo);
					return onMap(f)
						? `<div class="mk mk-boss" style="left:${f.left.toFixed(2)}%;top:${f.top.toFixed(2)}%" title="Спавн босса: ${esc((s.bosses || []).join(", "))}"><i class="mk-ico"></i><span class="mk-name">${esc((s.bosses || []).join(", "))}</span></div>`
						: "";
				})
				.join("")
		: "";
	const bossLegend =
		geo && geo.bosses && geo.bosses.length
			? `<div class="boss-legend">☠ Боссы: ${geo.bosses.map((x) => `${esc(x.name)} <span class="muted">${x.chance}%</span>`).join(" · ")}</div>`
			: "";

	const cornerPanel = `<div class="map-quests"><div class="mq-head">Текущие задачи</div>${questGroups.join("") || '<div class="empty-note">Нет активных задач на этой локации.</div>'}${storyLocBlock(mapId)}${findingsCornerBlock(mapId)}</div>`;
	const lyr = (k, label) =>
		`<label><input type="checkbox" data-layer="${k}" ${ui.mapLayers[k] ? "checked" : ""}> ${label}</label>`;
	const mapPanel = geo
		? `<div class="map-view ${ui.mapFullscreen ? "fs" : ""}">
      <div class="map-zoom">
        <button data-mz="+" title="Приблизить">+</button>
        <button data-mz="-" title="Отдалить">−</button>
        <button data-mz="fit" title="${ui.mapFullscreen ? "Свернуть карту" : "Развернуть карту"}">${ui.mapFullscreen ? "✕" : "⤢"}</button>
        <button data-mz="fs" title="Во весь экран">⛶</button>
      </div>
      <div class="map-layers">${lyr("quests", "Квесты (" + pins.length + ")")}${lyr("extracts", "Выходы")}${lyr("bosses", "Боссы")}</div>
      ${
			geo.floors
				? `<div class="map-floors">${geo.floors
						.filter((fl) => !(geo.base || []).includes(fl))
						.map(
							(fl) =>
								`<button data-floor="${fl}" class="${(ui.mapFloor || geo.floors[0]) === fl ? "active" : ""}">${esc((geo.floorNames && geo.floorNames[fl]) || FLOOR_RU[fl] || fl)}</button>`,
						)
						.join("")}</div>`
				: ""
		}
      <div class="map-canvas" id="map-canvas"><div class="map-inner" id="map-inner">
        <div class="map-svg" id="map-svg"></div>
        <div class="layer-quests" ${ui.mapLayers.quests ? "" : "hidden"}>${pins.join("")}</div>
        <div class="layer-extracts" ${ui.mapLayers.extracts ? "" : "hidden"}>${exPins}</div>
        <div class="layer-bosses" ${ui.mapLayers.bosses ? "" : "hidden"}>${bossPins}</div>
      </div></div>
      ${cornerPanel}
    </div>`
		: `<div class="empty-note" style="margin:8px 0">Векторная карта для этой локации недоступна. ${mapLink || ""}</div>`;

	const takes = b
		? [...b.bring.values()].map(takeHtml).join("") +
			b.choices.map((c) => choiceHtml(c)).join("")
		: "";
	return `
    <div class="page-head"><h2 style="color:${geo ? mapColor(mapId) : "var(--gold)"}">${esc(mapName(mapId))}</h2><span class="ph-sub">${b ? b.quests.size : 0} квест(ов) · ${pins.length} маркер(ов) задач</span><div class="ph-actions">${mapLink}</div></div>
    ${bossLegend}
    <div class="loc-layout">
      <div class="loc-board-wrap">
        ${mapPanel}
        ${noCoord.length ? `<div class="sec-label" style="margin-top:12px">Задачи без точки на карте</div><div class="marker-board">${noCoord.join("")}</div>` : ""}
      </div>
      <aside class="loc-side">
        <div class="loc-card"><div class="loc-body">
          <div class="sec-label">Взять с собой / заложить</div>
          ${takes ? `<div class="take-list">${takes}</div>` : '<div class="empty-note">Ничего закладывать не нужно.</div>'}
          <div class="obj-by-quest"><div class="sec-label">Задачи <span class="muted" style="font-weight:400">— отметьте выполнение, маркер скроется</span></div>${questGroups.join("") || '<div class="empty-note">Нет активных задач.</div>'}</div>
          ${storyLocBlock(mapId)}
        </div></div>
        ${findingsLocCard(mapId)}
      </aside>
    </div>`;
}

// инициализация интерактива карты (inline-SVG, зум по ширине = вектор чёткий)
function initMap() {
	const canvas = document.getElementById("map-canvas"),
		inner = document.getElementById("map-inner"),
		holder = document.getElementById("map-svg");
	if (!canvas || !inner || !holder) return;
	const geo = geoFor(ui.plannerTab);
	let aspect = 2;
	// z — масштаб относительно ширины канваса: ширина карты = clientWidth * z (вектор перерисовывается чётко)
	const apply = () => {
		const cw = canvas.clientWidth;
		inner.style.width = cw * ui.map.z + "px";
		inner.style.transform = `translate(${ui.map.x}px, ${ui.map.y}px)`;
	};
	const fit = () => {
		const svg = holder.querySelector("svg");
		if (svg) {
			const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/);
			if (+vb[2] && +vb[3]) aspect = +vb[2] / +vb[3];
		}
		const cw = canvas.clientWidth,
			ch = canvas.clientHeight;
		if (!cw || !ch) return;
		const z = Math.min(1, (ch * aspect) / cw);
		ui.map = { z, x: (cw - cw * z) / 2, y: (ch - (cw * z) / aspect) / 2 };
		apply();
	};
	const clampZoom = (z) => Math.max(0.1, Math.min(8, z));
	const zoomAt = (cx, cy, nz) => {
		nz = clampZoom(nz);
		const z = ui.map.z;
		const wx = (cx - ui.map.x) / z,
			wy = (cy - ui.map.y) / z;
		ui.map.x = cx - wx * nz;
		ui.map.y = cy - wy * nz;
		ui.map.z = nz;
		apply();
	};
	const applyFloor = () => {
		if (!geo || !geo.floors) return;
		const svg = holder.querySelector("svg");
		if (!svg) return;
		const ground = geo.floors[0],
			sel = ui.mapFloor || ground,
			onGround = sel === ground;
		// «база» — слои, которые показываются вместе с землёй (напр. First_Floor на Таможне);
		// для карт типа Развязки First_Floor — отдельный выбираемый этаж, в базу не входит
		const baseSet = new Set([ground, ...(geo.base || [])]);
		const isBase = (id) => baseSet.has(id);
		// затемняем ВСЕ группы SVG, кроме выбранного этажа (+ база на земле), чтобы ничего не оставалось ярким
		for (const g of svg.children) {
			if ((g.tagName || "").toLowerCase() !== "g") continue;
			const id = g.id;
			let op;
			if (id === sel || (onGround && isBase(id)))
				op = 1; // выбранный этаж / база на земле
			else if (isBase(id))
				op = 0.25; // база при выбранном этаже — затемнена
			else op = onGround ? 0.12 : 0.05; // прочие этажи — почти не видно
			g.style.display = "";
			g.style.opacity = String(op);
		}
		// квест-маркеры: яркие на своём этаже (и базовые — на земле), иначе затемнены
		inner.querySelectorAll(".pin-dot[data-floor]").forEach((p) => {
			const pf = p.dataset.floor;
			p.style.opacity =
				pf === sel || (onGround && isBase(pf)) ? "1" : "0.22";
		});
	};
	const ready = () => {
		const svg = holder.querySelector("svg");
		if (svg) {
			svg.removeAttribute("width");
			svg.removeAttribute("height");
			svg.style.width = "100%";
			svg.style.height = "auto";
			svg.style.display = "block";
			const vb = (svg.getAttribute("viewBox") || "0 0 2 1").split(
				/[\s,]+/,
			);
			aspect = +vb[2] / +vb[3] || 2;
		}
		applyFloor();
		if (ui.map.z === 0) fit();
		else apply();
	};
	const mapView = canvas.closest(".map-view");
	mapView.querySelectorAll(".map-floors button").forEach((bt) =>
		bt.addEventListener("click", (e) => {
			e.stopPropagation();
			ui.mapFloor = bt.dataset.floor;
			mapView
				.querySelectorAll(".map-floors button")
				.forEach((b) => b.classList.toggle("active", b === bt));
			applyFloor();
		}),
	);
	// вставляем inline-SVG (из кэша синхронно, иначе грузим)
	const url = geo && geo.svg;
	if (url && url in svgCache) {
		holder.innerHTML = svgCache[url];
		ready();
	} else if (url) {
		holder.innerHTML = '<div class="map-loading">загрузка карты…</div>';
		loadSvg(url).then((t) => {
			if (document.getElementById("map-svg") === holder) {
				holder.innerHTML =
					t || '<div class="map-loading">карта недоступна</div>';
				ready();
			}
		});
	}

	canvas.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			const r = canvas.getBoundingClientRect();
			zoomAt(
				e.clientX - r.left,
				e.clientY - r.top,
				ui.map.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2),
			);
		},
		{ passive: false },
	);
	let drag = null;
	canvas.addEventListener("pointerdown", (e) => {
		if (e.target.closest(".pin-dot")) return;
		drag = { x: e.clientX - ui.map.x, y: e.clientY - ui.map.y };
		canvas.setPointerCapture(e.pointerId);
		canvas.classList.add("dragging");
	});
	canvas.addEventListener("pointermove", (e) => {
		if (!drag) return;
		ui.map.x = e.clientX - drag.x;
		ui.map.y = e.clientY - drag.y;
		apply();
	});
	const end = () => {
		drag = null;
		canvas.classList.remove("dragging");
	};
	canvas.addEventListener("pointerup", end);
	canvas.addEventListener("pointercancel", end);
	canvas
		.closest(".map-view")
		.querySelectorAll(".map-zoom button")
		.forEach((bt) =>
			bt.addEventListener("click", (e) => {
				e.stopPropagation();
				const m = bt.dataset.mz;
				// ⤢ — развернуть/свернуть карту на всю страницу (в пределах вкладки браузера)
				if (m === "fit") {
					ui.mapFullscreen = !ui.mapFullscreen;
					ui.map.z = 0;
					if (!ui.mapFullscreen && document.fullscreenElement)
						document.exitFullscreen().catch(() => {});
					renderPlanner();
					return;
				}
				// ⛶ — настоящий полный экран через Fullscreen API
				if (m === "fs") {
					if (document.fullscreenElement) {
						document.exitFullscreen().catch(() => {});
						return;
					}
					if (!ui.mapFullscreen) {
						ui.mapFullscreen = true;
						ui.map.z = 0;
						renderPlanner();
					}
					const mv = document.querySelector(
						"#view-planner .map-view",
					);
					if (mv && mv.requestFullscreen)
						mv.requestFullscreen().catch(() => {});
					return;
				}
				const r = canvas.getBoundingClientRect();
				zoomAt(
					r.width / 2,
					r.height / 2,
					ui.map.z * (m === "+" ? 1.4 : 1 / 1.4),
				);
			}),
		);
}

// ---------- Сюжетные квесты (главы историй) -----------------------------
let storyData = null;
async function loadStoryData() {
	if (storyData) return storyData;
	try {
		const r = await fetch("data/story-quests.json", { cache: "no-cache" });
		if (r.ok) {
			storyData = await r.json();
			return storyData;
		}
	} catch {}
	if (window.__STORY__) {
		storyData = window.__STORY__;
		return storyData;
	}
	try {
		await injectScript("data/story-quests.js");
		storyData = window.__STORY__ || { quests: [] };
	} catch {
		storyData = { quests: [] };
	}
	return storyData;
}
// стадия выполнена, если выполнены все её ОБЯЗАТЕЛЬНЫЕ цели (необязательные не блокируют)
function storyStageDone(stage) {
	return stage.objectives.every(
		(o) => o.optional || state.storyDone.has(o.id),
	);
}
// индекс активной стадии в списке = первая невыполненная (все предыдущие выполнены); == длине, если всё пройдено
function stagesActiveIndex(stages) {
	let i = 0;
	while (i < stages.length && storyStageDone(stages[i])) i++;
	return i;
}
function storyObjHtml(o) {
	const done = state.storyDone.has(o.id);
	const locs = (o.maps || [])
		.map(
			(m) =>
				`<span class="so-loc" style="--c:${mapColor(m)}">${esc(mapName(m))}</span>`,
		)
		.join("");
	const fir = o.fir ? ` <span class="firlbl">FiR</span>` : "";
	const opt = o.optional ? ` <span class="so-optlbl">необяз.</span>` : "";
	return `<li class="so${done ? " so-done" : ""}${o.optional ? " so-opt" : ""}">
			<label class="so-check"><input type="checkbox" data-story="${o.id}" ${done ? "checked" : ""}><span class="so-box"></span></label>
			<span class="so-txt"><span class="so-act">${esc(o.action)}:</span> ${esc(o.desc)}${opt}${fir} ${locs}</span>
		</li>`;
}
// отрисовка списка стадий; baseNum — смещение нумерации (для веток продолжаем нумерацию после общих стадий)
function storyStagesHtml(stages, act, baseNum) {
	return stages
		.map((st, i) => {
			const n = baseNum + i + 1;
			const locked = i > act,
				isDone = i < act;
			const badge = isDone
				? '<span class="ss-badge done">✓</span>'
				: i === act
					? '<span class="ss-badge cur">текущая</span>'
					: '<span class="ss-badge lock">🔒</span>';
			const head = `<span class="ss-no">Стадия ${n}</span> <span class="ss-title">${esc(st.title || "")}</span> ${badge}`;
			if (locked)
				return `<div class="ss locked"><div class="ss-head">${head}</div><div class="ss-hint">Откроется после выполнения стадии ${n - 1}.</div></div>`;
			const objs = `<ul class="so-list">${st.objectives.map(storyObjHtml).join("")}</ul>`;
			if (isDone)
				return `<details class="ss done"><summary class="ss-head">${head}</summary>${objs}</details>`;
			return `<div class="ss cur"><div class="ss-head">${head}</div>${objs}</div>`;
		})
		.join("");
}
function storyQuestHtml(q) {
	const stages = q.stages || [];
	const wikiLnk = q.wiki
		? ` · <a href="${q.wiki}" target="_blank" rel="noopener">wiki ↗</a>`
		: "";
	// заглушка (нет подзадач на вики)
	if (!stages.length && !(q.branches && q.branches.length)) {
		return `<article class="story-card stub">
			<div class="story-top"><h2>${esc(q.name)}</h2><div class="story-meta">Сюжетный квест${wikiLnk}</div></div>
			<div class="ss-hint" style="margin-top:8px">${esc(q.stub || "Подзадачи появятся позже.")}</div>
		</article>`;
	}
	// глава ещё не начата — показываем кнопку «Начать» (кроме автостарта, напр. «Тур»)
	const started = q.autostart || state.storyStarted.has(q.id);
	if (!started) {
		const totalStages =
			stages.length +
			(q.branches && q.branches.length ? " + ветки" : "");
		return `<article class="story-card notstarted">
			<div class="story-top"><h2>${esc(q.name)}</h2><div class="story-meta">Сюжетный квест · ${totalStages} стадий · не начата${wikiLnk}</div></div>
			${q.description ? `<p class="story-desc">${esc(q.description)}</p>` : ""}
			<div class="story-start"><button class="btn-gold" data-start="${q.id}">▶ Начать главу</button><span class="muted">Первый этап откроется после старта</span></div>
		</article>`;
	}
	const cAct = stagesActiveIndex(stages),
		cLen = stages.length,
		commonDone = cAct >= cLen;
	let html = storyStagesHtml(stages, cAct, 0);
	let doneStages = Math.min(cAct, cLen),
		totalStages = cLen,
		finished = commonDone;

	const branches = q.branches || [];
	if (branches.length) {
		if (!commonDone) {
			html += `<div class="ss locked"><div class="ss-head"><span class="ss-no">Развилка</span> <span class="ss-title">${esc(q.branchPoint || "Выбор пути")}</span> <span class="ss-badge lock">🔒</span></div><div class="ss-hint">Откроется после общих стадий — выбор из ${branches.length} концовок.</div></div>`;
			finished = false;
		} else {
			const br = branches.find((b) => b.id === state.storyBranch[q.id]);
			if (!br) {
				html += `<div class="branch-choose"><div class="bc-title">⑂ ${esc(q.branchPoint || "Развилка — выберите путь")}</div><div class="bc-opts">${branches
					.map(
						(b) =>
							`<button class="bc-opt" data-branch="${q.id}|${b.id}"><span class="bc-lab">${esc(b.label)}</span><span class="bc-cnt">${b.stages.length} стадий →</span></button>`,
					)
					.join("")}</div></div>`;
				finished = false;
			} else {
				const bAct = stagesActiveIndex(br.stages);
				html += `<div class="branch-active"><div class="bc-head">Путь: <b>${esc(br.label)}</b> <button class="bc-switch" data-branch="${q.id}|">← сменить</button></div>${storyStagesHtml(br.stages, bAct, cLen)}</div>`;
				doneStages += Math.min(bAct, br.stages.length);
				totalStages += br.stages.length;
				finished = bAct >= br.stages.length;
			}
		}
	}
	return `<article class="story-card${finished ? " fin" : ""}">
		<div class="story-top">
			<h2>${esc(q.name)}${finished ? ' <span class="ss-badge done">✓ завершён</span>' : ""}</h2>
			<div class="story-meta">Сюжетный квест · ${doneStages} / ${totalStages} стадий${q.wiki ? ` · <a href="${q.wiki}" target="_blank" rel="noopener">wiki ↗</a>` : ""}</div>
		</div>
		${q.description ? `<p class="story-desc">${esc(q.description)}</p>` : ""}
		<div class="story-stages">${html}</div>
		${q.rewards && q.rewards.length ? `<div class="story-rewards"><b>Награды:</b> ${q.rewards.map(esc).join(" · ")}</div>` : ""}
	</article>`;
}
function renderStory() {
	const root = document.getElementById("view-story");
	const qs = (storyData && storyData.quests) || [];
	if (!qs.length) {
		root.innerHTML = `<div class="planner-empty">Сюжетные квесты не загружены.</div>`;
		return;
	}
	const ordered = [...qs].sort((a, b) => (a.order || 99) - (b.order || 99));
	root.innerHTML = `
		<div class="page-head"><h2>Сюжетные квесты</h2><span class="ph-sub">${ordered.length} глав · подзадачи открываются по мере прохождения</span></div>
		<div class="story-list">${ordered.map(storyQuestHtml).join("")}</div>`;
}
// объективы ТЕКУЩЕЙ активной стадии сюжетного квеста (общей или внутри выбранной ветки)
function storyActiveObjectives(q) {
	const stages = q.stages || [];
	const cAct = stagesActiveIndex(stages);
	if (cAct < stages.length) return stages[cAct].objectives;
	const branches = q.branches || [];
	const br = branches.find((b) => b.id === state.storyBranch[q.id]);
	if (br) {
		const bAct = stagesActiveIndex(br.stages);
		if (bAct < br.stages.length) return br.stages[bAct].objectives;
	}
	return [];
}
// сюжетные задачи (начатых квестов, текущая стадия, не выполненные) на указанной локации
function storyTasksForMap(mapId) {
	const out = [];
	for (const q of (storyData && storyData.quests) || []) {
		if (!(q.autostart || state.storyStarted.has(q.id))) continue;
		for (const o of storyActiveObjectives(q)) {
			if (state.storyDone.has(o.id)) continue;
			if ((o.maps || []).includes(mapId)) out.push({ q, o });
		}
	}
	return out;
}

// ---------- Finder (Список находок) ------------------------------------
let catalog = null;
function injectScript(src) {
	return new Promise((res, rej) => {
		const s = document.createElement("script");
		s.src = src;
		s.onload = res;
		s.onerror = rej;
		document.head.appendChild(s);
	});
}
async function loadCatalog() {
	if (catalog) return catalog;
	try {
		const r = await fetch("data/items.json", { cache: "force-cache" });
		if (r.ok) {
			catalog = (await r.json()).items;
			return catalog;
		}
	} catch {}
	if (window.__ITEMS__) {
		catalog = window.__ITEMS__.items;
		return catalog;
	}
	try {
		await injectScript("data/items-data.js");
		catalog = (window.__ITEMS__ || { items: [] }).items;
	} catch {
		catalog = [];
	}
	return catalog;
}
const catItem = (id) =>
	(catalog || []).find((i) => i.id === id) ||
	itemById.get(id) || { id, name: id, shortName: id };
function searchCatalog(q) {
	q = q.trim().toLowerCase();
	if (q.length < 2 || !catalog) return [];
	const res = [];
	for (const i of catalog) {
		const n = (i.name + " " + i.shortName).toLowerCase();
		if (n.includes(q)) {
			res.push(i);
			if (res.length >= 25) break;
		}
	}
	return res;
}
function groupItemsHtml(g) {
	if (!g.items.length)
		return '<li class="empty-note" style="border:none">Пока пусто. Добавьте предметы ниже.</li>';
	return g.items
		.map((it) => {
			const ci = catItem(it.id);
			const ic = ci.icon || ci.img;
			const img = ic
				? `<img src="${ic}" data-item="${it.id}" data-itemimg="${ci.img || ci.icon || ""}" onerror="this.style.display='none'">`
				: "";
			return `<li class="${it.found ? "found" : ""}">
      <input type="checkbox" data-found="${it.id}" data-group="${g.id}" ${it.found ? "checked" : ""} title="Отметить найденным">
      ${img}<span class="nm">${esc(ci.name)}</span>${ci.cat ? `<span class="cat-mini">${esc(ci.cat)}</span>` : ""}
      <span class="qty-wrap" title="Сколько нужно найти">×<input type="number" min="1" class="qty-input" data-qty="${it.id}" data-group="${g.id}" value="${it.qty || 1}"></span>
      <span class="rm" data-rmitem="${it.id}" data-group="${g.id}" title="Убрать">✕</span>
    </li>`;
		})
		.join("");
}
function groupHtml(g) {
	const foundN = g.items.filter((i) => i.found).length;
	return `<div class="fgroup" data-group="${g.id}">
    <div class="fg-head">
      <span class="fg-del" data-delgroup="${g.id}" title="Удалить группу">🗑 удалить</span>
      <input class="fg-name" data-name="${g.id}" value="${esc(g.name)}" placeholder="Название группы" />
      <textarea class="fg-desc" data-desc="${g.id}" placeholder="Описание (зачем нужны эти предметы)">${esc(g.desc || "")}</textarea>
    </div>
    <div class="fg-body">
      <div class="fg-count">${g.items.length} предмет(ов)${foundN ? ` · найдено ${foundN}` : ""}</div>
      <ul class="fg-items">${groupItemsHtml(g)}</ul>
      <div class="fg-search">
        <input type="text" data-fsearch="${g.id}" placeholder="Добавить предмет: поиск по названию…" autocomplete="off" />
        <div class="fg-results" id="res-${g.id}"></div>
      </div>
    </div>
  </div>`;
}
function renderFinder() {
	const root = document.getElementById("view-finder");
	const groups = state.findGroups.map(groupHtml).join("");
	root.innerHTML = `
    <div class="page-head">
      <h2>Список находок</h2>
      <span class="ph-sub">что хочу найти в рейдах — по группам с описанием</span>
      <div class="ph-actions"><button class="btn-gold" id="add-group">+ Новая группа</button></div>
    </div>
    ${state.findGroups.length ? `<div class="finder-grid">${groups}</div>` : '<div class="planner-empty">Пока нет групп.<br><br>Создайте группу (например «На увеличение схрона») и добавьте предметы, которые хотите найти.</div>'}`;
	if (!catalog)
		loadCatalog().then(() => {
			if (ui.view === "finder") renderFinder();
		});
}
function findGroup(id) {
	return state.findGroups.find((g) => g.id === id);
}

// ---------- Kappa (предметы для Каппы / квест «Коллекционер») -----------
function kappaItems() {
	return collectorTask.objectives
		.filter((o) => o.handIn.some((h) => h.item))
		.map((o) => {
			const h = o.handIn.find((x) => x.item);
			return {
				objId: o.id,
				item: h.item,
				total: objTotal(o),
				done: objDone(o.id),
			};
		});
}
function kappaGridHtml(items) {
	const q = ui.kappaSearch.trim().toLowerCase();
	const list = items
		.filter((i) => {
			if (ui.kappaHideFound && i.done >= i.total) return false;
			if (
				q &&
				!(itemName(i.item) + " " + itemShort(i.item))
					.toLowerCase()
					.includes(q)
			)
				return false;
			return true;
		})
		.sort((a, b) => itemName(a.item).localeCompare(itemName(b.item), "ru"));
	if (!list.length) return '<div class="empty-note">Ничего не найдено.</div>';
	return list
		.map((i) => {
			const ic = itemIcon(i.item);
			const img = ic
				? `<img src="${ic}" data-item="${i.item}" onerror="this.style.display='none'">`
				: "";
			return `<label class="kappa-item ${i.done >= i.total ? "got" : ""}" title="${esc(itemName(i.item))}">
      <input type="checkbox" data-objchk="${i.objId}" data-total="${i.total}" ${i.done >= i.total ? "checked" : ""}>
      ${img}<span class="kn">${esc(itemName(i.item))}</span>
    </label>`;
		})
		.join("");
}
function renderKappa() {
	const root = document.getElementById("view-kappa");
	if (!collectorTask) {
		root.innerHTML = `<div class="page-head"><h2>Предметы для Каппы</h2></div><div class="planner-empty">Квест «Коллекционер» не найден в данных.</div>`;
		return;
	}
	const items = kappaItems();
	const total = items.length,
		got = items.filter((i) => i.done >= i.total).length;
	const pct = total ? Math.round((got / total) * 100) : 0;
	root.innerHTML = `
    <div class="page-head"><h2>Предметы для Каппы</h2><span class="ph-sub">квест «Коллекционер» — собрать и сдать ${total} предметов</span></div>
    <div class="kappa-progress"><div class="kappa-bar"><div class="kappa-fill" style="width:${pct}%"></div></div><b>${got} / ${total}</b> <span class="muted">(${pct}%)</span></div>
    <div class="kappa-controls">
      <input type="text" id="kappa-search" placeholder="Поиск предмета…" value="${esc(ui.kappaSearch)}" autocomplete="off" />
      <label class="chk"><input type="checkbox" id="kappa-hidefound" ${ui.kappaHideFound ? "checked" : ""}> Скрыть собранные</label>
    </div>
    <div class="kappa-grid" id="kappa-grid">${kappaGridHtml(items)}</div>`;
}

// ---------- Lightbox ----------------------------------------------------
function openLightbox(src, name) {
	if (!src) return;
	const im = document.getElementById("lb-img"),
		nm = document.getElementById("lb-name");
	nm.textContent = name || "";
	im.style.display = "";
	im.onerror = () => {
		im.style.display = "none";
		nm.textContent = (name ? name + " — " : "") + "изображение недоступно";
	};
	im.src = src;
	document.getElementById("lightbox").classList.remove("hidden");
}
function closeLightbox() {
	document.getElementById("lightbox").classList.add("hidden");
	document.getElementById("lb-img").src = "";
}

// ---------- View switching ---------------------------------------------
// держим URL-хэш в актуальном состоянии, чтобы обновление страницы не сбрасывало вкладку
// ---------- Многостраничность (MPA): отдельные HTML на каждый раздел -----
const PAGE = {
	home: "index.html",
	mine: "mine.html",
	all: "all.html",
	planner: "planner.html",
	finder: "finder.html",
	kappa: "kappa.html",
	story: "story.html",
};
// ссылка на квест (открывается на странице «Все квесты»)
const questUrl = (id) => `all.html?q=${encodeURIComponent(id)}`;
function shellHtml(av) {
	const tab = (v, label) =>
		`<a class="tab${av === v ? " active" : ""}" href="${PAGE[v]}">${label}</a>`;
	return `
  <header class="topbar">
    <a class="brand" href="index.html" title="На главную"><h1>Квестовик</h1><span class="meta" id="meta"></span></a>
    <nav class="tabs">${tab("mine", "Мои квесты")}${tab("story", "Сюжетные")}${tab("planner", "План рейда")}${tab("finder", "Список находок")}${tab("kappa", "Каппа")}</nav>
  </header>
  <main class="wrap">
    <section class="addquest hidden" id="addquest"></section>
    <section class="filters" id="filters">
      <input type="text" id="f-search" placeholder="Поиск: квест, задача, предмет…" />
      <select id="f-map"><option value="">Все локации</option></select>
      <select id="f-trader"><option value="">Все торговцы</option></select>
      <select id="f-action"><option value="">Любое действие</option></select>
      <select id="f-status"><option value="">Любой статус</option><option value="todo">Невыполненные</option><option value="completed">Выполненные</option><option value="failed">Проваленные</option></select>
      <select id="f-faction"><option value="">Все фракции</option><option value="USEC">USEC</option><option value="BEAR">BEAR</option></select>
      <label class="chk"><input type="checkbox" id="f-kappa" /> Только Каппа</label>
      <label class="chk"><input type="checkbox" id="f-plan" /> Только в плане</label>
      <label class="chk"><input type="checkbox" id="f-showdone" /> Показать выполненные</label>
      <button class="btn-ghost" id="f-reset">Сбросить</button>
    </section>
    <div class="stats" id="stats"></div>
    <section id="view-home" class="hidden"><div class="home">
      <h2>Квестовик — планировщик рейда Escape from Tarkov</h2>
      <p class="lead">Помогает собираться в рейд осмысленно: что взять с собой, что найти и сдать, какие квесты сейчас доступны и куда идти — всё в разрезе локаций.</p>
      <h3>Что внутри</h3>
      <ul>
        <li><b>Мои квесты</b> — активные квесты. Сверху поле <b>«Добавить квест»</b>: найдите квест и добавьте его — все предыдущие по ветке отметятся выполненными. Дальше следующие квесты добавляются автоматически.</li>
        <li><b>Сюжетные</b> — главы историй: большие квесты, подзадачи которых открываются постепенно по стадиям, с выбором концовки у некоторых.</li>
        <li><b>План рейда</b> — отмеченные квесты, собранные по локациям: что <i>взять с собой / заложить</i> и что <i>найти / купить и сдать</i>. Карты локаций с маркерами целей, выходами и спавнами боссов.</li>
        <li><b>Список находок</b> — личные списки предметов по группам с искомым количеством.</li>
        <li><b>Каппа</b> — предметы для контейнера Каппа: чек-лист с прогрессом и поиском.</li>
      </ul>
      <h3>Зачем это нужно</h3>
      <p>Перед рейдом за минуту понятно: какие квесты можно сделать на этой локации, что для них взять, что найти и сдать и сколько ещё осталось — чтобы не таскать лишнее и не забывать цели.</p>
      <h3>Предложения по улучшению</h3>
      <p>Идеи и замечания присылайте на <a href="mailto:mixic-pro@mail.ru">mixic-pro@mail.ru</a>.</p>
      <h3>Данные</h3>
      <p>Квесты, предметы, иконки и карты берутся из открытого проекта <a href="https://tarkov.dev" target="_blank" rel="noopener">tarkov.dev</a>. Прогресс хранится локально в вашем браузере — сервера и регистрации нет.</p>
    </div></section>
    <section id="view-mine"></section>
    <section id="view-all" class="hidden"></section>
    <section id="view-planner" class="hidden"></section>
    <section id="view-finder" class="hidden"></section>
    <section id="view-kappa" class="hidden"></section>
    <section id="view-story" class="hidden"></section>
  </main>
  <div id="cookie-bar" class="hidden"><span>Сайт использует куки (а кто их не использует). Там буквально 1 запись, чтобы показать эту плашку :)</span><button id="cookie-ok" class="btn-gold">Ок</button></div>
  <div id="lightbox" class="hidden"><div class="lb-inner"><img id="lb-img" src="" alt="" /><div id="lb-name"></div></div></div>
  <div id="toast"></div>`;
}
function setView(v) {
	ui.view = v;
	["home", "mine", "all", "planner", "finder", "kappa", "story"].forEach((x) =>
		document
			.getElementById("view-" + x)
			.classList.toggle("hidden", x !== v),
	);
	const questView = v === "mine" || v === "all";
	document.getElementById("filters").classList.toggle("hidden", !questView);
	// поле «Добавить квест» — только на «Мои квесты»
	document.getElementById("addquest").classList.toggle("hidden", v !== "mine");
	document
		.getElementById("stats")
		.classList.toggle("hidden", !(questView || v === "planner"));
	if (v === "mine") renderQuests("mine");
	else if (v === "all") renderQuests("all");
	else if (v === "planner") renderPlanner();
	else if (v === "finder") renderFinder();
	else if (v === "kappa") renderKappa();
	else if (v === "story") renderStory();
}
// открыть конкретный квест на странице «Все квесты» (по ?q=)
function openQuest(id) {
	ui.expanded.add(id);
	renderQuests("all");
	const el = document.querySelector(`#view-all .qrow[data-id="${id}"]`);
	if (el) {
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		el.style.outline = "2px solid var(--gold)";
		setTimeout(() => (el.style.outline = ""), 1500);
	} else toast("Квест скрыт фильтрами");
}

// ---------- Events ------------------------------------------------------
function questTableClick(e, scope) {
	if (e.target.closest("a")) return; // ссылки (вики, квесты) навигируют сами
	if (progressClick(e)) return;
	const cur = e.target.closest("[data-current]");
	if (cur) {
		markAsCurrent(cur.dataset.current);
		return;
	}
	if (e.target.id === "reset-progress") {
		resetProgress();
		return;
	}
	const img = e.target.closest("img[data-item]");
	if (img) {
		e.stopPropagation();
		openLightbox(itemImg(img.dataset.item), itemName(img.dataset.item));
		return;
	}
	const cb = e.target.closest(".plan-cb");
	if (cb) {
		e.stopPropagation();
		togglePlan(cb.dataset.id);
		return;
	}
	const sort = e.target.closest("[data-sort]");
	if (sort) {
		const c = sort.dataset.sort;
		if (ui.sort.col === c) ui.sort.dir *= -1;
		else ui.sort = { col: c, dir: 1 };
		renderQuests(scope);
		return;
	}
	const btn = e.target.closest("[data-act]");
	if (btn) {
		e.stopPropagation();
		const id = btn.dataset.id;
		if (btn.dataset.act === "done")
			setStatus(id, state.completed.has(id) ? null : "completed");
		else if (btn.dataset.act === "fail")
			setStatus(id, state.failed.has(id) ? null : "failed");
		else if (btn.dataset.act === "active") toggleActive(id);
		else setStatus(id, null);
		return;
	}
	if (e.target.tagName === "A") return;
	const row = e.target.closest(".qrow:not(.head)");
	if (row) {
		const id = row.dataset.id;
		if (ui.expanded.has(id)) ui.expanded.delete(id);
		else ui.expanded.add(id);
		renderQuests(scope);
	}
}

function wireEvents() {
	const f = ui.filters;
	const bind = (id, key) =>
		document.getElementById(id).addEventListener("change", (e) => {
			f[key] =
				e.target.type === "checkbox"
					? e.target.checked
					: e.target.value;
			renderStats();
			renderQuests(ui.view === "mine" ? "mine" : "all");
		});
	document.getElementById("f-search").addEventListener("input", (e) => {
		f.search = e.target.value;
		renderQuests(ui.view === "mine" ? "mine" : "all");
	});
	[
		"f-map:map",
		"f-trader:trader",
		"f-action:action",
		"f-status:status",
		"f-faction:faction",
		"f-kappa:kappa",
		"f-plan:plan",
		"f-showdone:showdone",
	].forEach((s) => {
		const [i, k] = s.split(":");
		bind(i, k);
	});
	document.getElementById("f-reset").addEventListener("click", () => {
		Object.assign(f, {
			search: "",
			map: "",
			trader: "",
			action: "",
			status: "",
			faction: "",
			kappa: false,
			plan: false,
			showdone: false,
		});
		document.getElementById("f-search").value = "";
		["f-map", "f-trader", "f-action", "f-status", "f-faction"].forEach(
			(i) => (document.getElementById(i).value = ""),
		);
		["f-kappa", "f-plan", "f-showdone"].forEach(
			(i) => (document.getElementById(i).checked = false),
		);
		renderStats();
		renderQuests(ui.view === "mine" ? "mine" : "all");
	});

	document
		.getElementById("view-mine")
		.addEventListener("click", (e) => questTableClick(e, "mine"));
	document
		.getElementById("view-all")
		.addEventListener("click", (e) => questTableClick(e, "all"));
	document.getElementById("view-mine").addEventListener("change", (e) => {
		if (progressChange(e)) return;
		if (e.target.classList.contains("plan-all-cb"))
			toggleAllPlan("mine", e.target.checked);
	});
	document.getElementById("view-all").addEventListener("change", (e) => {
		progressChange(e);
	});
	// поле «Добавить квест» (над фильтрами) — поиск и добавление квеста
	const addq = document.getElementById("addquest");
	addq.addEventListener("input", (e) => {
		if (e.target.id === "onb-input") {
			ui.onbQuery = e.target.value;
			const box = document.getElementById("onb-results");
			if (box) box.innerHTML = onbResultsHtml();
		}
	});
	addq.addEventListener("click", (e) => {
		const cur = e.target.closest("[data-current]");
		if (cur) {
			markAsCurrent(cur.dataset.current);
			return;
		}
		if (e.target.id === "reset-progress") resetProgress();
	});

	// planner
	const planView = document.getElementById("view-planner");
	planView.addEventListener("click", (e) => {
		if (e.target.closest("a")) return; // настоящие ссылки навигируют сами
		if (e.target.id === "map-show") {
			const sel = document.getElementById("map-pick");
			if (sel && sel.value)
				location.href =
					"planner.html?loc=" + encodeURIComponent(sel.value);
			return;
		}
		const pin = e.target.closest("[data-pinobj]");
		if (pin) {
			// клик по маркеру отмечает соответствующую подзадачу справа (+1 к прогрессу;
			// для чекбокса — сразу выполнено). Так понятно, какую именно цель закрыл.
			const objId = pin.dataset.pinobj;
			const t = taskById.get(pin.dataset.quest);
			const o = t && t.objectives.find((x) => x.id === objId);
			if (o && trackable(o)) {
				setProgress(
					objId,
					Math.min(objTotal(o), objDone(objId) + 1),
				);
			} else {
				// не трекается — просто подсветим строку задачи
				const li = document.querySelector(
					`#view-planner [data-li-obj="${objId}"]`,
				);
				if (li) {
					li.scrollIntoView({ behavior: "smooth", block: "center" });
					li.classList.add("li-flash");
					setTimeout(() => li.classList.remove("li-flash"), 1200);
				}
			}
			return;
		}
		// чек-лист «нашёл в рейде»: +/− у предмета в «Найти в рейде»
		const ls = e.target.closest(".loot-step .st-btn");
		if (ls) {
			const wrap = ls.closest(".loot-step");
			const key = wrap.dataset.loot,
				need = +wrap.dataset.need;
			const next = Math.max(
				0,
				Math.min(need, (state.found[key] || 0) + +ls.dataset.d),
			);
			if (next <= 0) delete state.found[key];
			else state.found[key] = next;
			persistFound();
			renderPlanner();
			return;
		}
		if (progressClick(e)) return;
		const img = e.target.closest("img[data-item]");
		if (img) {
			openLightbox(
				img.dataset.itemimg || itemImg(img.dataset.item),
				itemName(img.dataset.item),
			);
			return;
		}
		const rm = e.target.closest("[data-rm]");
		if (rm) {
			togglePlan(rm.dataset.rm);
			return;
		}
		if (e.target.id === "plan-clear") {
			state.plan.clear();
			persistPlan();
			renderStats();
			renderPlanner();
		}
	});
	planView.addEventListener("change", (e) => {
		const ly = e.target.closest("[data-layer]");
		if (ly) {
			ui.mapLayers[ly.dataset.layer] = ly.checked;
			const el = document.querySelector(".layer-" + ly.dataset.layer);
			if (el) el.hidden = !ly.checked;
			return;
		}
		const tg = e.target.closest("[data-toggle]");
		if (tg) {
			const k = tg.dataset.toggle,
				on = tg.checked;
			if (k === "findings") ui.showFindings = on;
			// блок есть и в боковой панели, и в углу карты — синхронизируем оба
			planView
				.querySelectorAll(`[data-blk="${k}"] .le-body`)
				.forEach((el) => {
					el.hidden = !on;
				});
			planView
				.querySelectorAll(`input[data-toggle="${k}"]`)
				.forEach((c) => {
					c.checked = on;
				});
			return;
		}
		if (progressChange(e)) return;
		const sel = e.target.closest("[data-choice]");
		if (sel) {
			state.planChoices[sel.dataset.choice] = sel.value;
			persistPlan();
			renderPlanner();
		}
	});
	// подсветка маркеров квеста при наведении на него в списке задач
	let hlQuest = null;
	const setHlQuest = (tid) => {
		if (hlQuest === tid) return;
		hlQuest = tid;
		planView
			.querySelectorAll(".pin-dot.pin-hl")
			.forEach((p) => p.classList.remove("pin-hl"));
		if (tid)
			planView
				.querySelectorAll(`.pin-dot[data-quest="${tid}"]`)
				.forEach((p) => p.classList.add("pin-hl"));
	};
	planView.addEventListener("mouseover", (e) => {
		const qg = e.target.closest("[data-quest]");
		if (qg && !qg.classList.contains("pin-dot"))
			setHlQuest(qg.dataset.quest);
	});
	planView.addEventListener("mouseout", (e) => {
		const qg = e.target.closest("[data-quest]");
		if (
			qg &&
			!qg.classList.contains("pin-dot") &&
			!qg.contains(e.relatedTarget)
		)
			setHlQuest(null);
	});

	// finder
	const finder = document.getElementById("view-finder");
	finder.addEventListener("click", (e) => {
		if (e.target.id === "add-group") {
			state.findGroups.push({
				id: crypto.randomUUID ? crypto.randomUUID() : "g" + Date.now(),
				name: "Новая группа",
				desc: "",
				items: [],
			});
			persistFinder();
			renderFinder();
			return;
		}
		const del = e.target.closest("[data-delgroup]");
		if (del) {
			state.findGroups = state.findGroups.filter(
				(g) => g.id !== del.dataset.delgroup,
			);
			persistFinder();
			renderFinder();
			return;
		}
		const add = e.target.closest("[data-additem]");
		if (add) {
			const g = findGroup(add.dataset.group);
			if (g && !g.items.some((i) => i.id === add.dataset.additem)) {
				g.items.push({ id: add.dataset.additem, found: false, qty: 1 });
				persistFinder();
				renderFinder();
			}
			return;
		}
		const rmi = e.target.closest("[data-rmitem]");
		if (rmi) {
			const g = findGroup(rmi.dataset.group);
			if (g) {
				g.items = g.items.filter((i) => i.id !== rmi.dataset.rmitem);
				persistFinder();
				renderFinder();
			}
			return;
		}
		const img = e.target.closest("img[data-item]");
		if (img) {
			openLightbox(img.dataset.itemimg || img.src, "");
			return;
		}
	});
	finder.addEventListener("input", (e) => {
		const qi = e.target.closest("[data-qty]");
		if (qi) {
			const g = findGroup(qi.dataset.group);
			const it = g && g.items.find((i) => i.id === qi.dataset.qty);
			if (it) {
				it.qty = Math.max(1, parseInt(qi.value, 10) || 1);
				persistFinder();
			}
			return;
		}
		const s = e.target.closest("[data-fsearch]");
		if (s) {
			const box = document.getElementById("res-" + s.dataset.fsearch);
			const run = () => {
				const res = searchCatalog(s.value);
				box.innerHTML = res
					.map(
						(i) =>
							`<div class="r" data-additem="${i.id}" data-group="${s.dataset.fsearch}">${i.icon ? `<img src="${i.icon}" onerror="this.style.display='none'">` : ""}<span>${esc(i.name)}</span>${i.cat ? `<span class="cat-mini">${esc(i.cat)}</span>` : ""}</div>`,
					)
					.join("");
			};
			if (catalog) run();
			else {
				box.innerHTML = '<div class="r">загрузка каталога…</div>';
				loadCatalog().then(run);
			}
		}
	});
	finder.addEventListener("change", (e) => {
		const found = e.target.closest("[data-found]");
		if (found) {
			const g = findGroup(found.dataset.group);
			const it = g && g.items.find((i) => i.id === found.dataset.found);
			if (it) {
				it.found = found.checked;
				persistFinder();
				renderFinder();
			}
			return;
		}
		const nm = e.target.closest("[data-name]");
		if (nm) {
			const g = findGroup(nm.dataset.name);
			if (g) {
				g.name = nm.value;
				persistFinder();
			}
			return;
		}
		const ds = e.target.closest("[data-desc]");
		if (ds) {
			const g = findGroup(ds.dataset.desc);
			if (g) {
				g.desc = ds.value;
				persistFinder();
			}
			return;
		}
	});

	// kappa
	const kappa = document.getElementById("view-kappa");
	kappa.addEventListener("change", (e) => {
		if (e.target.id === "kappa-hidefound") {
			ui.kappaHideFound = e.target.checked;
			renderKappa();
			return;
		}
		if (progressChange(e)) return;
	});
	kappa.addEventListener("input", (e) => {
		if (e.target.id === "kappa-search") {
			ui.kappaSearch = e.target.value;
			const g = document.getElementById("kappa-grid");
			if (g) g.innerHTML = kappaGridHtml(kappaItems());
		}
	});
	kappa.addEventListener("click", (e) => {
		const img = e.target.closest("img[data-item]");
		if (img) {
			openLightbox(itemImg(img.dataset.item), itemName(img.dataset.item));
		}
	});

	// сюжетные квесты — отметка подзадач (открывает следующую стадию)
	const story = document.getElementById("view-story");
	story.addEventListener("change", (e) => {
		const cb = e.target.closest("input[data-story]");
		if (!cb) return;
		if (cb.checked) state.storyDone.add(cb.dataset.story);
		else state.storyDone.delete(cb.dataset.story);
		persistStory();
		renderStory();
	});
	story.addEventListener("click", (e) => {
		// «Начать главу»
		const start = e.target.closest("[data-start]");
		if (start) {
			state.storyStarted.add(start.dataset.start);
			persistStory();
			renderStory();
			return;
		}
		// выбор / смена ветки (концовки) сюжетного квеста
		const b = e.target.closest("[data-branch]");
		if (!b) return;
		const [qid, bid] = b.dataset.branch.split("|");
		if (bid) state.storyBranch[qid] = bid;
		else delete state.storyBranch[qid];
		persistStory();
		renderStory();
	});

	// lightbox
	document
		.getElementById("lightbox")
		.addEventListener("click", closeLightbox);
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape") return;
		if (!document.getElementById("lightbox").classList.contains("hidden")) {
			closeLightbox();
			return;
		}
		if (ui.mapFullscreen) {
			ui.mapFullscreen = false;
			ui.map.z = 0;
			renderPlanner();
		}
	});
	// выход из настоящего полного экрана (Esc/F11/кнопка) — сворачиваем и развёрнутую карту
	document.addEventListener("fullscreenchange", () => {
		if (
			!document.fullscreenElement &&
			ui.mapFullscreen &&
			ui.view === "planner"
		) {
			ui.mapFullscreen = false;
			ui.map.z = 0;
			renderPlanner();
		}
	});
}

// ---------- Boot --------------------------------------------------------
async function loadData() {
	try {
		const r = await fetch("data/quests.json", { cache: "no-cache" });
		if (r.ok) return await r.json();
		throw new Error("http " + r.status);
	} catch (e) {
		if (window.__QUESTS__) return window.__QUESTS__;
		throw e;
	}
}
(async function boot() {
	const view = document.body.dataset.view || "home";
	const firstVisit = !getCookie("th_visited");
	document.getElementById("app-root").innerHTML = shellHtml(view);
	const q = new URLSearchParams(location.search);

	try {
		data = await loadData();
	} catch (e) {
		document.getElementById("app-root").innerHTML =
			`<div class="loading">Не удалось загрузить data/quests.json.<br>Откройте через локальный сервер.<br><br>${esc(e.message)}</div>`;
		return;
	}
	buildIndices();
	await migrateData();
	await loadState();
	await loadMapsGeo();
	addGeoOnlyMaps();
	if (view === "story" || view === "planner") await loadStoryData();
	recomputeFailed();
	fillFilterOptions();
	wireEvents();
	document.getElementById("meta").textContent = "планировщик рейда EFT";
	renderStats();
	if (firstVisit) {
		setCookie("th_visited", "1", 365);
		const bar = document.getElementById("cookie-bar");
		bar.classList.remove("hidden");
		document
			.getElementById("cookie-ok")
			.addEventListener("click", () => bar.classList.add("hidden"));
	}
	// под-состояние из query: планировщик (?loc / ?fs), «Все квесты» (?q)
	if (view === "planner") {
		if (q.get("fs")) {
			ui.plannerTab = q.get("fs");
			ui.mapFullscreen = true;
		} else if (q.get("loc")) ui.plannerTab = q.get("loc");
	}
	setView(view);
	if (view === "all" && q.get("q")) openQuest(q.get("q"));
})();
