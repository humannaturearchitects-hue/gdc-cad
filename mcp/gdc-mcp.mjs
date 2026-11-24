#!/usr/bin/env node
// GDC GOOD DESIGN CAD — AI エージェント接続（MCP サーバー）v0.18.0
//
// AI エージェント（Claude Code など）から、GDC の画面と同じ操作を実行するための入口です。
//   エージェント ⇄（MCP: 標準入出力）⇄ このサーバー ⇄（http://127.0.0.1 のみ）⇄ ブラウザで開いた GDC の画面
// ・形を作るのは画面（GDC 本体）です。だから AI の操作は画面のタイムラインに 1 手ずつ残り、人が後から直せます
// ・このサーバーは 127.0.0.1 だけで待ち受け、外部には何も送りません。合言葉（毎回ちがう）のない接続は断ります
// ・依存パッケージなし（Node.js 18 以降だけで動きます）
//
// 使い方:  node mcp/gdc-mcp.mjs [--port 47830] [--app <GDC のフォルダ>] [--out <書き出し先>] [--open] [--headless]
//   --open      既定のブラウザで GDC の画面を開く
//   --headless  画面を出さずに動かす（Playwright と Chromium が入っているときだけ。テスト・自動処理用）
//   --allow-origin https://xxx.github.io  公開版（GitHub Pages）の画面からつなぐのを許す（Chrome のみ・任意）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const VERSION = "0.18.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);
const PORT = +(opt("--port", process.env.GDC_MCP_PORT || 47830));
const OUT = path.resolve(opt("--out", process.env.GDC_MCP_OUT || path.join(process.cwd(), "gdc-output")));
const ALLOW = argv.flatMap((a, i) => (a === "--allow-origin" && argv[i + 1] ? [argv[i + 1].replace(/\/+$/, "")] : []));
const TOKEN = process.env.GDC_MCP_TOKEN && /^[0-9a-f]{16,64}$/i.test(process.env.GDC_MCP_TOKEN) ? process.env.GDC_MCP_TOKEN : crypto.randomBytes(16).toString("hex");
const APP = (() => {
  const given = opt("--app", process.env.GDC_APP_DIR);
  const cands = given ? [path.resolve(given)] : [path.resolve(here, ".."), path.resolve(here, "../dist")];
  for (const c of cands) if (fs.existsSync(path.join(c, "index.html")) && fs.existsSync(path.join(c, "assets"))) return c;
  return null;
})();
const URL0 = `http://127.0.0.1:${PORT}/?agent=${TOKEN}`;
const log = (...a) => process.stderr.write("[gdc-mcp] " + a.join(" ") + "\n");

