> [!NOTE]
> このプロジェクトは全てGitHub Copilot製のため、不自然なドキュメントやコードが存在する可能性があります。

# Image Playground

OpenAI CometAPI および Google Gemini の画像生成 API を手軽に試せるローカル Web アプリです。  
プロンプトと各種パラメータを入力して画像を生成し、結果をリアルタイムで複数デバイスと共有できます。

## 必要環境

- **Node.js v22.5 以上**（`fetch` / `FormData` / `Blob` / `node:sqlite` の組み込み実装を使用）
- 外部 npm パッケージは不要

## セットアップ

### 1. API キーの設定

プロジェクトルートに `.env` ファイルを作成し、使用する API のキーを記載します。
**少なくとも一方**が設定されていれば起動できます。

```
# CometAPI （OpenAI 互換プロキシ）
OPENAI_API_KEY=your_cometapi_key_here

# Nano Banana （Google Gemini ネイティブ画像生成）
NANO_BANANA_API_KEY=your_gemini_api_key_here
```

環境変数として直接渡すことも可能です。

```bash
OPENAI_API_KEY=xxx NANO_BANANA_API_KEY=yyy node server.js
```

両方が未設定の場合、サーバーは起動時にエラーを出力して終了します。
片方のみ設定されている場合は警告を表示し、設定済み API のモデルのみ使用できます。

### 2. サーバー起動

```bash
node server.js
```

ブラウザで `http://localhost:8000` を開きます。

ポートを変更したい場合は環境変数で指定します。

```bash
PORT=8080 node server.js
```

最大リトライ回数を変更する場合も環境変数で指定します（デフォルト: 10）。

```bash
MAX_RETRIES=5 node server.js
```

---

## バックグラウンド起動（ターミナル非依存）

ターミナルを閉じてもサーバーを継続稼働させたい場合は、`server.ps1` を使います。  
プロセス ID は `server.pid` に保存され、停止・再起動・状態確認に使われます。

> **初回のみ** — スクリプト実行には PowerShell の実行ポリシー変更が必要な場合があります。
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

```powershell
.\server.ps1 start    # バックグラウンドで起動
.\server.ps1 stop     # 停止
.\server.ps1 restart  # 再起動
.\server.ps1 status   # 稼働状況・PID・起動時刻を表示（引数省略時のデフォルト）
```

`server.pid` はサーバーが停止すると自動的に削除されます。

---

## ファイル構成

```
image-playground/
├── server.js          # Node.js HTTP サーバー
├── server.ps1         # サーバー管理スクリプト (start/stop/restart/status)
├── history.db         # 生成履歴（SQLite、自動生成）
├── server.pid         # バックグラウンド起動時の PID（自動生成）
└── public/
    ├── index.html
    ├── style.css
    ├── script.js      # エントリポイント（SSE・フォーム送信・状態管理）
    ├── utils.js       # DOM ヘルパー (el)
    ├── image-input.js # 入力画像管理（ドロップゾーン・ファイル選択）
    ├── size-selector.js   # サイズ計算・ビジュアルセレクタ
    ├── price-estimate.js  # 料金見積もり
    ├── history.js     # 生成履歴のレンダリング
    ├── api.js         # サーバー API リクエスト
    ├── lightbox.js    # ライトボックス（ズーム・パン・タッチ）
    └── images/        # 生成画像（自動生成）
        └── inputs/    # 入力画像（自動生成）
```

---

## 機能一覧

### 1. 画像生成

#### テキストからの生成（Generations）

- プロンプトを入力して Generate ボタンを押すと、OpenAI の `/v1/images/generations` API を呼び出す。
- リクエストは即座に受理（HTTP 202）され、生成は非同期で行われる。
- 結果は `public/images/` にファイル保存され、URL パスとして履歴に記録される。

#### 入力画像を使った編集（Edits）

- フォーム上部のドロップゾーンに画像をドラッグ＆ドロップ、またはファイル選択で最大 16 枚の入力画像をアップロードできる。
- 入力画像が 1 枚以上ある場合は `/v1/images/edits` API を使用する編集モードに切り替わる。
- アップロードした画像は `public/images/inputs/` に保存される。
- `gpt-image-2` / `gpt-image-2-all` が選択されている場合、Edits エンドポイントでは自動的に `gpt-image-1.5` にフォールバックする。

---

### 2. 生成パラメータ

フォームから以下のパラメータを設定できる。

| パラメータ | 値の例 | 説明 |
|---|---|---|
| **Model** | CometAPI: `gpt-image-2-all`, `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini` / Nano Banana: `gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview` | 使用するモデル |
| **Number of images** | 1〜8 | 1リクエストで生成する枚数（Gemini はモデル内部で複数呼び出し） |
| **Size** | 向き（Auto / 正方形 / 横 / 縦）× アスペクト比（5:4 / 4:3 / 3:2 / 16:9 / 21:9 / 2:1 / 3:1）× 大きさ（S=1024px / M=1536px / L=2048px / XL=2880px）の組み合わせで指定（CometAPI）。Nano Banana では向き＋アスペクト比から Gemini の `aspectRatio` パラメータに変換（`5:4`/`4:5`・`4:3`/`3:4`・`3:2`/`2:3`・`16:9`/`9:16`・`21:9` のみ対応、`2:1`/`3:1` は Gemini 選択時は非表示） | CometAPI の出力解像度 / Nano Banana のアスペクト比 |
| **Image Size** *(Nano Banana のみ)* | `512` / `1K`（デフォルト） / `2K` / `4K` | Gemini 画像の最大辺ピクセル数（`gemini-2.5-flash-image` は非対応） |
| **Quality** | `low` / `medium` / `high` | 画質（CometAPI のみ） |
| **Input fidelity** | `low` / `high` | 入力画像の再現度（Edits モード・ CometAPI のみ） |
| **Background** | `opaque` | 背景設定（CometAPI のみ） |
| **Format** | `png`（デフォルト）/ `jpeg` / `webp` | 出力ファイル形式（CometAPI のみ。Gemini は PNG 固定） |
| **Compression** | 0っ100 | jpeg/webp 圧縮率（CometAPI のみ） |
| **Moderation** | `auto`（デフォルト）/ `low` | モデレーション厳密度（CometAPI のみ） |

