// Генерирует data/story-quests.json (сюжетные главы) из русской вики Escape from Tarkov
// (escapefromtarkov.fandom.com/ru, лицензия CC BY-SA 3.0), раздел «Задачи» каждой главы.
//
// Разметка вики -> наша структура:
//   * задача / ** подзадача ((опционально) — необязательная)      -> objectives
//   '''Если …''' (несколько подряд)                               -> стадия с выбором варианта (variants)
//   одиночный '''Если …'''                                        -> вариант + «не мой случай»
//   '''Когда … / После …'''                                       -> обычные задачи (следующий шаг)
//   <hr/>                                                         -> конец условного блока
//   === Если … [Концовка «X»] ===                                 -> концовки (branches): ветка X = все
//                                                                    разделы с её значком, по порядку
// Стадии в линейной части режутся по «отчётным» задачам (Вернуться / Рассказать / Сообщить …).
// Совпадающие по тексту задачи прошлой версии сохраняют id (отметки пользователей не теряются),
// а также карты / FiR / предметы / подсказки. Метаданные глав (порядок, описание, награды) — из
// прошлой версии файла.
// Запуск: node build/story.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'story-quests.json');
const API = 'https://escapefromtarkov.fandom.com/ru/api.php';
const UA = 'tarkov-quester-build/1.0 (https://ara-bog.github.io/tarkov_quester/)';

const prev = JSON.parse(fs.readFileSync(FILE, 'utf8'));
// прежние концовки «Билета» -> концовки вики (чтобы сохранить выбор пользователей)
const BRANCH_ALIASES = { story_ticket: { refuse: 'survivor', warden: 'debtor', prapor: 'fallen' } };
const ENDING_ID = { Спаситель: 'savior', Должник: 'debtor', Падший: 'fallen', Выживший: 'survivor' };

// ---- вики ----------------------------------------------------------------
const titleOf = (q) => decodeURIComponent(q.wiki.split('/wiki/')[1]).replace(/_/g, ' ');
const params = { format: 'json', formatversion: '2', action: 'query', prop: 'revisions', rvprop: 'content|timestamp', rvslots: 'main', redirects: '1', titles: prev.quests.map(titleOf).join('|') };
const res = await fetch(API + '?' + new URLSearchParams(params), { headers: { 'User-Agent': UA } });
if (!res.ok) throw new Error('wiki API: HTTP ' + res.status);
const j = await res.json();
const redirect = Object.fromEntries((j.query.redirects || []).map((r) => [r.from, r.to]));
const pages = Object.fromEntries(j.query.pages.map((p) => [p.title, { text: p.revisions?.[0]?.slots?.main?.content || '', ts: p.revisions?.[0]?.timestamp }]));