// ------------------------------------------------------------ 道具（ツール）の定義
const num = { type: "number" };
const TOOLS = [
  { name: "get_state", description: "今のモデルの状態を読む: ボディ一覧（名前・体積 mm³・重心 mm・外形・大きさ）、タイムラインの手順と寸法（AI が作ったものは by: ai）、スケッチの拘束状態（完全拘束/拘束不足・自由度）、パラメータ。単位は mm。",
    inputSchema: { type: "object", properties: { bodies: { type: "array", items: { type: "string" }, description: "調べるボディ名（省略ですべて）" } } } },
  { name: "create_box", description: "直方体（板・箱）を作る。position は外形のいちばん小さい角 [x,y,z]。Z が上。タイムラインに 1 手残る。",
    inputSchema: { type: "object", properties: { width: { description: "X 方向の幅 mm（数値かパラメータ式）" }, depth: { description: "Y 方向の奥行 mm" }, height: { description: "Z 方向の高さ（厚さ）mm" }, position: { type: "array", items: {}, minItems: 3, maxItems: 3 }, name: { type: "string", description: "ボディ名（空白なし）" } }, required: ["width", "depth", "height"] } },
  { name: "create_sketch_extrude", description: "スケッチ（XY/XZ/YZ 平面、またはボディの面）に長方形・円を描いて押し出す。図形の数値は寸法拘束として記録され、画面で開くと完全拘束。operation: new（新規ボディ）/join（結合）/cut（切り取り）/intersect。through_all=true で突き抜けて切り取り。",
    inputSchema: { type: "object", properties: {
      plane: { description: "\"XY\"（既定）/\"XZ\"/\"YZ\"、または {\"face\":\"上面\",\"body\":\"ボディ名\"}（面: 上面・下面・前面・背面・左面・右面）" },
      offset: { ...num, description: "平面を法線方向にずらす mm" },
      profiles: { type: "array", description: "[{type:\"rect\",x,y,width,height,center?}, {type:\"circle\",cx,cy,diameter}]（スケッチ座標 mm。center:true なら x,y が中心）", items: { type: "object" } },
      distance: { description: "押し出す距離 mm（数値かパラメータ式）" }, operation: { type: "string", enum: ["new", "join", "cut", "intersect"] },
      symmetric: { type: "boolean" }, reverse: { type: "boolean" }, through_all: { type: "boolean" }, name: { type: "string", description: "新しいボディの名前" } }, required: ["profiles"] } },
  { name: "create_hole", description: "ボディの面に穴をあける（既定は貫通）。positions は面の角からの座標 [[x,y],...]（上面・下面は X,Y／前面・背面は X,Z／左面・右面は Y,Z。どの面でも小さい側の角から）。from:\"origin\" なら原点からの座標。",
    inputSchema: { type: "object", properties: { body: { type: "string" }, face: { type: "string", enum: ["上面", "下面", "前面", "背面", "左面", "右面"] }, diameter: num, positions: { type: "array", items: { type: "array", items: num } }, depth: { ...num, description: "深さ mm（省略で貫通）" }, from: { type: "string", enum: ["corner", "origin"] } }, required: ["body", "diameter", "positions"] } },
  { name: "modify_feature", description: "既にある手順の寸法を変えて再計算する。target は手順の名前（押し出し1・穴1・直方体1・スケッチ1）かボディ名。set の例: 押し出し {thickness|distance: 8}／直方体 {width, depth, height, position}／穴 {diameter, depth, through, positions}／円柱 {diameter, height}／フィレット {radius}。スケッチは entity（長方形1・円2 など）と set {width, height, x, y, diameter, cx, cy}。再計算でエラーになったら変更を取り消してエラーを返す。",
    inputSchema: { type: "object", properties: { target: { type: "string" }, set: { type: "object" }, entity: { type: "string" } }, required: ["target", "set"] } },
  { name: "run_commands", description: "画面の「AI に頼む」と同じ GDC コマンド（1 行 1 指示。例: 板 幅600 奥行400 厚さ20 名前 床板 ／ フィレット R5 縦の辺 床板 ／ 材料 床板 アルミ）をまとめて実行する。途中で失敗したらこの道具の操作をすべて取り消す。書き方は docs/コマンドの使い方.txt。",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "undo", description: "直前の操作を取り消す（画面の Ctrl+Z と同じ。AI の道具 1 回 = 1 手）。", inputSchema: { type: "object", properties: { steps: num } } },
  { name: "export_file", description: "STEP または STL で書き出し、このパソコンのファイルに保存してパスを返す。STEP は形状エンジンで読み戻して体積が一致するかを確認する（verify）。",
    inputSchema: { type: "object", properties: { format: { type: "string", enum: ["step", "stl"] }, bodies: { type: "array", items: { type: "string" } }, file_name: { type: "string" }, verify: { type: "boolean" } }, required: ["format"] } },
  { name: "save_project", description: "今のモデルを .kcad（GDC のファイル。履歴付き）で保存してパスを返す。画面の「ファイルから開く」で開ける。", inputSchema: { type: "object", properties: { file_name: { type: "string" } } } },
];
const INSTRUCTIONS = `GDC GOOD DESIGN CAD（ブラウザで動くパラメトリック 3D CAD）を操作する道具です。単位は mm、Z が上。
- 道具は開いている GDC の画面で、画面と同じ操作として実行されます。1 回の道具 = タイムラインの手順（元に戻す 1 回）。失敗した道具はモデルを変えずにエラーを返します。
- まず get_state で今の状態を確かめてから操作してください。既にある形を直すときは作り直さず modify_feature を使います。
- 画面がまだ開いていないときは、案内された URL（${URL0.replace(TOKEN, "<合言葉>")}）を人に開いてもらいます。`;

