// Guarda o app no aparelho para funcionar sem internet depois do primeiro acesso.
// Ao publicar uma versão nova, mude CACHE para o navegador trocar os arquivos.
const CACHE = "provas-girlie-1.0.2-web6";

const CODE = [
	"./",
	"index.html",
	"styles.css",
	"app.js",
	"manifest.webmanifest",
	"src/blocks.js",
	"src/docx_builder.js",
	"src/env.js",
	"src/generic_parser.js",
	"src/imageinfo.js",
	"src/models.js",
	"src/options.js",
	"src/moodle_parser.js",
	"src/ooxml.js",
	"src/pdf_extract.js",
	"src/pipeline.js",
	"src/printed_parser.js",
	"src/py.js",
	"src/textutils.js",
	"src/theme.js",
];
const HEAVY = [
	"vendor/jszip.min.js",
	"vendor/mupdf/mupdf.js",
	"vendor/mupdf/mupdf-wasm.js",
	"vendor/mupdf/mupdf-wasm.wasm",
	"assets/cover.png",
	"assets/template.zip",
	"assets/icons/apple-touch-icon.png",
	"assets/icons/favicon-32.png",
	"assets/icons/icon-192.png",
	"assets/icons/icon-512.png",
	"assets/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE).then((c) => c.addAll([...CODE, ...HEAVY])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(keys.filter((k) => k.startsWith("provas-girlie-") && k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
	const heavy = HEAVY.some((p) => req.url.endsWith(p));
	if (heavy) {
		// arquivos grandes e fixos: do cache primeiro
		event.respondWith(caches.match(req).then((hit) => hit || fetchAndStore(req)));
	} else {
		// código e página: da rede primeiro (pega atualizações), cache se estiver offline
		event.respondWith(fetchAndStore(req).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))));
	}
});

function fetchAndStore(req) {
	return fetch(req).then((res) => {
		if (res.ok) {
			const copy = res.clone();
			caches.open(CACHE).then((c) => c.put(req, copy));
		}
		return res;
	});
}
