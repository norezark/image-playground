# Image Playground — Copilot Instructions

## README の維持

`README.md` はプロジェクトの機能仕様書を兼ねています。  
以下の変更を加えた場合は、必ず `README.md` を同時に更新してください。

- 新しいエンドポイントを追加・削除・変更したとき → **API エンドポイント** セクション
- 生成パラメータ（フォームの項目）を追加・削除・変更したとき → **生成パラメータ** セクション
- UI の操作方法が変わったとき（ライトボックス操作など） → 該当セクション
- サーバーの起動方法・環境変数が変わったとき → **セットアップ** セクション
- ファイル構成が変わったとき → **ファイル構成** セクション
- 主要な機能を追加・削除したとき → **機能一覧** セクション

## プロジェクト概要

- **ランタイム**: Node.js v18 以上（外部 npm パッケージ不要）
- **エントリポイント**: `server.js`（HTTP サーバー + SSE + 生成キュー）
- **フロントエンド**: `public/index.html` + `public/script.js` + `public/style.css`
- **永続化**: `history.json`（生成履歴）、`public/images/`（生成画像）、`public/images/inputs/`（入力画像）
- **API**: `https://api.cometapi.com/v1/images/generations`（生成）、`https://api.cometapi.com/v1/images/edits`（編集）

## コード規約

- サーバー側は Node.js 組み込みモジュールのみ使用（`http`, `fs`, `path`, `crypto`）。npm パッケージを追加しないこと
- フロントエンドはバンドラー不使用のバニラ JS。フレームワークを導入しないこと
- DOM 操作には既存の `el(tag, attrs, children)` ヘルパーを使うこと
- SSE で全クライアントへ状態をブロードキャストする設計を維持すること
