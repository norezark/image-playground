# Image Playground — 開発者向けドキュメント

利用者向けのセットアップ・操作方法は [README.md](README.md) を参照してください。

> このファイルは旧 `DEVELOP.md` を改名したものです。

---

## 技術スタック・制約

| 項目 | 内容 |
|---|---|
| ランタイム | Node.js v22.5 以上 |
| 外部依存 | なし（npm パッケージ不使用） |
| サーバー側モジュール | `http`, `fs`, `path`, `crypto`, `node:sqlite` |
| フロントエンド | バニラ JS（バンドラー不使用） |
| DB | SQLite（`node:sqlite` 組み込み） |

---

## ファイル構成

```
image-playground/
├── server.js              # HTTP サーバー・ルーティング・SSE（~260行）
├── server.ps1             # バックグラウンド起動管理スクリプト
├── tests/
│   ├── image-api.test.cjs  # Images API のリクエスト回帰テスト（外部通信なし）
│   └── image-price.test.cjs # GPT Image 2.5 の公式料金計算例との照合
├── history.db             # 生成履歴（SQLite、自動生成）
├── server.pid             # バックグラウンド起動時の PID（自動生成）
├── lib/
│   ├── db.js              # SQLite 初期化・マイグレーション・CRUD
│   ├── api.js             # CometAPI / Gemini API 呼び出し関数
│   └── generation.js      # 画像生成ループ（リトライ付き）のファクトリ
└── public/
    ├── index.html         # SPA の唯一の HTML
    ├── style.css          # スタイルシート（ダークテーマ固定）
    ├── script.js          # エントリポイント（SSE 購読・フォーム送信・状態管理）
    ├── utils.js           # DOM ヘルパー el()
    ├── api.js             # サーバー API 呼び出しラッパー
    ├── history.js         # 履歴タイルのレンダリング
    ├── image-input.js     # 入力画像管理（ドロップゾーン・ファイル選択）
    ├── size-selector.js   # サイズ計算・ビジュアルセレクタ
    ├── price-estimate.js  # 料金見積もり
    ├── image-price.js     # GPT Image 2.5 の出力トークン・料金計算（DOM非依存）
    ├── lightbox.js        # ライトボックス（ズーム・パン・タッチ）
    ├── params-popup.js    # 生成パラメータ一覧ポップアップ
    └── images/            # 生成画像保存先（自動生成）
        └── inputs/        # 入力画像保存先（自動生成）
```

---

## サーバー設計

### モジュール構成（`lib/`）

| ファイル | 役割 |
|---|---|
| `lib/db.js` | SQLite 初期化・`history.json` マイグレーション・`dbSaveEntry` / `dbDeleteEntry` / `dbLoadHistory` などの CRUD |
| `lib/api.js` | `apiFetch` / `callGenerations` / `callEdits` / `callGemini` / `isGeminiModel` |
| `lib/generation.js` | `createStartGeneration` ファクトリ。共有状態（`pendingEntries` 等）を引数として受け取り、リトライ付きの `startGeneration` 関数を返す |
| `server.js` | `.env` 読み込み・設定・状態管理・ルートハンドラ・HTTP サーバー |

> **依存方向**: `server.js` → `lib/*.js`（`lib/` 同士の依存はなし）

### API エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/` | `public/index.html` を返す |
| `GET` | `/events` | SSE ストリーム（クライアントはここで状態を受信） |
| `GET` | `/history` | 履歴全件を JSON で返す |
| `POST` | `/generate` | 画像生成リクエスト（即座に HTTP 202 を返し非同期処理） |
| `POST` | `/cancel` | 生成キャンセル（`AbortController.abort()` を呼び出す） |
| `POST` | `/delete` | 履歴エントリ削除（DB + 画像ファイル削除、全 SSE クライアントに通知） |
| `GET` | `/images/*` | 生成画像ファイルの静的配信 |
| `GET` | `/images/inputs/*` | 入力画像ファイルの静的配信 |
| `GET` | `/<その他>` | `public/` 配下の静的ファイル配信 |

