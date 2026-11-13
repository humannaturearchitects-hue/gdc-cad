self.__PRECACHE__ = ["./","./.nojekyll","./assets/GLTFExporter-CInO_Kaa.js","./assets/NotoSansJP-sub-Dxpr_DLo.ttf","./assets/OBJExporter-CIEzyXdi.js","./assets/__vite-browser-external-CpI8Momt.js","./assets/html2canvas-D8lqCBYx.js","./assets/index-CyK4XF7l.js","./assets/index-DKgIqShY.css","./assets/index.es-DwUq_x4o.js","./assets/jspdf.es.min-qRr83W-X.js","./assets/node.browser-7k1oE-zW.js","./assets/node.browser-BfEAUq4d.js","./assets/purify.es-CmFH7t8M.js","./assets/replicad_single-g5eiaENB.wasm","./assets/svg2pdf.es.min-tg_M52ze.js","./icons/apple-touch-icon.png","./icons/favicon-64.png","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./index.html","./manifest.webmanifest"];
self.__BUILD__ = "mwdjc2x6";
// GDC GOOD DESIGN CAD オフライン用 Service Worker
// 一度開いたファイル（本体・CADエンジン・フォント）を端末に保存し、電波がなくても起動できるようにする
// PRECACHE はビルド時に全ファイルの一覧へ置き換わる
const PRECACHE = self.__PRECACHE__ || ["./", "./index.html"];
const CACHE = "gdc-" + (self.__BUILD__ || "dev");
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