// ------------------------------------------------------------ 画面とのやり取り（127.0.0.1 のロングポーリング）
const queue = [];          // 画面に渡す前の仕事
const waiting = new Map(); // id → { resolve, timer }
let pollers = [];          // 待っている画面の問い合わせ
let lastSeen = 0, seq = 0, tabVersion = null;
let activeTab = null;      // つないでいる画面（タブ）は 1 つだけ（2 つのタブに仕事が分かれないように）
const connected = () => Date.now() - lastSeen < 40000;

function dispatch() {
  while (queue.length && pollers.length) {
    const job = queue.shift(), res = pollers.shift();
    clearTimeout(res.__t);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(res.__origin) });
    res.end(JSON.stringify(job));
  }
}
function sendToTab(tool, args, ms = 180000) {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); const i = queue.findIndex((j) => j.id === id); if (i >= 0) queue.splice(i, 1); resolve({ ok: false, error: `GDC の画面から ${ms / 1000} 秒たっても返事がありません` }); }, ms);
    waiting.set(id, { resolve, timer });
    queue.push({ id, tool, args });
    dispatch();
  });
}
async function waitForTab(ms) {
  const t0 = Date.now();
  while (!connected() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 250));
  return connected();
}

function cors(origin) {
  if (origin && ALLOW.includes(origin)) return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", Vary: "Origin" };
  return {};
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const origin = req.headers.origin || "";
  const sameOrigin = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
  // 別のサイトのページからの問い合わせは断る（許可した公開版だけ例外）
  if (!sameOrigin && !ALLOW.includes(origin)) { res.writeHead(403); return res.end("forbidden origin"); }
  if (req.method === "OPTIONS") { res.writeHead(204, { ...cors(origin), "Access-Control-Allow-Methods": "GET, POST" }); return res.end(); }
  if (u.pathname.startsWith("/gdc-agent/")) {
    if (u.searchParams.get("token") !== TOKEN) { res.writeHead(403, cors(origin)); return res.end("bad token"); }
    if (u.pathname === "/gdc-agent/poll" && req.method === "GET") {
      const tab = u.searchParams.get("tab") || "";
      if (activeTab && tab !== activeTab && connected()) { res.writeHead(409, cors(origin)); return res.end("another tab is connected"); }
      if (tab !== activeTab) { activeTab = tab; log("画面がつながりました"); }
      lastSeen = Date.now(); tabVersion = u.searchParams.get("v") || tabVersion;
      res.__origin = origin;
      res.__t = setTimeout(() => { pollers = pollers.filter((p) => p !== res); res.writeHead(204, cors(origin)); res.end(); }, 20000);
      req.on("close", () => { clearTimeout(res.__t); pollers = pollers.filter((p) => p !== res); });
      pollers.push(res);
      return dispatch();
    }
    if (u.pathname === "/gdc-agent/result" && req.method === "POST") {
      lastSeen = Date.now();
      const chunks = []; let size = 0;
      req.on("data", (c) => { size += c.length; if (size > 300 * 1024 * 1024) req.destroy(); else chunks.push(c); });
      req.on("end", () => {
        let msg; try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400, cors(origin)); return res.end("bad json"); }
        const w = waiting.get(msg.id);
        if (w) { clearTimeout(w.timer); waiting.delete(msg.id); w.resolve(msg); }
        res.writeHead(204, cors(origin)); res.end();
      });
      return;
    }
    res.writeHead(404); return res.end();
  }
  // GDC 本体のファイル（オフラインで、このフォルダから配る）
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  if (!APP) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("GDC の本体（index.html と assets）が見つかりません。--app でフォルダを指定してください"); }
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(APP, "." + rel);
  if (!file.startsWith(APP + path.sep) && file !== APP) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