CORS は全オリジン許可（ローカル利用専用のため）。

---

### 生成キュー

- `POST /generate` は `AbortController` を生成してキューに積み、即座に `202 Accepted` を返す。
- キュー処理はシングルスレッドの非同期ループで順次実行される（並列実行なし）。
- 1 リクエストに対して `n` 枚の画像生成が要求された場合、枚数分の処理が独立したキューエントリとして扱われる。

#### 状態遷移

```
queued → (API 呼び出し) → completed
                        ↘ retry → (再試行) → completed
                                             ↘ error
queued → (キャンセル)   → cancelled
```

---

### SSE 設計（`/events`）

- `Content-Type: text/event-stream` で永続接続。
- 新規接続時に `init` イベントとして現在の全履歴＋進行中エントリを一括送信する。
- 以降は状態変化のたびに全接続クライアントへブロードキャストする。
- 接続ごとに `clock` イベントを 1 秒ごとに送信し、サーバー現在時刻（ISO 8601）を通知する。
- 10 秒ごとにコメント行（`: heartbeat`）を送信してプロキシによる強制切断を防ぐ。
- クライアント切断時は接続リストから削除する。

#### イベント種別

| イベント名 | タイミング |
|---|---|
| `init` | 新規接続時（履歴全件 + 進行中の状態を含む） |
| `clock` | 1 秒ごと（サーバー現在時刻の通知） |
| `queued` | 生成リクエスト受理時 |
| `retry` | リトライ発生時 |
| `completed` | 生成成功時 |
| `error` | 最終失敗時 |
| `cancelled` | キャンセル時 |
| `deleted` | エントリ削除時 |

---

### リトライ処理

- API が失敗（ネットワークエラー・非 2xx レスポンス）した場合、`MAX_RETRIES`（デフォルト 10）まで即時リトライする。
- リトライのたびに `retry` イベントを SSE でブロードキャストし、現在のリトライ回数とエラーメッセージを含める。
- `AbortController` によるキャンセルが検出された場合はリトライせず `cancelled` で終了する。

---

## データ永続化

### SQLite（`history.db`）

`node:sqlite` 組み込みモジュールを使用し、外部パッケージ不要で永続化する。

**テーブル: `history`**

| カラム | 型 | 説明 |
|---|---|---|
| `id` | TEXT PRIMARY KEY | `crypto.randomUUID()` で生成 |
| `prompt` | TEXT | プロンプト文字列 |
| `params` | TEXT | 生成パラメータ（JSON 文字列） |
| `status` | TEXT | `completed` / `error` / `cancelled` |
| `imageUrl` | TEXT | 生成画像の URL パス |
| `inputImages` | TEXT | 入力画像 URL の JSON 配列 |
| `error` | TEXT | エラーメッセージ（失敗時のみ） |
| `createdAt` | TEXT | ISO 8601 形式の生成日時 |

### マイグレーション

旧形式の `history.json` が存在する場合、初回起動時に自動で SQLite へ移行し、元ファイルを `history.json.bak` にリネームする。

---

## フロントエンド設計

### モジュール構成

各 `.js` ファイルはブラウザのネイティブ ES モジュール（`<script type="module">`）として読み込まれる。

| ファイル | 役割 |
|---|---|
| `script.js` | アプリエントリポイント。SSE 購読、フォーム送信、状態管理 |
| `api.js` | `fetch` ラッパー。`/generate`, `/cancel`, `/delete` を呼び出す |
| `history.js` | 履歴配列を受け取りタイルを DOM に反映する |
| `image-input.js` | ドロップゾーン・ファイル選択・クリップボードペーストによる入力画像の管理 |
| `size-selector.js` | 向き・アスペクト比・大きさの組み合わせから `size` パラメータを計算 |
| `price-estimate.js` | 選択中のパラメータから概算料金を計算・表示 |
| `image-price.js` | GPT Image 2.5 の品質・解像度から出力トークン数と標準CometAPI料金を推定 |
| `lightbox.js` | 画像の全画面表示・ズーム・パン・タッチ操作 |
| `params-popup.js` | 履歴タイルのプロンプト・パラメータ表示クリック時に、生成パラメータ一覧とプロンプト全文コピー・プロンプトのみロードのボタンを表示するポップアップ |
| `utils.js` | `el(tag, attrs, children)` DOM 生成ヘルパー |