// ---- текст -----------------------------------------------------------------
const plain = (s) =>
  String(s || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[\[(?:File|Файл):[^\]]*\]\]/gi, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/^\(опционально\)\s*/, '').replace(/[«»"„“”.,:;!()]/g, '').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 3));
function sim(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}
// короткий стабильный хэш (для id новых задач/стадий — не меняются при перегенерации)
function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return (h >>> 0).toString(36);
}
const ACTION = [
  [/^(найти и нейтрализовать|устранить|убить|нейтрализовать)/i, 'Убить'],
  [/^(найти|обыскать|раздобыть|получить|заполучить|достать)/i, 'Найти'],
  [/^(передать|отнести|сдать|продать)/i, 'Передать'],
  [/^(заложить|оставить|спрятать|установить|запустить)/i, 'Оставить'],
  [/^(посетить|осмотреть|изучить|проверить|попасть|добраться|войти|пройти)/i, 'Посетить'],
  [/^(выжить|выйти|эвакуироваться|сесть на катер|перейти)/i, 'Выход'],
  [/(разведцентр|солнечная батарея|\bУР\s*\d)/i, 'Убежище'],
  [/^(поднять|улучшить|прокачать)/i, 'Прокачать'],
];
const actionOf = (t) => (ACTION.find(([re]) => re.test(t)) || [, 'Действие'])[1];
// задача, которой обычно заканчивается сюжетный шаг — после неё начинаем новую стадию
const CLOSES = /^(вернуться|рассказать|сообщить|доложить|дождаться|отнести|передать\s.*(механик|прапор|терапевт|лыжник|барахольщик|егер|миротворц|реф|скупщик|смотрител|мехвод|керман))/i;
const MAX_STAGE = 7;

// ---- разбор раздела «Задачи» в токены ----------------------------------
function tokens(wikitext) {
  const m = /==\s*(?:Задачи|Цел[ьи])[^=\n]*==([\s\S]*?)(?:\n==[^=]|$)/.exec(wikitext);
  if (!m) return [];
  const out = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^===/.test(line)) {
      const endings = [...line.matchAll(/Концовка «([^»]+)»/g)].map((x) => x[1]);
      out.push({ t: 'h3', label: plain(line.replace(/^=+|=+$/g, '')), endings });
    } else if (/^<hr\s*\/?>$/i.test(line)) out.push({ t: 'hr' });
    else if (/^'''.*'''$/.test(line)) out.push({ t: 'cond', label: plain(line) });
    else if (/^:/.test(line)) out.push({ t: 'note', text: plain(line.replace(/^:+/, '')) });
    else if (/^\*/.test(line)) {
      const lvl = /^\*+/.exec(line)[0].length;
      let text = plain(line.replace(/^\*+/, ''));
      if (!text) continue;
      const optional = /^\(опционально\)/i.test(text);
      text = text.replace(/^\(опционально\)\s*/i, '');
      out.push({ t: 'obj', text, optional, sub: lvl > 1, fir: /найден\S* в рейде/i.test(plain(line)) });
    }
  }
  return out;
}

// ---- сборка стадий --------------------------------------------------------
function makeBuilder(qid, oldObjs) {
  const used = new Set();
  const seen = new Map();
  function objective(tk) {
    // лучшее совпадение среди задач прошлой версии (ещё не использованных)
    let best = null, bs = 0;
    for (const o of oldObjs) {
      if (used.has(o.id)) continue;
      const s = sim(o.desc, tk.text);
      if (s > bs) { bs = s; best = o; }
    }
    const n = norm(tk.text);
    const k = (seen.get(n) || 0) + 1;
    seen.set(n, k);
    const out = { id: '', action: actionOf(tk.text), desc: tk.text };
    if (best && bs >= 0.6) {
      used.add(best.id);
      out.id = best.id;
      for (const f of ['action', 'maps', 'fir', 'handIn', 'count', 'hint']) if (best[f] != null) out[f] = best[f];
    } else out.id = `${qid}-${hash(n)}${k > 1 ? '-' + k : ''}`;
    if (tk.optional) out.optional = true;
    if (tk.fir) out.fir = true;
    return out;
  }
  const short = (s) => (s.length > 64 ? s.slice(0, 62).trimEnd() + '…' : s);
  // tokens -> stages[]
  function build(tks) {
    const stages = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.objectives.length) stages.push(cur);
      cur = null;
    };
    const start = (title) => (cur = { id: '', title, objectives: [] });
    for (let i = 0; i < tks.length; i++) {
      const tk = tks[i];
      if (tk.t === 'hr') { flush(); continue; }
      if (tk.t === 'note') {
        const last = cur && cur.objectives[cur.objectives.length - 1];
        if (last) last.hint = (last.hint ? last.hint + ' ' : '') + tk.text;
        continue;
      }
      if (tk.t === 'obj') {
        // стадия переполнена — новая начинается со следующей задачи верхнего уровня
        if (!tk.sub && cur && cur.objectives.length >= MAX_STAGE) flush();
        if (!cur) start(short(tk.text));
        cur.objectives.push(objective(tk));
        if (!tk.sub && CLOSES.test(tk.text)) {
          // подзадачи (**) следующей строкой остаются в этой же стадии
          if (!(tks[i + 1] && tks[i + 1].t === 'obj' && tks[i + 1].sub)) flush();
        }
        continue;
      }
      if (tk.t === 'cond') {
        flush();
        // «Когда…/После…» — следующий шаг, а не выбор
        if (/^(когда|после)/i.test(tk.label)) { start(short(tk.label)); continue; }
        // группа соседних «Если…» блоков
        const variants = [];
        while (i < tks.length && tks[i].t === 'cond' && !/^(когда|после)/i.test(tks[i].label)) {
          const v = { id: '', label: tks[i].label, objectives: [] };
          i++;
          while (i < tks.length && (tks[i].t === 'obj' || tks[i].t === 'note')) {
            if (tks[i].t === 'obj') v.objectives.push(objective(tks[i]));
            else if (v.objectives.length) {
              const last = v.objectives[v.objectives.length - 1];
              last.hint = (last.hint ? last.hint + ' ' : '') + tks[i].text;
            }
            i++;
          }
          v.id = 'v' + hash(norm(v.label));
          variants.push(v);
        }
        i--; // на следующей итерации обработаем hr/h3/прочее
        if (variants.length === 1) variants.push({ id: 'vskip', label: 'Не мой случай — пропустить', objectives: [] });
        stages.push({ id: '', title: 'Развилка по условию', objectives: [], variants });
        continue;
      }
    }
    flush();
    for (const st of stages) st.id = 's' + hash(norm(st.title + '|' + (st.objectives[0]?.desc || st.variants?.[0]?.label || '')));
    return stages;
  }
  return { build, used };
}

