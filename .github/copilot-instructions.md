# Image Playground — Copilot Instructions

## ドキュメントの維持

ドキュメントは用途別に 2 ファイルに分かれています。

- **`README.md`**（利用者向け）：セットアップ・使い方・パラメータ説明
- **`ARCHITECTURE.md`**（開発者向け）：内部設計・ファイル構成・API エンドポイント・コード規約

以下の変更を加えた場合は、対応するドキュメントを同時に更新してください。

- 新しいエンドポイントを追加・削除・変更したとき → `ARCHITECTURE.md` の **API エンドポイント** セクション
- 生成パラメータ（フォームの項目）を追加・削除・変更したとき → `README.md` の **生成パラメータ** セクション
- UI の操作方法が変わったとき（ライトボックス操作など） → `README.md` の該当セクション
- サーバーの起動方法・環境変数が変わったとき → `README.md` の **セットアップ** セクション
- ファイル構成が変わったとき → `ARCHITECTURE.md` の **ファイル構成** セクション
- 主要な機能を追加・削除したとき → `README.md` の **使い方** セクション
- サーバー内部設計（SSE・キュー・DB）が変わったとき → `ARCHITECTURE.md` の該当セクション

## プロジェクト概要

- **ランタイム**: Node.js v18 以上（外部 npm パッケージ不要）
- **エントリポイント**: `server.js`（HTTP サーバー + SSE + 生成キュー）
- **フロントエンド**: `public/index.html` + `public/script.js` + `public/style.css`
- **永続化**: `history.db`（生成履歴）、`public/images/`（生成画像）、`public/images/inputs/`（入力画像）
- **API**: `https://api.cometapi.com/v1/images/generations`（生成）、`https://api.cometapi.com/v1/images/edits`（編集）

## コード規約

- サーバー側は Node.js 組み込みモジュールのみ使用（`http`, `fs`, `path`, `crypto`）。npm パッケージを追加しないこと
- フロントエンドはバンドラー不使用のバニラ JS。フレームワークを導入しないこと
- 新規 DOM 要素の生成には `public/utils.js` で定義されている `el(tag, attrs, children)` ヘルパーを使うこと。`document.createElement` を直接呼び出さないこと。既存要素の取得（`getElementById`・`querySelector` 等）はそのまま使用してよい
- SSE で全クライアントへ状態をブロードキャストする設計を維持すること