---

### 3. リトライ

- API 呼び出しが失敗した場合、最大 **10 回**（`MAX_RETRIES` 環境変数で変更可）まで即時リトライする。
- リトライ中のタイルには「リトライ中… (N 回目)」とエラーメッセージが表示される。
- 最終的に失敗した場合はエラー状態として履歴に残る。

---

### 4. キャンセル

- 生成待機中・リトライ中のエントリは Cancel ボタンで中断できる。
- 進行中の API リクエストを `AbortController` で即時中断する。

---

### 5. リアルタイム同期（Server-Sent Events）

- `/events` エンドポイントで SSE 接続を確立し、全クライアントに状態をリアルタイム配信する。
- 新規接続時には現在の履歴と進行中エントリの全状態を一括送信（`init` イベント）。
- 生成中は `queued` → `retry` → `completed` / `error` のイベントが順次配信される。
- 10 秒ごとにハートビートコメントを送信してプロキシによる切断を防ぐ。
- 接続状態はツールバーのバッジで表示される（接続中 / オンライン / オフライン）。

---

### 6. 履歴管理

- 生成結果は `history.db`（SQLite）に永続化される。既存の `history.json` がある場合は初回起動時に自動でマイグレーションされ、`history.json.bak` にリネームされる。
- サーバー再起動後も履歴は復元される。
- **Delete ボタン**：完了・エラーエントリを個別に削除できる。全クライアントに削除が同期される。
- **Load ボタン**：過去のエントリのパラメータとプロンプトをフォームに復元する。入力画像があった場合は再取得してドロップゾーンに復元する。

---

### 7. 履歴タイル表示

- 生成された画像は **1 画像 = 1 タイル**でグリッド表示される。
- タイルには画像・プロンプト・パラメータ・ステータス・入力画像サムネイル・操作ボタンが表示される。
- ペンディング状態のタイルには左ボーダーと待機インジケータが表示される。
- エラー状態のタイルは画像エリアにエラーメッセージをオーバーレイ表示する。

#### 表示スケール切り替え

- ヒストリーセクション右上の **Cover / Contain** ボタンで全タイルの画像フィットモードを切り替える。
- 設定は `localStorage` に保存され、リロード後も維持される。

---

### 8. ライトボックス（全画面表示）

- 完了済みタイルの画像をクリック/タップすると、全画面のライトボックスで表示される。
- 画像はネイティブ解像度でレンダリングし、CSS の縮小を行わないため高画質を維持する。

#### 操作方法

| 操作 | PC | スマホ |
|---|---|---|
| ズームイン | ホイール上 | ピンチアウト |
| ズームアウト | ホイール下 | ピンチイン |
| パン（移動） | ドラッグ（ズーム時のみ） | ドラッグ（ズーム時のみ） |
| 2× ズーム | ダブルクリック（等倍時） | ダブルタップ（等倍時） |
| ズームリセット | ダブルクリック（ズーム中） | ダブルタップ（ズーム中） |
| 全画面表示切替 | ⛶ボタン / `F` キー | ⛶ボタン |
| 閉じる | Esc / 背景クリック / ×ボタン / ブラウザ戻る | 背景タップ / ×ボタン / スワイプバック |

- 閉じる操作は `history.pushState` + `popstate` で実装されているため、ブラウザの戻るボタンや iOS/Android のスワイプジェスチャーで閉じることができる。
- ライトボックスを開いても入力フォームの状態はリセットされない。

---

### 9. UI

- ダークテーマ固定。
- **ツールバー**：画面上部にスティッキー表示。同期ステータスバッジを含む。
- **グリッドレイアウト**：最小 220px のタイル幅、最大 1600px のコンテナ幅。スマホでは最低 2 カラムを維持。
- プロンプト入力欄は縦方向にリサイズ可能（最小高さ 8rem）。

---

## 技術情報

### サーバー構成

- Node.js v18 以上が必要（`fetch` / `FormData` / `Blob` を組み込みで使用）。
- **外部 npm パッケージ不要**。使用モジュール：`http`, `fs`, `path`, `crypto`。
- CORS は全オリジン許可（ローカル利用想定）。
- 静的ファイルは `public/` ディレクトリから配信。

### API エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/` | フロントエンド HTML |
| `GET` | `/events` | SSE ストリーム |
| `GET` | `/history` | 履歴 JSON 取得 |
| `POST` | `/generate` | 画像生成リクエスト |
| `POST` | `/cancel` | 生成キャンセル |
| `POST` | `/delete` | 履歴エントリ削除 |
| `GET` | `/images/*` | 生成画像ファイル配信 |
| `GET` | `/images/inputs/*` | 入力画像ファイル配信 |