// ---- главы -------------------------------------------------------------
const report = [];
const quests = prev.quests.map((q) => {
  const page = pages[redirect[titleOf(q)] || titleOf(q)];
  const tks = tokens(page?.text || '');
  if (!tks.some((t) => t.t === 'obj')) {
    report.push(`${q.name}: на вики нет задач — оставлена прежняя версия`);
    return q;
  }
  const oldObjs = [...(q.stages || []), ...(q.branches || []).flatMap((b) => b.stages)].flatMap((s) => [
    ...s.objectives,
    ...(s.variants || []).flatMap((v) => v.objectives),
  ]);
  const { build, used } = makeBuilder(q.id, oldObjs);
  const firstH3 = tks.findIndex((t) => t.t === 'h3');
  const common = firstH3 < 0 ? tks : tks.slice(0, firstH3);
  const out = { ...q, stages: build(common), wikiEdited: page.ts };
  delete out.stub;
  delete out.branches;
  if (firstH3 >= 0) {
    // разделы-концовки: ветка концовки = все разделы с её значком, по порядку
    const sections = [];
    for (let i = firstH3; i < tks.length; i++) {
      if (tks[i].t === 'h3') sections.push({ ...tks[i], body: [] });
      else sections[sections.length - 1].body.push(tks[i]);
    }
    const endings = [...new Set(sections.flatMap((s) => s.endings))];
    out.branches = endings.map((e) => {
      const secs = sections.filter((s) => s.endings.includes(e));
      return {
        id: ENDING_ID[e] || 'b' + hash(e),
        label: `Концовка «${e}»`,
        path: secs.map((s) => s.label.replace(/\s*Концовка.*$/, '').trim()),
        stages: build(secs.flatMap((s) => [...s.body, { t: 'hr' }])),
      };
    });
    if (BRANCH_ALIASES[q.id]) out.branchAliases = BRANCH_ALIASES[q.id];
  }
  const count = (st) => st.reduce((n, s) => n + s.objectives.length + (s.variants || []).reduce((m, v) => m + v.objectives.length, 0), 0);
  const total = count(out.stages) + (out.branches || []).reduce((n, b) => n + count(b.stages), 0);
  report.push(`${q.name}: стадий ${out.stages.length}${out.branches ? ' + концовки ' + out.branches.map((b) => b.label.replace('Концовка ', '')).join(', ') : ''}, задач ${total}, сохранено id: ${used.size}/${oldObjs.length}`);
  return out;
});

const data = {
  ...prev,
  version: (prev.version || 1) + 1,
  note: 'Сюжетные главы. Генерируется build/story.mjs из русской вики Escape from Tarkov (CC BY-SA 3.0).',
  source: 'https://escapefromtarkov.fandom.com/ru/',
  generatedAt: new Date().toISOString(),
  quests,
};
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(ROOT, 'data', 'story-quests.js'), 'window.__STORY__=' + JSON.stringify(data) + ';\n', 'utf8');
console.log(report.join('\n'));
