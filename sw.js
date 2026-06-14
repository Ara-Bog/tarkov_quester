// Service worker: держит сайт свежим без Ctrl+Shift+R.
// GitHub Pages отдаёт Cache-Control: max-age=600 на всё (включая HTML), поэтому браузер
// 10 минут не обращается к серверу. Здесь для каждого запроса своего origin мы всегда
// валидируем у сервера (cache: "no-cache" -> условный запрос по ETag: 304, если не менялось,
// или свежий файл, если менялось). Офлайн — отдаём из кэша.
const CACHE = "qv-1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET") return;
	let url;
	try {
		url = new URL(req.url);
	} catch {
		return;
	}
	if (url.origin !== self.location.origin) return; // внешние (assets.tarkov.dev и т.п.) — как есть

	e.respondWith(
		fetch(req, { cache: "no-cache" })
			.then((res) => {
				if (res && res.ok) {
					const copy = res.clone();
					caches
						.open(CACHE)
						.then((c) => c.put(req, copy))
						.catch(() => {});
				}
				return res;
			})
			.catch(() => caches.match(req)),
	);
});
