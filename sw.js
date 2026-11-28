self.__PRECACHE__ = ["./","./.nojekyll","./assets/GLTFExporter-DjJ279Kb.js","./assets/GLTFLoader-ClqSiKi6.js","./assets/NotoSansJP-sub-Dxpr_DLo.ttf","./assets/OBJExporter-Bo7J-JQt.js","./assets/__vite-browser-external-BYdhicHK.js","./assets/html2canvas-C44O4g9k.js","./assets/index-BgTqaZOP.css","./assets/index-CU9-vy9q.js","./assets/index.es-CmQVK45t.js","./assets/jspdf.es.min-ChUS_1_B.js","./assets/localai.worker-CoKIQcaJ.js","./assets/node.browser-B5UkjvZU.js","./assets/node.browser-CUt3meDN.js","./assets/purify.es-CmFH7t8M.js","./assets/replicad_single-g5eiaENB.wasm","./assets/svg2pdf.es.min-Dj31KdvH.js","./icons/apple-touch-icon.png","./icons/favicon-64.png","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./index.html","./manifest.webmanifest"];
self.__BUILD__ = "mx07jncj";
// GDC GOOD DESIGN CAD オフライン用 Service Worker
// 一度開いたファイル（本体・CADエンジン・フォント）を端末に保存し、電波がなくても起動できるようにする
// PRECACHE はビルド時に全ファイルの一覧へ置き換わる
const PRECACHE = self.__PRECACHE__ || ["./", "./index.html"];
const CACHE = "gdc-" + (self.__BUILD__ || "dev");
// 古い版の保存だけを消す（端末内 AI のモデル "webllm/..." は消さない＝ダウンロードし直しにならない）
// 初めて入るときはすぐ有効に。すでに古い版が動いているときは、画面の「更新する」を押すまで待つ
// （作業中に勝手に切り替わると、古い画面が必要なファイルを読めなくなるため）
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => { if (!self.registration.active) return self.skipWaiting(); }));
});
self.addEventListener("message", (e) => { if (e.data && e.data.type === "skipWaiting") self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k.startsWith("gdc-")).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  const isPage = req.mode === "navigate";
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isPage) {
      // ページはネット優先（更新を反映）、オフライン時は保存版
      try { const r = await fetch(req); cache.put("./index.html", r.clone()); return r; }
      catch { return (await cache.match("./index.html", { ignoreVary: true })) || (await cache.match("./", { ignoreVary: true })); }
    }
    // アセット（ファイル名にハッシュ付き）は保存版を優先
    const hit = await cache.match(req, { ignoreVary: true, ignoreSearch: true });
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok) cache.put(req, r.clone());
    return r;
  })());
});
