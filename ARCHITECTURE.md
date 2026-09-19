# Image Playground — 開発者向けドキュメント

利用者向けのセットアップ・操作方法は [README.md](README.md) を参照してください。

> このファイルは旧 `DEVELOP.md` を改名したものです。

---

## 技術スタック・制約

| 項目 | 内容 |
|---|---|
| ランタイム | Node.js v22.5 以上 |
| 外部依存 | npm パッケージ不使用。任意のSynthID前処理のみPython / CUDA / remove-ai-watermarksを使用 |
| サーバー側モジュール | `http`, `fs`, `path`, `crypto`, `node:sqlite` |
| フロントエンド | バニラ JS（バンドラー不使用） |
| DB | SQLite（`node:sqlite` 組み込み） |

---

## ファイル構成

```
image-playground/
├── server.js              # HTTP サーバー・ルーティング・SSE（~260行）
├── server.ps1             # バックグラウンド起動管理スクリプト
├── scripts/
│   ├── setup-synthid.ps1   # 任意のPython/CUDA環境をプロジェクト内に準備
│   ├── synthid-worker.py  # 固定バージョンの除去CLI・入出力検証
│   └── synthid_qwen.py    # Qwenの量子化・CPU退避
├── .synthid/              # 除去用ランタイム・モデル・一時ファイル（Git管理外）
├── tests/
│   ├── image-api.test.cjs  # Images API のリクエスト回帰テスト（外部通信なし）
│   ├── image-price.test.cjs # GPT Image 2.5 の公式料金計算例との照合
│   ├── model-selection.test.cjs # 接続先を含むモデル選択・旧履歴の互換性
│   ├── server-providers.test.cjs # HTTP/SSE/SQLite を通した接続先・キー未設定の検証
│   ├── synthid.test.cjs    # 前処理の任意実行・API入力・失敗・キャンセル・再試行
│   ├── image-store.test.cjs # 入力画像の重複排除・永続キャッシュ・同時依頼の検証
│   ├── helpers/test-server.cjs # 外部APIを置き換えた一時サーバー（テスト専用）
│   └── lazy-images.test.cjs # 画像読み込み数・スクロール時の待ち行列・キャンセルの回帰テスト
├── history.db             # 生成履歴（SQLite、自動生成）
├── server.pid             # バックグラウンド起動時の PID（自動生成）
├── lib/
│   ├── db.js              # SQLite 初期化・マイグレーション・CRUD
│   ├── api.js             # CometAPI / OpenAI公式 / Gemini API 呼び出し・接続先検証
│   ├── synthid.js         # ローカル除去ワーカーの起動・直列化・状態確認
│   ├── image-store.js     # 入力画像の共有保存・除去結果の永続キャッシュ
│   └── generation.js      # 画像生成ループ（リトライ付き）のファクトリ
└── public/
    ├── index.html         # SPA の唯一の HTML
    ├── style.css          # スタイルシート（ダークテーマ固定）
    ├── script.js          # エントリポイント（SSE 購読・フォーム送信・状態管理）
    ├── model-selection.js # モデル選択値と接続先の変換・表示
    ├── utils.js           # DOM ヘルパー el()
    ├── api.js             # サーバー API 呼び出しラッパー
    ├── history.js         # 履歴タイルのレンダリング
    ├── lazy-images.js     # 画像の先読み範囲・同時読み込み数・キャンセルの管理
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
| `lib/api.js` | `apiFetch` / `callGenerations` / `callEdits` / `callGemini` / `isGeminiModel` / `validateGenerationParams` / `getProviderAvailability` |
| `lib/generation.js` | `createStartGeneration` ファクトリ。共有状態（`pendingEntries` 等）を引数として受け取り、リトライ付きの `startGeneration` 関数を返す |
| `lib/synthid.js` | Pythonワーカーの実行・GPU処理の直列化・キャッシュ利用 |
| `lib/image-store.js` | 入力画像の共有保存・除去結果の永続化 |
| `server.js` | `.env` 読み込み・設定・状態管理・ルートハンドラ・HTTP サーバー |

> **依存方向**: `server.js` → `lib/*.js`（`lib/` 同士の依存はなし）

### API エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/` | `public/index.html` を返す |
| `GET` | `/events` | SSE ストリーム（クライアントはここで状態を受信） |
| `GET` | `/history` | 履歴全件を JSON で返す |
| `GET` | `/synthid/status` | エンジンの利用可否・バージョン・デバイス・精度設定と、現行処理バージョンのキャッシュ件数を返す |
| `POST` | `/generate` | 接続先・モデル・キー設定を検証し、HTTP 202 を返して非同期処理。不正な組み合わせ・キー未設定は入力画像保存前にHTTP 400 |
| `POST` | `/cancel` | 生成キャンセル（`AbortController.abort()` を呼び出す） |
| `POST` | `/delete` | 履歴エントリをDBから削除し、全 SSE クライアントに通知。画像ファイル・共有キャッシュは保持 |
| `GET` | `/images/*` | 生成画像ファイルの静的配信 |
| `GET` | `/images/inputs/*` | 入力画像ファイルの静的配信 |
| `GET` | `/<その他>` | `public/` 配下の静的ファイル配信 |

CORS は全オリジン許可（ローカル利用専用のため）。

### 接続先と認証

- 生成パラメータの `provider` は `cometapi` / `openai` / `gemini`。省略時はモデル名が `gemini-` で始まればGemini、それ以外は従来のCometAPIとする。
- CometAPIは `https://api.cometapi.com/v1/images`、OpenAI公式は `https://api.openai.com/v1/images` に対し、生成は `/generations`、編集は `/edits` を使用する。接続先はリクエストごとに決まり、同時実行中の他リクエストの選択に影響されない。
- CometAPIキーは `COMET_API_KEY` を優先し、未設定時だけ従来の `OPENAI_API_KEY` を使用する。公式は `OPENAI_OFFICIAL_API_KEY`、Geminiは `NANO_BANANA_API_KEY` を使用し、接続先をまたぐキーのフォールバックは行わない。
- `validateGenerationParams` はプロバイダー名・モデルとの組み合わせ・公式のモデル一覧・公式旧モデルの標準サイズ・キーの有無を検証する。公式の生成では `output_format` を使用し、編集用の `input_fidelity` とGPT Imageに非対応の `style` は送信しない。CometAPIの既存送信形式は維持する。
- キュー・SSE・SQLiteの `params` に `provider` を保存する。APIキーやブラウザ専用の選択値は保存・配信しない。
- 外部APIの仕様: [生成](https://developers.openai.com/api/reference/resources/images/methods/generate)、[編集](https://developers.openai.com/api/reference/resources/images/methods/edit)。

---

### 生成キュー

- 1リクエストにつき1つの進行中エントリと `AbortController` を持つ。設定検証後に `202 Accepted` を返し、API処理はリクエスト間で並行する。
- 前処理が有効な場合は入力形式も検証する。エンジンの利用可否は未キャッシュ画像がある場合だけ確認する。

#### 状態遷移

```
queued → [preprocessing → generating] → completed
                                      ↘ retrying → completed / error
queued / preprocessing / generating / retrying → cancelled
```

角括弧は `params.remove_synthid: true` の場合のみ。全入力の前処理が成功してからAPIを呼び、APIの再試行には同じ結果を使う。前処理の失敗は `error` で終了する。

### SynthID前処理

`lib/synthid.js` がPythonワーカーを子プロセスとして起動する。ワーカーは `remove-ai-watermarks[qwen-zimage]==0.41.1` を使い、入力と同じ解像度のPNGを返す。

前処理モデルは入力画像の生成元から自動選択する（Microsoft: Chroma、Google: SDXL、その他: Qwen）。

GPU処理はアプリ全体で1枚ずつ実行する。処理直前にもキャッシュを確認し、同じ画像の同時依頼による重複実行を避ける。キャッシュヒットはGPUの待ち行列を通らない。

ChromaとQwenは既定で主要層をNF4量子化し、CPU退避と組み合わせてVRAM使用量を抑える。量子化モデルは `.synthid/models/image-playground/` に保存して再利用する。

作業領域 `.synthid/jobs/` は処理終了時に削除し、失敗時のログは `.synthid/logs/` に残す。

### 入力画像の共有保存・前処理キャッシュ

元画像と前処理結果はファイル全体のSHA-256で識別し、`public/images/inputs/sha256-<hash>.<ext>` に共有保存する。既存ファイルは元のURLを使い、以前の除去結果は履歴から利用時に登録する。

キャッシュキーは入力ハッシュと処理バージョンの組。処理バージョンはエンジンのバージョン・前処理コード・精度設定から作る。結果の存在・ハッシュ・PNG形式を利用時に確認し、欠落・破損時は再処理する。

結果は1枚の処理が成功した時点で保存し、履歴はそのURLを参照する。共有ファイルとキャッシュは、後続の処理の失敗・キャンセルや履歴削除でも保持する。

---

### SSE 設計（`/events`）

- `Content-Type: text/event-stream` で永続接続。
- 新規接続時に `init` イベントとして現在の全履歴＋進行中エントリと、キー設定の有無だけを示す `providers: { cometapi: boolean, openai: boolean, gemini: boolean }` を送信する。
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
| `processing` | 前処理の進捗とAPI呼び出し開始。`entry.progress` に進捗文言を含む |
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

**テーブル: `entries`**

| カラム | 型 | 説明 |
|---|---|---|
| `id` | TEXT PRIMARY KEY | 生成リクエストのID |
| `prompt` | TEXT | プロンプト文字列 |
| `params` | TEXT | 生成パラメータ（JSON 文字列） |
| `status` | TEXT | 完了時の `completed` / `error`（進行中・キャンセル済みエントリは保存しない） |
| `images` | TEXT | 生成画像 URL の JSON 配列 |
| `input_images` | TEXT | 元の入力画像 URL の JSON 配列（レスポンスでは `inputImages`） |
| `processed_input_images` | TEXT | 任意の前処理後の入力画像 URL の JSON 配列（レスポンスでは `processedInputImages`） |
| `error` | TEXT | エラーメッセージ（失敗時のみ） |
| `timestamp` | TEXT | ISO 8601 形式の生成日時 |
| `retries` | INTEGER | APIの再試行回数（前処理失敗は0） |
| `favorited_images` | TEXT | お気に入り画像 URL の JSON 配列 |

**キャッシュ用テーブル**

| テーブル | カラム・キー | 用途 |
|---|---|---|
| `image_assets` | `hash` PRIMARY KEY, `url` UNIQUE, `mime_type` | 画像の内容と共有ファイルの対応 |
| `synthid_cache` | `(input_hash, recipe)` PRIMARY KEY, `output_hash` | 入力画像・処理バージョンから除去結果を検索 |
| `image_cache_settings` | `name` PRIMARY KEY, `value` | 旧結果の再利用を許す `recipe`。初回起動時に固定 |

`synthid_cache.output_hash = ''` は無効化済みの結果を表し、旧履歴からの再登録を防ぐ。

### マイグレーション

旧形式の `history.json` が存在する場合、初回起動時に自動で SQLite へ移行し、元ファイルを `history.json.bak` にリネームする。
`processed_input_images` がないDBには起動時にカラムを追加する。

---

## フロントエンド設計

### モジュール構成

各 `.js` ファイルはブラウザのネイティブ ES モジュール（`<script type="module">`）として読み込まれる。

| ファイル | 役割 |
|---|---|
| `script.js` | アプリエントリポイント。SSE 購読、フォーム送信、状態管理 |
| `model-selection.js` | 公式モデルの選択値 `openai:<model>` と `{ provider, model }` の変換・接続先表示・標準サイズモデル判定 |
| `api.js` | `fetch` ラッパー。`/generate`, `/cancel`, `/delete` を呼び出す |
| `history.js` | 履歴配列を受け取りタイルを DOM に反映する |
| `lazy-images.js` | 生成画像と入力画像の先読み、同時読み込み数、取り外した画像のキャンセルを管理する |
| `image-input.js` | ドロップゾーン・ファイル選択・クリップボードペーストによる入力画像の管理 |
| `size-selector.js` | 向き・アスペクト比・大きさの組み合わせから `size` パラメータを計算 |
| `price-estimate.js` | 選択中のパラメータから概算料金を計算・表示 |
| `image-price.js` | GPT Image 2.5 の品質・解像度から出力トークン数と接続先別の料金を推定 |
| `lightbox.js` | 画像の全画面表示・ズーム・パン・未ズーム時のスワイプによる前後移動 |
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

### 履歴画像の遅延読み込み（`history.js` / `lazy-images.js`）

- 履歴タイルは全件を DOM に保持し、連続してスクロールできる構成を維持する。
- 生成画像とカード内の入力画像は、共通の `createLazyImageLoader()` で管理する。元画像の URL を `data-src` に保持し、`IntersectionObserver` で画面の前後500px以内に入った画像を待ち行列に追加する。縮小画像は作成しない。
- 読み込みから `decode()` 完了までを同時に2枚までに制限する。待ち行列の開始は `requestAnimationFrame` にまとめ、スクロールで先読み範囲を通り過ぎた未開始の画像は待ち行列から外す。30秒でタイムアウトした画像はリクエストを止め、後続画像の処理を続ける。
- 読み込んだ画像は監視を解除し、画面外へ戻っても保持する。スクロールで戻った際に画像を読み直す処理は行わない。
- 削除・差し替え・お気に入りフィルターで取り除いたタイルは、画像の監視・待ち行列を解除し、読み込み中ならキャンセルする。失敗した画像が後続の読み込みを止めることはない。
- 画像には `decoding="async"` を指定する。読み込み開始時は `loading="eager"` に切り替え、ブラウザ側の遅延判定によって先読みが止まらないようにする。`IntersectionObserver` がない旧ブラウザでも、2枚ずつ読み込む制限は維持する。
- カードには `contain: layout style paint` を指定し、カード内のレイアウト・描画を隔離する。`content-visibility: auto` は使用しない。Android Chromeがキーボード表示前に前後の入力候補を探索すると、描画を省略したカードごとに強制レイアウトが発生するため。カードのレイアウトは初期表示時に計算し、画像の取得は上記の `IntersectionObserver` で別に制御する。
- 2026-09-13にPixel 10 / Android 17 / Chrome 152でUSBトレースを比較。再読み込み後の初回フォーカスを含むメインスレッド処理は3,702msから159ms、同処理中のレイアウトは1,631回から0回に減少。修正後の3回は159 / 181 / 147msで、実機操作でも入力・スクロールの改善を確認した。これらはChromeの処理時間であり、キーボードの表示アニメーション全体の所要時間ではない。
- 未読み込み画像の背景は静止表示にして、スクロール中のアニメーション描画を減らす。

### ライトボックスの画像切り替え

- `history.js` は履歴を描画する際に、表示順・お気に入りフィルター適用後の画像URL一覧を保持する。画像を開くときに `openLightbox(src, images)` へ渡し、ライトボックスはその時点の一覧をコピーして使う。未読み込みの画像も移動対象となり、画像のないタイルや入力画像は対象外。
- 未ズーム時の1本指の横スワイプ、またはマウス左ボタンの横ドラッグで前後の画像へ移動する。操作終了時に共通の `lbSwipe()` で左右50px以上、縦移動の1.25倍を超える横移動を判定し、先頭・末尾では止まる。ズーム中は従来どおりパンする。
- マウスでは画像のネイティブなドラッグを抑制し、操作ボタンからのドラッグは対象外とする。ドラッグ後のクリックはキャプチャ段階で抑制して背景・ボタンの誤操作を防ぎ、ダブルクリックによるズームとも区別する。ウィンドウがフォーカスを失った場合やボタンを離して戻ってきた場合はドラッグを中断する。
- ピンチ、ドラッグ、キャンセルしたタッチはダブルタップとして扱わず、操作後のクリックで誤って閉じることも防ぐ。
- 切り替え先の画像ごとに表示倍率・位置をリセットして画面内に収める。画像切り替えではブラウザ履歴を追加せず、戻る操作1回で閉じる。

### GPT Image 2.5

- `index.html` に `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` をCometAPIとOpenAI公式のグループに登録。各接続先の Images エンドポイントと専用APIキーで生成・編集する。
- `script.js` は `xhigh` / `max` を 2.5 選択時のみ有効化し、他モデルへの切り替え時は非対応の品質値を Default に戻す。履歴の Load でも同じ制御を適用する。
- `lib/api.js` は 2.5 の生成リクエストに `output_format` を使用し、編集用の `input_fidelity` は生成時に送らない。編集時は従来通り multipart の `output_format` / `input_fidelity` を使用する。
- `image-price.js` は公式計算器と同じ式を使用する。品質ごとの長辺グリッドは `low=16, medium=24, high=48, xhigh=64, max=96`。短辺グリッドは長辺グリッド÷アスペクト比を偶数丸めし、出力トークン数は `ceil(長辺グリッド × 短辺グリッド × (2,000,000 + 幅×高さ) / 4,000,000)`。CometAPI標準料金は公式 `$30/1M` × `0.8` の `$24/1M`（2026-09-09確認）。
- `price-estimate.js` は2.5の出力料金を小数点以下5桁で表示する。枚数分の合計は丸め前の値で計算。品質 Default / Auto は Low〜Max の範囲、サイズ Auto は1024×1024の参考値と明記する。入力料金・リトライは含めない。
- サイズ指定は既存の計算を使用する（16px 単位、最大辺 3840px、比率 1:3〜3:1、総画素数 655,360〜8,294,400）。
- 仕様: [Image generation](https://developers.openai.com/api/docs/guides/image-generation)、[CometAPI標準料金](https://www.cometapi.com/pricing/)。API リクエスト・料金計算の回帰確認は `node --test` で実行する（外部通信なし）。

### モデルと接続先の選択

- Model欄のグループはCometAPI／OpenAI公式／Nano Banana (Gemini API)。公式の選択値だけ `openai:` を付け、送信時は `model-selection.js` で実モデル名と `provider` に分離する。`gpt-image-2-all` はCometAPIのみに表示する。
- 選択を `localStorage` の `image-model-selection` に保存する。履歴のLoad・Editでも接続先を復元し、`provider` のない旧履歴は従来の接続先として扱う。
- SSEの `providers` で選択先の設定状況を確認する。未設定時はモデルを選択したまま案内を表示し、Generateを無効にする。キーの設定状況を受信する前も生成を無効にする。
- 公式のGPT Image 1 / 1.5 / 1 miniは向きに応じた標準サイズを使用し、比率・サイズ階層の操作を表示しない。GPT Image 2 / 2.5とCometAPIには従来のサイズ計算を使う。
- 料金表示は接続先に連動し、CometAPIだけ標準20%割引を適用する。公式のGPT Image 2.5は `$30/1M`、CometAPIは `$24/1M` で画像出力分を見積もる。

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
