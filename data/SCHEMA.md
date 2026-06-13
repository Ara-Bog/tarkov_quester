# Схема `quests.json`

Сгенерировано `build/transform.mjs` из API tarkov.dev. Один объект:

```jsonc
{
  "meta":   { "source", "lang", "taskCount", "itemCount", "note" },
  "maps":   [ { "id": "map_1", "name": "Эпицентр" }, ... ],   // канонические локации (ночь/21+ слиты)
  "traders":[ { "id": "...",   "name": "Прапор" }, ... ],
  "items":  { "<itemId>": { "id", "name", "shortName", "icon", "img", "quest"? } },  // icon=маленькая, img=512px
  "tasks":  [ Task, ... ]
}
```

## Task

```jsonc
{
  "id": "657...",                  // id квеста (tarkov.dev)
  "name": "Что-то мне это напоминает...",
  "normalizedName": "...",
  "trader": "<traderId>",          // ссылка в meta.traders
  "faction": null | "USEC" | "BEAR",
  "minLevel": 10 | null,
  "kappa": true,                   // нужен для контейнера Каппа
  "lightkeeper": false,            // нужен для Смотрителя
  "restartable": false,
  "wiki": "https://...",
  "image": "https://...",
  "maps": ["map_3", ...],          // объединение локаций всех целей
  "requires": [                    // предусловия (граф разблокировки)
    { "task": "<taskId>", "status": ["complete"] }   // status: complete | active | failed
  ],
  "failedBy": ["<taskId>", ...],   // этот квест ПРОВАЛИТСЯ, если выполнить любой из перечисленных
  "objectives": [ Objective, ... ]
}
```

## Objective (цель)

```jsonc
{
  "id": "...",
  "type": "plantItem",             // исходный тип tarkov.dev (giveItem, mark, shoot, visit, extract, ...)
  "action": "Камера",              // человекочитаемое действие (RU): Найти/Сдать/Оставить/Маркер/Камера/Убить/Посетить/Выход/...
  "description": "Установить WI-FI Камеру ...",
  "optional": false,
  "maps": ["map_3"],               // на каких локациях выполняется
  "count": 1 | null,
  "target": "Выход Такси" | null,  // цель убийства / название выхода
  "bring": [                       // ВЗЯТЬ С СОБОЙ / ЗАЛОЖИТЬ (маркеры, камеры, оружие, заложить предмет)
    { "item": "<itemId>", "count": 2, "kind": "marker" }   // kind: plant|camera|marker|use|weapon
    // или выбор из нескольких:  { "anyOf": ["<id>", "<id>"], "count": 1, "kind": "weapon" }
  ],
  "handIn": [                      // НАЙТИ/КУПИТЬ И СДАТЬ торговцу
    { "item": "<itemId>", "count": 3, "fir": true, "kind": "handin" },   // fir=found-in-raid (нельзя купить)
    { "anyOf": ["<id>"], "count": 1, "fir": false, "kind": "handin" },   // один из нескольких
    { "category": "Передать любые предметы медицины…", "count": 3, "fir": true, "kind": "category" }, // когда подходит любой предмет категории
    { "item": "<weaponId>", "count": 1, "kind": "build" }                // собрать оружие на верстаке и сдать
  ],
  "keys": [                        // ключи, которые нужно взять (это тоже "взять с собой")
    "<itemId>",                    // один ключ
    { "anyOf": ["<id>", "<id>"] }  // один из нескольких
  ]
}
```

### Логика статуса (как считает приложение)

- `completed` — отмечен пользователем.
- `failed` — отмечен пользователем **или** авто-провал: выполнен какой-то квест из его `failedBy`.
- `available` — не выполнен/не провален и все `requires` удовлетворены
  (`complete`/`active` → нужный квест выполнен; `failed` → нужный квест провален).
- `locked` — иначе.

### Планировщик рейда

- **Взять с собой / заложить** — суммируются `bring` + `keys` целей выбранных квестов,
  сгруппированные по локации (`maps[0]`). Ключи = 1 шт. независимо от числа целей.
- **Найти / купить и сдать** — суммируются `handIn`. Пара `findItem`+`giveItem` одного
  предмета в одном квесте считается один раз (по максимуму), категории и сборки — отдельно.
- Группы `anyOf` («одно из») дают выбор в интерфейсе.

## `items.json` — полный каталог предметов

Отдельный файл для страницы «Список находок» (личные списки предметов).
`{ meta, items: [ { id, name, shortName, icon, img, cat } ] }` — ~5000 предметов.
Генерируется `node build/items.mjs`.
