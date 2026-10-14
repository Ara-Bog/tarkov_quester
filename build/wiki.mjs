// Дополняет квесты, которых нет в выгрузке tarkov.dev, данными русской вики Escape from Tarkov
// (escapefromtarkov.fandom.com/ru, лицензия CC BY-SA 3.0 — при использовании указываем источник).
// tarkov.dev пропускает квесты, которые игра помечает сюжетными/скрытыми, и ивентовые/сезонные
// (KORD BREACH, «Смещение баланса» и т.п.), а иногда теряет квесты при сбоях своей выгрузки.
// Сопоставление с tarkov.dev — по полю node инфобокса (это BSG id квеста), иначе по названию.
// Результат: build/wiki_raw.json, его подхватывает transform.mjs.
// Запуск: node build/wiki.mjs   (после node build/fetch.mjs)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dir, 'wiki_raw.json');
const API = 'https://escapefromtarkov.fandom.com/ru/api.php';
const UA = 'tarkov-quester-build/1.0 (https://ara-bog.github.io/tarkov_quester/)';
// ивенты старше этого считаем закончившимися (у вики нет даты окончания ивента)
const EVENT_MAX_AGE_DAYS = 75;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(params) {
  const u = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    if (r.ok) return r.json();
    if (attempt >= 2) throw new Error(`wiki API: HTTP ${r.status}`);
    await sleep(2000);
  }
}
// тексты страниц пачками по 50 (вежливо: пауза между запросами)
async function pageTexts(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const j = await api({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.slice(i, i + 50).join('|') });
    for (const p of j.query.pages) out[p.title] = p.revisions?.[0]?.slots?.main?.content || '';
    await sleep(400);
  }
  return out;
}

const raw = JSON.parse(fs.readFileSync(path.join(__dir, 'tasks_raw.json'), 'utf8'));
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"„“”]/g, '').replace(/\s+/g, ' ').trim();
const tdIds = new Set(raw.data.tasks.map((t) => t.id));
// квесты, которые tarkov.dev убрал НАМЕРЕННО (удалены из игры) — их с вики не возвращаем
const REMOVED_URL = 'https://raw.githubusercontent.com/the-hideout/tarkov-data-manager/main/src/tarkov-data-manager/data/removed_quests.json';
let removedIds = new Set();
try {
  removedIds = new Set(Object.keys(await (await fetch(REMOVED_URL)).json()));
} catch {
  console.warn('removed_quests.json недоступен — список удалённых квестов не учтён');
}
const tdNames = new Set(raw.data.tasks.map((t) => norm(t.name)));
const traderByName = new Map((raw.data.traders || []).map((t) => [norm(t.name), t]));

// ---- список квестов вики --------------------------------------------------
const titles = [];
let cont = {};
do {
  const j = await api({ action: 'query', list: 'categorymembers', cmtitle: 'Категория:Квесты', cmnamespace: '0', cmlimit: '500', ...cont });
  titles.push(...j.query.categorymembers.map((m) => m.title));
  cont = j.continue || null;
  await sleep(300);
} while (cont);
const pages = await pageTexts(titles);

