# Image Playground — 開発者向けドキュメント

利用者向けのセットアップ・操作方法は [README.md](README.md) を参照してください。

> このファイルは旧 `DEVELOP.md` を改名したものです。

---

## 技術スタック・制約

| 項目 | 内容 |
|---|---|
| ランタイム | Node.js v22.5 以上 |
| 外部依存 | npm パッケージ不使用。任意のSynthID前処理のみPython / CUDA / remove-ai-watermarksを使用 |
| サーバー側モジュール | `http`, `https`, `fs`, `path`, `crypto`, `node:sqlite` |
| フロントエンド | バニラ JS（バンドラー不使用） |
| DB | SQLite（`node:sqlite` 組み込み） |

---

## ファイル構成

```
image-playground/
├── server.js              # HTTP サーバー・ルーティング・SSE（~260行）
├── server.ps1             # バックグラウンド起動管理スクリプト
├── scripts/
│   ├── setup-https.cjs    # 自己署名CA・LANのSAN証明書作成と任意の.env設定
│   ├── setup-synthid.ps1   # 任意のPython/CUDA環境をプロジェクト内に準備
│   ├── synthid-worker.py  # 固定バージョンの除去CLI・入出力検証
│   └── synthid_qwen.py    # Qwenの量子化・CPU退避
├── .synthid/              # 除去用ランタイム・モデル・一時ファイル（Git管理外）
├── tests/
│   ├── image-api.test.cjs  # Images API のリクエスト回帰テスト（外部通信なし）
│   ├── image-price.test.cjs # GPT Image 2.5 の公式料金計算例との照合
│   ├── image26.test.cjs    # 2.6の両接続先・描き込み・新形式・料金・永続化
│   ├── model-selection.test.cjs # 接続先を含むモデル選択・旧履歴の互換性
│   ├── server-providers.test.cjs # HTTP/SSE/SQLite を通した接続先・キー未設定の検証
│   ├── synthid.test.cjs    # 前処理の任意実行・API入力・失敗・キャンセル・再試行
│   ├── image-store.test.cjs # 入力画像の重複排除・永続キャッシュ・同時依頼の検証
│   ├── history-renderer.test.cjs # 履歴の差分更新・DOM移動数・通知の一括描画の回帰テスト
│   ├── history-columns.test.cjs # 列幅の端数処理・リサイズ追従・不要な再計測の回帰テスト
│   ├── helpers/test-server.cjs # 外部APIを置き換えた一時サーバー（テスト専用）
│   └── lazy-images.test.cjs # 画像読み込み数・スクロール時の待ち行列・キャンセルの回帰テスト
├── history.db             # 生成履歴（SQLite、自動生成）
├── server.pid             # バックグラウンド起動時の PID（自動生成）
├── lib/
│   ├── db.js              # SQLite 初期化・マイグレーション・CRUD
│   ├── api.js             # CometAPI / OpenAI公式 / Gemini API 呼び出し・接続先検証
│   ├── synthid.js         # ローカル除去ワーカーの起動・直列化・状態確認
│   ├── image-store.js     # 入力画像の共有保存・除去結果の永続キャッシュ
│   ├── image-metadata.js  # PNG/JPEG/WebP寸法・描き込みの透過とサイズの検証
│   ├── web-push.js        # Web Pushの暗号化・VAPID・登録永続化・送信
│   └── generation.js      # 画像生成ループ（リトライ付き）のファクトリ
└── public/
    ├── index.html         # SPA の唯一の HTML
    ├── style.css          # スタイルシート（ダークテーマ固定）
    ├── script.js          # エントリポイント（SSE 購読・フォーム送信・状態管理）
    ├── notifications.js   # 端末別の通知許可・登録・解除・テスト
    ├── sw.js              # ページを閉じた状態での通知受信・クリック処理（キャッシュなし）
    ├── manifest.webmanifest # ホーム画面への追加（standalone）
    ├── icons/             # PWA・通知アイコン（generate-app-icons.cjsで再生成可能）
    ├── model-selection.js # モデル選択値と接続先の変換・表示
    ├── image-models.js    # ブラウザとサーバーで共有するモデルの機能・設定検証
    ├── utils.js           # DOM ヘルパー el()
    ├── api.js             # サーバー API 呼び出しラッパー
    ├── history.js         # 履歴タイルのレンダリング
    ├── history-renderer.js # 変更エントリだけのDOM更新・履歴順序・描画予約
    ├── history-columns.js # Grid列幅の端数によるカード内部の再レイアウトを抑制
    ├── lazy-images.js     # 画像の先読み範囲・同時読み込み数・キャンセルの管理
    ├── image-input.js     # 入力画像管理（ドロップゾーン・ファイル選択）
    ├── markup-editor.js   # 透過Canvasによるペン・丸・取り消し・描き込み保存
    ├── size-selector.js   # サイズ計算・ビジュアルセレクタ
    ├── price-estimate.js  # 料金見積もり
    ├── image-price.js     # GPT Image 2.5 / 2.6の出力トークン・料金計算（DOM非依存）
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
| `lib/image-metadata.js` | PNG / JPEG（EXIF回転を含む）/ WebPの寸法と、描き込みPNGの実際の透過ピクセルを検証 |
| `server.js` | `.env` 読み込み・設定・状態管理・ルートハンドラ・HTTP サーバー |

> **依存方向**: `server.js` → `lib/*.js`。`lib/api.js` とフロントエンドは `public/image-models.js` の同じ機能定義・設定検証を使用する。

### API エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/` | `public/index.html` を返す |
| `GET` | `/events` | SSE ストリーム（クライアントはここで状態を受信） |
| `GET` | `/history` | 履歴全件を JSON で返す |
| `GET` | `/synthid/status` | エンジンの利用可否・バージョン・デバイス・精度設定と、現行処理バージョンのキャッシュ件数を返す |
| `POST` | `/generate` | `prompt` / `params` / 任意の `inputImages` / `markupImage` を受信。モデル・モード・設定・キー・描き込みを保存前に検証し、HTTP 202で非同期処理。不正な設定はHTTP 400 |
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

- ネットワークエラーとAPIからの非2xxレスポンスは、HTTPステータスにかかわらず `MAX_RETRIES`（デフォルト10）まで即時リトライする。設定の検証・前処理の失敗は生成ループに入らず停止する。
- リトライのたびに `retry` イベントを SSE でブロードキャストし、現在のリトライ回数とエラーメッセージを含める。
- `AbortController` によるキャンセルが検出された場合はリトライせず `cancelled` で終了する。

### Web Push

- `lib/generation.js` はDB保存後の成功時、またはAPIの試行上限到達時に `notifyGeneration(entry, reason)` を1回呼ぶ。前処理失敗・キャンセル・途中の再試行・SSEの初期履歴配信では呼ばない。送信の例外やPromiseの失敗は生成処理から分離し、APIを再試行しない。
- `lib/web-push.js` はNode組み込みのECDH P-256 / HKDF-SHA256 / AES-128-GCMで [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) のペイロードを暗号化し、ES256の [VAPID JWT](https://www.rfc-editor.org/rfc/rfc8292) を付けて通知サービスへPOSTする。鍵はメッセージ暗号用とVAPID用で分け、暗号用の鍵とsaltを送信ごとに生成する。TTLは1日、Urgencyはhigh、タイムアウトは10秒。PC・スマホなど有効化した全端末に送る。配信失敗による画像生成の再実行はしない。
- `history.db` 内の `push_settings(key, value)` にVAPID秘密JWK、`push_subscriptions(endpoint, subscription, origin)` に端末登録を保存する。公開鍵は `GET /push/config` のみで公開し、秘密鍵・登録一覧は公開しない。404/410の登録は削除し、一時エラーの登録は保持する。
- `POST /push/subscribe`、`POST /push/unsubscribe`、`POST /push/test` は同一HostのOriginを必須とし、クロスオリジンのCORSを許可しない。登録JSONは16KiBまで、鍵は形式とP-256上の点を検証。通知先はHTTPSのGoogle / Mozilla / Apple / Microsoftの通知サービスのみ許可し、リダイレクトを拒否する。
- `public/notifications.js` はユーザー操作でのみ通知許可を求める。既存の登録は読み込み時にサーバーへ同期し、鍵の変更を検出した場合は再登録を案内する。端末単位でオン・オフできる。
- `public/sw.js` は受信ごとに通知を表示し、クリックで同一オリジンの `/#generation=<id>` を開く。`script.js` が履歴描画後に該当タイルへ移動し、`history.state` とパス・クエリを保持した `replaceState` で通知用のハッシュを取り除く。描画待ちの間にハッシュが変わった場合は古い対象への移動を行わない。Service Workerは通常のfetchを横取りせず、画像・API・画面をキャッシュしない。
- `HTTPS_CERT_FILE` と `HTTPS_KEY_FILE` が両方あれば `https.createServer`、なければ従来のHTTPで起動する。LAN端末では信頼されたHTTPSが必要。iOSのホーム画面アプリのためmanifestとPNGアイコンを配信する。
- `GET /cert/rootCA.cer`（HEAD対応）は `HTTPS_CA_CERT_FILE`（既定 `certs/rootCA.pem`）からX.509を読み、公開証明書のDERだけを `application/x-x509-ca-cert` とattachment指定で配布する。PEMに秘密鍵が混在していてもファイル自体を送らない。証明書の欠落は404、不正な証明書やCA以外は503、GET/HEAD以外は405。
- HTTPS使用時は `CERT_HTTP_PORT`（既定は `PORT + 1`、通常8001）で証明書配布専用HTTPサーバーも同じNodeプロセス内で起動する。このポートは証明書パス以外を404にし、生成APIや履歴を提供しない。`CERT_HTTP_PORT=off` で無効化。HTTP単独モードではメインポートで同じ証明書パスを提供する。
- `scripts/setup-https.cjs` はOpenSSLで自己署名ローカルCA（CA:true / pathlen:0）とRSA-3072 / SHA-256のサーバー証明書（CA:false / serverAuth / DNS・IPのSAN）を作成する。既存CAを再利用し、SANの変更・期限接近時にサーバー証明書だけを再発行する。`--configure` で.envの証明書・秘密鍵・配布用CAのパスを更新し、APIキー等は保持する。信頼ストアと稼働中サーバーには触れない。任意のPEMへの差し替えは引き続き環境変数で指定できる。
- `tests/https.test.cjs` は自己署名CAの再利用、SAN変更時の再発行、.envの既存値の保持と任意パスのPEMでのHTTPS起動を検証する。TLS接続はCA・ホスト名検証を有効にし、未信頼のCAや不一致のホスト名が拒否されることも確認する。証明書作成テストのみOpenSSLがない環境ではスキップする。
- 同テストでHTTP・HTTPSでの公開CAダウンロード、配布専用ポートの分離、秘密鍵を含むPEMからのDER抽出、GET/HEADのヘッダーと不正なファイルの拒否も確認する。
- `tests/web-push.test.cjs` はRFCの既知暗号文・JWT署名・鍵と登録の永続化を検証する。`tests/push-notifications.test.cjs` はブラウザ接続なしのHTTP生成→端末ごとの暗号文復号、上限・回復・登録解除・送信障害の分離を検証する。通知サービスと生成APIへの実通信は行わない。

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
| `markup_image` | TEXT | 先頭画像への描き込みPNGのURL（レスポンスでは `markupImage`） |
| `usage` | TEXT | 画像モデルの `usage` とSVG作成モデルの `svg_usage` を `image` / `svg` に分けたJSON |
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
`processed_input_images` / `markup_image` / `usage` がないDBには起動時にカラムを追加する。旧履歴のパラメータや画像は書き換えない。

---

## フロントエンド設計

### モジュール構成

各 `.js` ファイルはブラウザのネイティブ ES モジュール（`<script type="module">`）として読み込まれる。

| ファイル | 役割 |
|---|---|
| `script.js` | アプリエントリポイント。SSE 購読、フォーム送信、状態管理 |
| `model-selection.js` | 公式モデルの選択値 `openai:<model>` と `{ provider, model }` の変換・接続先表示・標準サイズモデル判定 |
| `api.js` | `fetch` ラッパー。`/generate`, `/cancel`, `/delete` を呼び出す |
| `history.js` | 履歴の Map と変更IDを受け取りタイルを DOM に反映する |
| `history-renderer.js` | 履歴の順序を保持し、変更エントリだけを更新する。連続通知の描画をフレームごとにまとめる |
| `history-columns.js` | Gridの列幅を測定し、カード内部の幅を統一する。画面幅が変わると追従する |
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
- Gridの列数・間隔・カードの外枠はそのまま維持する。列幅には丸めによる約1/64pxの差が生じるため、`.tile-content` の内部幅を最小列幅に統一して、先頭追加で列を移るたびに画像・テキストを再計算する負荷を抑える。外枠との端数差は疑似要素の高さで補い、行の高さと後続カードの位置を維持する。
- 未読み込み画像の背景は静止表示にして、スクロール中のアニメーション描画を減らす。

### ライトボックスの画像切り替え

- スワイプ用の画像URL一覧は、ライトボックスを開く時に履歴の表示順・お気に入りフィルターに合わせて作成し、次の履歴更新まで再利用する。`openLightbox(src, images)` はその時点の一覧をコピーして使う。未読み込みの画像も移動対象となり、画像のないタイルや入力画像は対象外。
- 未ズーム時の1本指の横スワイプ、またはマウス左ボタンの横ドラッグで前後の画像へ移動する。操作終了時に共通の `lbSwipe()` で左右50px以上、縦移動の1.25倍を超える横移動を判定し、先頭・末尾では止まる。ズーム中は従来どおりパンする。
- マウスでは画像のネイティブなドラッグを抑制し、操作ボタンからのドラッグは対象外とする。ドラッグ後のクリックはキャプチャ段階で抑制して背景・ボタンの誤操作を防ぎ、ダブルクリックによるズームとも区別する。ウィンドウがフォーカスを失った場合やボタンを離して戻ってきた場合はドラッグを中断する。
- ピンチ、ドラッグ、キャンセルしたタッチはダブルタップとして扱わず、操作後のクリックで誤って閉じることも防ぐ。
- 切り替え先の画像ごとに表示倍率・位置をリセットして画面内に収める。画像切り替えではブラウザ履歴を追加せず、戻る操作1回で閉じる。

### GPT Image 2.6

- `gpt-image-2.6-flare` / `gpt-image-2.6-sunburst` をCometAPIとOpenAI公式の両方に登録。2.6の機能制御は接続先によって分けず、モデル・生成／編集モード・出力形式で決める。接続先はURL・認証・料金に使用する。
- `public/image-models.js` は副作用importとCommonJS requireの双方で使える共有モジュール。Complexity、拡張品質、透過背景、描き込み、新形式と不正な組み合わせの検証をまとめる。
- 2.6では生成・編集とも `output_format` / `complexity` を使用し、`input_fidelity` を送らない。GIFは `frame_count` / `frame_duration_ms`、SVGは必要な場合のみ `svg: { model, reasoning: { effort } }` を送る。
- 描き込みは `/generate` の `markupImage: { dataUrl }` で受信する。保存前に透過PNG・50MB以下・先頭画像との寸法一致・最大16,777,216画素を検証する。編集APIには元画像と分離したmultipartの `markup` として送る。入力画像の読み込み・履歴復元では選択順を維持する。
- GIF / SVGの拡張子とMIMEを保存・配信まで維持し、SVGはimg要素で表示する。SVGファイルの配信には外部リソース・スクリプトを制限するCSPを付与する。Edit as PNGではGIF / SVGをCanvasで静止画PNGに変換する。
- SVGは生成のみ・`n=1`。GIF / SVGには圧縮率を送らず、GIF固有設定を他形式へ送らない。GIFの小さいフレーム用に256px / 512pxを追加する。GIFの総画素数の上限はAPI側でも検証される。
- 2.6の出力トークンは2.5の計算結果を切り上げた後、Lowは4.2倍、Mediumは3.3倍して整数に丸める。High / XHigh / Maxは2.5と同じ。公式計算器 `GptImageTokenCalculator.react.D6e1YylC.js`（2026-11-06）と照合。SVGは参考画像分の見積もりと作成モデルの別料金を案内し、GIFの事前見積もりは未対応と明示する。
- APIから返る `usage` / `svg_usage` は履歴に保存し、パラメータ一覧で表示する。APIの失敗はHTTPステータスにかかわらず既存の設定回数まで再試行する。

### GPT Image 2.5

- `index.html` に `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` をCometAPIとOpenAI公式のグループに登録。各接続先の Images エンドポイントと専用APIキーで生成・編集する。
- `script.js` は `xhigh` / `max` を 2.5 / 2.6選択時に有効化し、他モデルへの切り替え時は非対応の品質値を Default に戻す。履歴の Load でも同じ制御を適用する。
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

- `EventSource` で `/events` に接続し、受信したイベントに応じて履歴の Map を更新する。
- 状態は `script.js` 内の Map で一元管理し、通知の変更IDを `requestAnimationFrame` でまとめて `history.js` に渡す。同じフレーム内の生成待機・前処理・完了などの通知は最新状態を一度だけ描画する。
- 初回接続・再同期・お気に入りフィルター切り替えだけ全件を照合する。通常の通知では全件の走査・日時解析・並べ替えを行わず、保持した順序への二分探索で変更エントリを追加・更新・削除する。
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