### `el()` ヘルパー（`utils.js`）

新規 DOM 要素の生成は必ず `el()` を使うこと。`document.createElement` の直接呼び出しは禁止。

```js
// 例
el('div', { className: 'tile' }, [
  el('img', { src: url }),
  el('p', {}, 'テキスト'),
])
```

既存要素の取得（`getElementById`, `querySelector` など）はそのまま使用してよい。

### GPT Image 2.5

- `index.html` に `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` を登録。既存の CometAPI Images エンドポイントと API キーで生成・編集する。
- `script.js` は `xhigh` / `max` を 2.5 選択時のみ有効化し、他モデルへの切り替え時は非対応の品質値を Default に戻す。履歴の Load でも同じ制御を適用する。
- `lib/api.js` は 2.5 の生成リクエストに `output_format` を使用し、編集用の `input_fidelity` は生成時に送らない。編集時は従来通り multipart の `output_format` / `input_fidelity` を使用する。
- `image-price.js` は公式計算器と同じ式を使用する。品質ごとの長辺グリッドは `low=16, medium=24, high=48, xhigh=64, max=96`。短辺グリッドは長辺グリッド÷アスペクト比を偶数丸めし、出力トークン数は `ceil(長辺グリッド × 短辺グリッド × (2,000,000 + 幅×高さ) / 4,000,000)`。CometAPI標準料金は公式 `$30/1M` × `0.8` の `$24/1M`（2026-09-09確認）。
- `price-estimate.js` は2.5の出力料金を小数点以下5桁で表示する。枚数分の合計は丸め前の値で計算。品質 Default / Auto は Low〜Max の範囲、サイズ Auto は1024×1024の参考値と明記する。入力料金・リトライは含めない。
- サイズ指定は既存の計算を使用する（16px 単位、最大辺 3840px、比率 1:3〜3:1、総画素数 655,360〜8,294,400）。
- 仕様: [Image generation](https://developers.openai.com/api/docs/guides/image-generation)、[CometAPI標準料金](https://www.cometapi.com/pricing/)。API リクエスト・料金計算の回帰確認は `node --test` で実行する（外部通信なし）。

### SSE 購読と状態管理（`script.js`）

- `EventSource` で `/events` に接続し、受信したイベントに応じて履歴配列を更新する。
- 状態は `script.js` 内の配列で一元管理し、変化のたびに `history.js` を呼んで DOM を再構築する。
- 接続状態（接続中 / オンライン / オフライン）はツールバーのバッジに反映する。
- ツールバーには `clock` イベント由来のサーバー時刻（hh:mm:ss）を接続状態バッジの横に表示する。

---

## コード規約

- **サーバー側**：Node.js 組み込みモジュールのみ使用。`npm install` 禁止。
- **フロントエンド**：バンドラー・フレームワーク導入禁止。バニラ JS を維持する。
- **DOM 生成**：`el()` ヘルパーを使うこと（`document.createElement` 直接呼び出し禁止）。
- **SSE ブロードキャスト設計**を維持すること（クライアント間の状態同期はすべて SSE 経由）。
- **ドキュメントの維持**：以下の変更時は `README.md` および本ドキュメントを同時に更新すること。
  - エンドポイントの追加・変更・削除 → `ARCHITECTURE.md` の **API エンドポイント** セクション
  - 生成パラメータの変更 → `README.md` の **生成パラメータ** セクション
  - UI 操作方法の変更 → `README.md` の該当セクション
  - 起動方法・環境変数の変更 → `README.md` の **セットアップ** セクション
  - ファイル構成の変更 → `ARCHITECTURE.md` の **ファイル構成** セクション