// ------------------------------------------------------------ 画面を開く
let headless = null, opening = null;
function openTab() { if (!opening) opening = openTabInner().catch((e) => { log(e.message); opening = null; }); return opening; }
async function openTabInner() {
  if (flag("--headless")) {
    if (headless) return;
    let pw;
    try { pw = await import("playwright"); } catch { try { const { createRequire } = await import("node:module"); pw = createRequire(path.join(process.cwd(), "x.js"))("playwright"); } catch { log("--headless には Playwright が必要です（npm i playwright）"); return; } }
    const chromium = pw.chromium || (pw.default && pw.default.chromium);
    const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 850 } })).newPage();
    page.on("pageerror", (e) => log("画面のエラー: " + e.message));
    await page.goto(URL0);
    headless = { browser, page };
    log("画面を出さずに GDC を開きました");
  } else if (flag("--open")) {
    const cmd = process.platform === "darwin" ? ["open", [URL0]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", URL0]] : ["xdg-open", [URL0]];
    try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref(); } catch { /* */ }
  }
}

// ------------------------------------------------------------ 道具の実行
async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return toolResult({ error: `知らない道具です: ${name}` }, true);
  if (!connected()) {
    await openTab();
    const ok = await waitForTab(flag("--headless") ? 120000 : 45000);
    if (!ok) return toolResult({ error: `GDC の画面がつながっていません。ブラウザで ${URL0} を開いてください（開いた画面の上に「🤖 AI 接続」と出ればつながっています）。` }, true);
  }
  const r = await sendToTab(name, args || {});
  if (!r.ok) return toolResult({ error: r.error }, true);
  const out = r.result || {};
  // 画面から届いたファイルを、このパソコンに保存する
  if (out.file && out.file.base64) {
    fs.mkdirSync(OUT, { recursive: true });
    const safe = String(out.file.name || "output").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");
    const p = path.join(OUT, safe);
    fs.writeFileSync(p, Buffer.from(out.file.base64, "base64"));
    out.path = p;
    delete out.file;
  }
  return toolResult(out, false);
}
function toolResult(obj, isError) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError };
}

// ------------------------------------------------------------ MCP（JSON-RPC 2.0・1 行 1 メッセージ）
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
async function onMessage(m) {
  if (!m || m.jsonrpc !== "2.0") return;
  const reply = (result) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code, message) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  try {
    switch (m.method) {
      case "initialize":
        return reply({ protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "gdc-cad", title: "GDC GOOD DESIGN CAD", version: VERSION }, instructions: INSTRUCTIONS });
      case "notifications/initialized": case "notifications/cancelled": return;
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": return reply(await callTool(m.params && m.params.name, m.params && m.params.arguments));
      case "resources/list": return reply({ resources: [] });
      case "prompts/list": return reply({ prompts: [] });
      default: return fail(-32601, "method not found: " + m.method);
    }
  } catch (e) { return fail(-32603, e.message || String(e)); }
}

server.on("error", (e) => { log(e.code === "EADDRINUSE" ? `ポート ${PORT} は使われています。--port で別の番号にしてください` : e.message); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => {
  log(`v${VERSION} 待ち受け中（この端末の中だけ）: ${URL0}`);
  log(APP ? `GDC 本体: ${APP}` : "GDC 本体が見つかりません（--app で指定）");
  log(`書き出し先: ${OUT}`);
  if (flag("--open") || flag("--headless")) openTab().catch((e) => log(e.message));
});
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
    onMessage(m);
  }
});
process.stdin.on("end", async () => { if (headless) await headless.browser.close().catch(() => {}); process.exit(0); });
