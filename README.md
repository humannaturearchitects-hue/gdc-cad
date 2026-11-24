# GDC GOOD DESIGN CAD

ブラウザで動く 3D CAD（パソコン・iPhone 対応）。v0.18.0

- 使う: このリポジトリの GitHub Pages の URL を Safari / Chrome で開く（iPhone は「共有 → ホーム画面に追加」）
- 設計データは使っているブラウザの中だけに保存され、外部には送られません
- v0.18 の新機能: スケッチの拘束状態の表示（完全拘束／拘束不足／過拘束・矛盾・自由度）、AI エージェント接続（MCP）
- AI エージェント接続（MCP）: `node mcp/gdc-mcp.mjs`（Node.js 18 以降・依存なし・127.0.0.1 のみ）。使い方は `mcp/README.md`
- ソースコード: `source/gdc-cad-src.zip`、同梱ソフトのライセンス: `THIRD_PARTY_LICENSES.txt`