// ---- разбор вики-разметки -----------------------------------------------
const noComments = (w) => w.replace(/<!--[\s\S]*?-->/g, '');
function infobox(w) {
  const m = /\{\{\s*(?:Инфобокс квест|Infobox quest)([\s\S]*?)\n\}\}/.exec(w);
  const f = {};
  if (!m) return f;
  for (const line of m[1].split('\n')) {
    const kv = /^\s*\|\s*([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv) f[kv[1].trim()] = kv[2].trim();
  }
  return f;
}
const field = (f, ...keys) => keys.map((k) => f[k]).find((v) => v != null && v !== '') || '';
// [[a|b]] -> b, [[a]] -> a, шаблоны и html — вон
function plain(s) {
  return String(s || '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const links = (s) => [...String(s || '').matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim());

const MONTHS = { января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5, июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11 };
function eventInfo(w) {
  const seasonal = /\{\{\s*Сезонный квест плашка\s*\|\s*info\s*=\s*([^}]*)\}\}/.exec(w);
  if (seasonal) return { kind: 'season', label: plain(seasonal[1]) };
  const ev = /\{\{\s*Ивент квест плашка\s*\|\s*info\s*=\s*([^}]*)\}\}/.exec(w);
  if (!ev) return /\{\{\s*Ивент квест/.test(w) ? { kind: 'event', label: 'ивент', date: null } : null;
  const label = plain(ev[1]);
  const d = /(\d{1,2})\s+([а-я]+)\s+(\d{4})/.exec(label);
  const date = d && MONTHS[d[2]] != null ? new Date(Date.UTC(+d[3], MONTHS[d[2]], +d[1])) : null;
  return { kind: 'event', label, date };
}

// убраны tarkov.dev намеренно, но не через removed_quests.json (а на вики не помечены удалёнными):
// «Конструктор-любитель» (Forklift Certified) — коммит data-manager a28a5b6 от 2026-09-05
const SKIP = new Set(['Конструктор-любитель']);
const now = Date.now();
const candidates = [];
for (const [title, text] of Object.entries(pages)) {
  const w = noComments(text);
  if (/\{\{\s*(?:Исторический контент|Historical content)\s*\}\}/i.test(w)) continue; // удалён из игры
  if (/Escape from Tarkov: Arena|Ивент квест Arena|Ивент квесты Арены/.test(w)) continue; // Арена — другая игра
  const f = infobox(w);
  if (/Арена/.test(field(f, 'локация', 'location'))) continue;
  const node = (/^[0-9a-f]{24}$/.exec(field(f, 'node')) || [])[0] || null;
  if ((node && tdIds.has(node)) || tdNames.has(norm(title))) continue; // есть в tarkov.dev
  if (node && removedIds.has(node)) continue; // tarkov.dev убрал как удалённый из игры
  if (SKIP.has(title)) continue;
  const ev = eventInfo(w);
  if (ev && ev.kind === 'event' && (!ev.date || now - ev.date > EVENT_MAX_AGE_DAYS * 864e5)) continue; // старый ивент
  const giverName = plain(field(f, 'выдает', 'given by'));
  const trader = traderByName.get(norm(giverName));
  if (!trader) continue; // без известного торговца в план не встроить
  candidates.push({ title, w, f, node, ev, trader });
}

// цели часто вынесены в шаблон «<Квест> (цель квеста)» — подгружаем их отдельно
const objTemplates = new Set();
for (const c of candidates) for (const m of c.w.matchAll(/\{\{([^{}|]+?\(цель квеста\))\s*(?:\|[^}]*)?\}\}/g)) objTemplates.add('Шаблон:' + m[1].trim());
const tplTexts = objTemplates.size ? await pageTexts([...objTemplates]) : {};

function objectivesSection(w) {
  const m = /==\s*Цел[ьи][^=\n]*==([\s\S]*?)(?:\n==[^=]|$)/.exec(w);
  if (!m) return '';
  // у шаблона целей отрезаем служебную часть (<noinclude>: «Смотри также», навигация)
  const tpl = (n) => noComments(tplTexts['Шаблон:' + n.trim()] || '').replace(/<noinclude>[\s\S]*?(<\/noinclude>|$)/gi, '');
  return m[1].replace(/\{\{([^{}|]+?\(цель квеста\))\s*(?:\|[^}]*)?\}\}/g, (_, n) => tpl(n));
}
function parseObjectives(w) {
  const out = [];
  for (const line of objectivesSection(w).split('\n')) {
    const lvl = (/^(\*+)/.exec(line) || ['', ''])[1].length;
    let txt = plain(line.replace(/^\*+/, ''));
    if (!txt || /^\{\||^\|/.test(line.trim()) || txt.length < 4) continue;
    const optional = /^\(опционально\)/i.test(txt);
    txt = txt.replace(/^\(опционально\)\s*/i, '');
    // количество: «… - 15», «(5 шт)», «x5»
    let count = null;
    const c1 = /\s[-–—]\s*(\d+)\s*$/.exec(txt) || /\((\d+)\s*шт\.?\)\s*$/.exec(txt) || /\s[xх×](\d+)\s*$/i.exec(txt);
    if (c1) {
      count = +c1[1];
      txt = txt.slice(0, c1.index).trim();
    }
    out.push({ text: txt, optional, sub: lvl > 1, count });
  }
  return out;
}

const quests = candidates.map((c) => {
  const prevRaw = field(c.f, 'предыдущий_квест', 'previous');
  return {
    id: c.node || 'wiki_' + norm(c.title).replace(/[^a-z0-9а-я]+/g, '_'),
    name: c.title,
    trader: { id: c.trader.id, name: c.trader.name },
    locations: links(field(c.f, 'локация', 'location')),
    previous: links(prevRaw),
    previousAny: /(^|[^а-яё])или([^а-яё]|$)/i.test(prevRaw), // «A или B» — достаточно любого из (\b не работает с кириллицей)
    previousAccept: /^\s*Принять/i.test(plain(prevRaw)), // «Принять [[X]]» — достаточно взять X
    kappa: /^Нужен/i.test(plain(field(c.f, 'для_каппы', 'reqkappa'))),
    level: +plain(field(c.f, 'уровень', 'level')) || null,
    event: c.ev ? c.ev.label : null,
    wiki: 'https://escapefromtarkov.fandom.com/ru/wiki/' + encodeURIComponent(c.title.replace(/ /g, '_')),
    objectives: parseObjectives(c.w),
  };
});

fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: API, license: 'CC BY-SA 3.0 (Escape from Tarkov Wiki, Fandom)', quests }, null, 1));
console.log(`wiki: ${titles.length} pages, ${quests.length} quests missing from tarkov.dev -> ${path.relative(path.join(__dir, '..'), OUT)}`);
for (const q of quests) console.log(`  ${q.trader.name.padEnd(13)} ${q.name}${q.event ? ' [' + q.event + ']' : ''} — целей: ${q.objectives.length}`);
