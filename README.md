> [!NOTE]
> このプロジェクトは全てGitHub Copilot製のため、不自然なドキュメントやコードが存在する可能性があります。

# Image Playground

CometAPI、OpenAI公式、Google Gemini の画像生成 API を手軽に試せるローカル Web アプリです。
プロンプトと各種パラメータを入力して画像を生成し、結果をリアルタイムで複数デバイスと共有できます。

> 開発者向けの内部設計・技術仕様は [ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。

---

## 必要環境

- **Node.js v22.5 以上**（`fetch` / `FormData` / `Blob` / `node:sqlite` の組み込み実装を使用）
- 外部 npm パッケージは不要

---

## セットアップ

### 1. API キーの設定

プロジェクトルートに `.env` ファイルを作成し、使用する API のキーを記載します。
**いずれか1つ**の接続先のキーが設定されていれば起動できます。

```
# CometAPI （OpenAI 互換プロキシ）
COMET_API_KEY=your_cometapi_key_here

# OpenAI公式
OPENAI_OFFICIAL_API_KEY=your_official_openai_key_here

# Nano Banana （Google Gemini ネイティブ画像生成）
NANO_BANANA_API_KEY=your_gemini_api_key_here
```

既存の `OPENAI_API_KEY` は、従来どおり **CometAPI用**として読み込みます。`COMET_API_KEY` を設定した場合はそちらを優先します。
公式用のキーは `OPENAI_OFFICIAL_API_KEY` に設定してください。接続先ごとに専用のキーを使用し、他の接続先のキーへ自動で切り替えることはありません。
キーを追加・変更したら `node server.js` を起動し直すか、`./server.ps1 restart` でサーバーを再起動してください。

環境変数として直接渡すことも可能です。

```bash
COMET_API_KEY=xxx OPENAI_OFFICIAL_API_KEY=yyy NANO_BANANA_API_KEY=zzz node server.js
```

すべて未設定の場合、サーバーは起動時にエラーを出力して終了します。
未設定の接続先のモデルも一覧で確認できますが、選択すると案内を表示し、Generate ボタンを無効にします。APIキーの値はブラウザに渡しません。

### 2. サーバー起動

```bash
node server.js
```

ブラウザで `http://localhost:8000` を開きます。

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `8000` | リッスンポート |
| `MAX_RETRIES` | `10` | API 失敗時の最大リトライ回数 |
| `HTTPS_CERT_FILE` / `HTTPS_KEY_FILE` | 未設定（HTTP） | HTTPS用のPEM証明書・秘密鍵。両方指定。相対パスはプロジェクトルート基準 |
| `HTTPS_CA_CERT_FILE` | `certs/rootCA.pem` | ダウンロード用の公開CA証明書（PEM / DER）。配布時に公開証明書部分だけをDERに変換 |
| `CERT_HTTP_PORT` | `PORT + 1`（通常 `8001`） | HTTPS使用時の証明書配布専用HTTPポート。`off` で無効化 |
| `WEB_PUSH_SUBJECT` | HTTPSで通知登録したURL | 通知サービスに渡す連絡先。`mailto:自分のメールアドレス` または外部から参照できるHTTPSのURLを指定可能 |
| `SYNTHID_PYTHON` | `.synthid/venv` 内の Python | 任意のSynthID除去用Python実行ファイルの絶対パス |
| `SYNTHID_TIMEOUT_MS` | `1800000` | 入力画像1枚の前処理の制限時間（ミリ秒、初回ダウンロードを含む） |
| `SYNTHID_CHROMA_PRECISION` | `nf4` | Chromaの重みを4bitで使用。`bf16` は従来の16bit・ディスク退避方式 |
| `SYNTHID_QWEN_PRECISION` | `nf4` | Qwenの主要層を4bitで使用。`fp8` は従来の8bit精度。どちらもCPU退避を使用 |

```bash
PORT=8080 MAX_RETRIES=5 node server.js
```

### 3. SynthID除去の準備（任意・Windows）

編集前のSynthID除去を使う場合は、NVIDIA GPU・対応ドライバーと [uv](https://docs.astral.sh/uv/getting-started/installation/) を用意して実行します。

```powershell
.\scripts\setup-synthid.ps1
```

プロジェクト専用の `.synthid/venv` にPython 3.12、CUDA対応PyTorch、[remove-ai-watermarks](https://github.com/wiltodelta/remove-ai-watermarks) `0.41.1`、`protobuf`、`bitsandbytes` `0.50.2`、`diffsynth` `2.1.7` を準備します。既にセットアップ済みの場合も、このスクリプトで依存関係を追加できます。セットアップ後はアプリを再読み込みしてください。初回の処理時にはモデルをダウンロードするため、時間と数十GB規模の空きディスク容量が必要です。モデルとそのキャッシュは `.synthid/` 内、再利用する除去結果は `public/images/inputs/` と `history.db` に保存されます。通常の画像生成・編集にはこの環境は不要です。

前処理モデルは入力画像の生成元から自動選択します。Microsoft由来はChroma、Google由来はSDXL、OpenAI由来や判別できない画像はQwenを使います。

Chromaは既定で主な重みを4bit（NF4）で使用します。初回に量子化したモデルと固定プロンプトの計算結果を `.synthid/models/image-playground/` に保存し、次回から再利用します。量子化モデルの保存には追加で約5GB必要です。画質を比較する場合は `SYNTHID_CHROMA_PRECISION=bf16` を設定してサーバーを再起動すると、従来の処理に戻せます。`bf16` は処理中に約26GBの一時ディスク領域を使用します。

Qwenも既定で主要層をNF4にし、調整層などは8bitを維持します。初回に層ごとに量子化し、追加で約14GBのモデルキャッシュを保存します。処理中は圧縮した重みをRAMに置き、使用する層だけGPUへ転送します。`SYNTHID_QWEN_PRECISION=fp8` を設定してサーバーを再起動すると従来精度で比較できます。

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

## 使い方

### 1. 画像を生成する

- 画面上部のツールバーには同期状態（接続中 / 同期中 / 切断）と、サーバーから毎秒配信される現在時刻が表示されます。

#### テキストからの生成

1. プロンプト入力欄に生成したい画像の説明を入力する。
2. **Model / 接続先** の CometAPI／OpenAI公式／Nano Banana (Gemini API) グループからモデルを選び、サイズ・クオリティなどを設定する。
3. **Generate** ボタンを押す。
4. 画面下部の履歴グリッドにタイルが追加され、生成完了後に画像が表示される。

同じモデル名でも、項目末尾の接続先によって利用するAPIと料金表示が変わります。`gpt-image-2-all` はCometAPIのみに表示します。
モデルの選択はブラウザに保存されます。履歴の **Load** / **Edit** は生成時の接続先も復元します。以前の履歴は従来どおりCometAPI（GeminiモデルはGemini API）として扱います。

#### 入力画像を使った編集（Edits モード）

1. フォーム上部のドロップゾーンに画像をドラッグ＆ドロップ、クリックしてファイルを選択、またはプロンプト入力欄に画像を貼り付け（Ctrl+V）する（最大 16 枚）。
2. 入力画像が 1 枚以上セットされると自動的に編集モードに切り替わる。
3. プロンプトで変更内容を指示して **Generate** を押す。

#### 丸や線で編集箇所を指定する

GPT Image 2.5 / 2.6では、先頭の入力画像の **描き込み** からペン・丸・色・太さを選べます。変更箇所を示して **描き込みを使う** を押し、プロンプトに変更内容を記載してください。元画像と透過PNGの描き込みは別々に保存され、履歴の **Load** で両方を復元できます。描き込みは先頭の画像に適用し、追加画像は参照として扱います。

#### 編集前にSynthIDを除去する（任意）

入力画像の下にある **編集前にSynthIDを除去する（実験的）** をオンにして生成すると、PNG / JPEG / WebPの入力画像をローカルの除去エンジンで処理してから編集APIへ送ります。初期状態はオフです。CometAPI・OpenAI公式・Geminiの各接続先で利用できます。

これは画素を再生成する実験的な処理です。SynthIDの有無・除去成功を自動判定するものではなく、細部が変わる場合があります。元の入力画像は保持し、履歴の **前処理後** の画像とそれぞれクリックして比較できます。編集APIの出力には前処理を行いません。

処理待ち・前処理中も **Cancel** で中断できます。除去エンジンが失敗した場合は編集APIを呼ばずに停止します。APIだけが失敗してリトライする場合は、同じ前処理済み画像を再利用します。履歴の **Load / Edit** ではオン・オフも復元され、**Load** は元の入力画像を読み戻します。

タイムアウトを含む前処理の失敗時は、途中出力と経過時間を `.synthid/logs/` に保存し、エラーにログの場所を表示します。

除去結果は1枚の処理が成功するたびに保存されます。同じ入力ファイルを再び使う場合は、プロンプトや接続先を変えても保存済みの結果を自動で再利用します。同時に依頼した場合も除去処理を重ねて実行せず、サーバー再起動後や編集APIの失敗後にも結果は残ります。全入力の結果が保存済みなら、除去エンジンが起動できない場合でも再利用できます。

元画像と除去結果は内容が同じファイルを共有するため、再入力のたびに画像ファイルは増えません。判定はファイル全体のSHA-256で行い、ファイル名は問いません。再圧縮やメタデータの変更で内容が変わると別の画像として扱います。除去処理の実装・精度設定が変わった場合や結果ファイルが破損・欠落した場合は再処理します。

既存画像・履歴を移行する処理はありません。以前の除去結果も、対応する元画像が履歴から確認できれば、その保存場所のまま再利用します。既にある重複ファイルは削除しません。

---

### 2. 生成パラメータ

| パラメータ | 値の例 | 説明 |
|---|---|---|
| **Model / 接続先** | CometAPI: `gpt-image-2-all` と下記GPT Imageモデル / OpenAI公式: `gpt-image-2.6-flare`, `gpt-image-2.6-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini` / Nano Banana: `gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview` | モデルと接続先をまとめて選択 |
| **Number of images** | 1〜10 | 1リクエストで生成する枚数(Gemini はモデル内部で複数呼び出し) |
| **Size** | 向き × アスペクト比 × 大きさ（S=1024px / M=1536px / L=2048px / XL=2880px）の組み合わせ | 出力解像度（CometAPI・OpenAI公式）またはアスペクト比（Nano Banana）。公式のGPT Image 1 / 1.5 / 1 miniは向きに応じた標準サイズ（1024×1024 / 1536×1024 / 1024×1536、またはAuto）を使用 |
| **Image Size** *(Nano Banana のみ)* | `512` / `1K` / `2K` / `4K` | Gemini 画像の最大辺ピクセル数（`gemini-2.5-flash-image` は非対応） |
| **Quality** | `auto` / `low` / `medium` / `high` / `xhigh` / `max` | 画質（CometAPI・OpenAI公式）。`xhigh` / `max` は GPT Image 2.5 / 2.6。旧モデルに切り替えると Default に戻ります |
| **Complexity** | Default（High） / `low` / `medium` / `high` | GPT Image 2.6の生成前の検討量。画質とは独立した設定 |
| **Input fidelity** | `low` / `high` | 入力画像の再現度（Edits モード）。GPT Image 2.6では指定せず、項目を非表示にします |
| **Background** | `opaque` / `auto` / `transparent` | Auto / TransparentはGPT Image 2.5 / 2.6。透過背景にはPNG / WebPを使用 |
| **Format** | `png` / `jpeg` / `webp` / `gif` / `svg` | GIF / SVGはGPT Image 2.6。GeminiはPNG固定 |
| **GIF frames / Frame duration** | 2〜16枚 / 20〜2000ms（10ms単位） | GIF選択時に表示。初期値は9枚・200ms。サイズAutoを推奨し、256px / 512pxも選択可能 |
| **SVG author model / reasoning** | 作成モデル名 / 推論量 | SVGモデル選択の利用権限がある場合だけ指定。通常はDefaultを使用 |
| **Compression** | 0〜100 | jpeg/webp 圧縮率（CometAPI・OpenAI公式） |
| **Moderation** | `auto` / `low` | モデレーション厳密度（CometAPI・OpenAI公式） |
| **編集前にSynthIDを除去する** | オフ（初期状態） / オン | 入力画像がある場合だけ利用できるローカル前処理。履歴には `remove_synthid` として保存 |

GPT Image 2.6はCometAPI・OpenAI公式で同じ機能を選べる設計です。SVGは入力画像なし・生成枚数1に限定し、GIFは静止画の入力画像を使った生成にも対応します。GIF / SVGでは圧縮率を送信しません。生成済みGIF / SVGの **Edit as PNG** は静止画のPNGに変換して編集を開始します。

2.6の料金表示は[公式計算器](https://developers.openai.com/api/docs/guides/image-generation#calculating-costs)に基づき、画像出力分をOpenAI公式 `$30/100万トークン`、CometAPI `$24/100万トークン` で見積もります。1024×1024・Lowは公式約 **$0.02469 / 枚**、CometAPI約 **$0.01975 / 枚** です。SVGでは参考画像の出力料金にSVG作成モデルの料金が加わります。GIFは事前見積もりを表示せず、その旨を案内します。APIから返却された画像・SVGのトークン使用量は履歴のパラメータ一覧で確認できます。

GPT Image 2.5 は生成・入力画像を使った編集の両方に対応しています。
[Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) は速度を重視した日常的な生成向け、
[Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) は精密な編集向けです。
両モデルを CometAPI の認証済みモデル一覧で確認済みです（2026-09-09）。利用可否は契約・提供状況に依存します。
GPT Image 2.5 の推定料金は、[OpenAI公式計算器](https://developers.openai.com/api/docs/guides/image-generation#gpt-image-25-and-gpt-image-2-output-tokens)と
[公式の画像出力単価](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)（$30 / 100万出力トークン、2026-09-13確認）に基づきます。
CometAPI選択時は[標準20%割引](https://www.cometapi.com/pricing/)を適用した $24 / 100万出力トークンを使用します。
接続先・サイズ・品質・枚数を変えると再計算します。例えば1024×1024・MediumはCometAPIが約 **$0.01054 / 枚**、OpenAI公式が約 **$0.01317 / 枚** です。
品質が Default / Auto の場合は Low〜Max の範囲を表示し、サイズが Auto の場合は1024×1024を仮定した概算であることを明示します。
入力テキスト・入力画像・リトライの料金は別途かかり、実請求額は契約・実際の使用量により異なります。

---

### 3. リトライとキャンセル

- API 呼び出しが失敗した場合、最大 **10 回**（`MAX_RETRIES` で変更可）まで自動リトライします。リトライ中のタイルには「リトライ中… (N 回目)」と表示されます。
- APIから返されたHTTPエラーはステータスにかかわらず設定回数まで再試行します。フォームの不正な設定は送信前に停止します。
- 生成待機中・リトライ中のエントリは **Cancel** ボタンで中断できます。

#### 生成完了・リトライ上限のプッシュ通知

画面右上の **通知** を開き、**この端末の通知を有効にする** を押してブラウザの通知を許可してください。PCとスマホそれぞれで有効にすると、ページを閉じていても、そのサーバーでの生成完了・APIのリトライ上限到達を両方の端末に通知します。**テスト通知** で受信を確認できます。端末ごとにオフにできます。

通知をタップすると対象の履歴を開き、移動後に通知用の `#generation=…` をURLから取り除きます。途中のリトライ、キャンセル、SynthID前処理の失敗では送りません。通知文にプロンプトやAPIのエラー全文は含めません。登録情報と送信用の鍵は `history.db` に保存され、サーバー再起動後も引き継がれます。DBを削除・移動した場合は各端末で登録し直してください。

サーバーPCは生成と通知送信が終わるまで稼働させてください。通知の受信には端末のインターネット接続とブラウザ・OS側の通知許可が必要です。PCでブラウザ自体を完全終了した場合の配信は、ブラウザとOSのバックグラウンド実行設定に依存します。

- **同じPC**：`http://localhost:8000` でも利用できます。
- **スマホ・別のPC**：信頼された証明書を使う **HTTPS** が必要です。`http://192.168.…` のLAN接続では登録できません。
- **iPhone・iPad**：iOS / iPadOS 16.4以降で、共有メニューの **ホーム画面に追加** を行い、そのアイコンから開いて有効にしてください。[WebKitの対応案内](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

##### 自宅LANで自己署名証明書を使う

自己署名のローカルCAを端末で信頼して使う構成を想定しています。サーバーが読み込む証明書と秘密鍵は任意のPEMファイルに差し替えられます。既存の証明書やHTTPSのリバースプロキシも利用できます。

このプロジェクト用の証明書を作る場合は、次を実行します。OpenSSL 1.1.1以降が必要で、WindowsではGit for Windows付属のOpenSSLも自動検出します。独自の場所にある場合は `OPENSSL_BIN` または `--openssl` で指定できます。npmパッケージは不要です。

```powershell
node scripts/setup-https.cjs --configure
```

`certs/` に次のファイルを作成し、`.env` の `HTTPS_CERT_FILE`、`HTTPS_KEY_FILE`、`HTTPS_CA_CERT_FILE` を設定します。既存のAPIキーや他の設定は保持します。

| ファイル | 用途 |
|---|---|
| `rootCA.cer` / `rootCA.pem` | **各端末で信頼する公開CA証明書**（DER / PEM） |
| `rootCA-key.pem` | CA秘密鍵。サーバーPC内で保持し、共有しない |
| `lan-cert.pem` / `lan-key.pem` | サーバー証明書・秘密鍵 |

CAは自己署名・有効期限10年、サーバー証明書はそのCAによる署名・原則1年です。現在のLANのIPv4アドレス、PC名、localhost、ループバックアドレスをSANに含めます。同じ設定で再実行すると有効な証明書を再利用し、IPの追加・変更や期限が近い場合は同じCAでサーバー証明書を更新するため、端末にCAを登録し直す必要はありません。CAの期限切れ時は新しいCAを準備して登録し直します。

IP・DNS名を明示する場合は以下のように指定します。`--ip` と `--dns` は複数回指定できます。`--configure` を省略すると証明書の準備だけを行い、サーバー設定を変更しません。

```powershell
node scripts/setup-https.cjs --ip 192.168.1.10 --dns playground.local --configure
```

端末での信頼設定後、サーバーを再起動してHTTPSで開きます。スクリプトはOSの信頼ストアの変更やサーバーの再起動を自動では行いません。

サーバー起動後、スマホから **`http://サーバーPCのLANのIP:8001/cert/rootCA.cer`** を開くと、HTTPSの証明書をまだ信頼していなくても公開CA証明書をダウンロードできます（`PORT=8000` の場合）。同じパスはHTTPS側でも利用できます。8001番のHTTPではこの証明書だけを配布します。ポートを変更する場合は `CERT_HTTP_PORT` を指定し、必要に応じてそのHTTPポートへのLAN内接続を許可してください。

- **Windows**：`certs/rootCA.cer` を「現在のユーザー」の **信頼されたルート証明機関** にインポートします。PowerShellでは `Import-Certificate -FilePath .\certs\rootCA.cer -CertStoreLocation Cert:\CurrentUser\Root` でも登録できます。
- **iPhone・iPad**：上記HTTP URLから公開CA証明書をダウンロードしてプロファイルをインストール後、設定の **一般 → 情報 → 証明書信頼設定** で完全な信頼を有効にします。[Appleの案内](https://support.apple.com/102390)
- **Android**：上記HTTP URLから公開CA証明書をダウンロードし、端末のセキュリティ設定から **CA証明書** としてインストールします。接続に使うブラウザで警告が出ないことを確認します。

既存の自己署名証明書や別のCAの証明書を使う場合は、以下のパスを任意のPEMファイルに設定します。相対パスはプロジェクトルートを基準とし、絶対パスも指定できます。接続先のIPやDNS名をSANに含め、そのCAを接続する端末で信頼する必要があります。`WEB_PUSH_SUBJECT` には自分の連絡先を指定してください。特にAppleの通知サービスでは、localhostなどの連絡先が拒否されることがあります。

```dotenv
HTTPS_CERT_FILE=certs/lan-cert.pem
HTTPS_KEY_FILE=certs/lan-key.pem
HTTPS_CA_CERT_FILE=certs/rootCA.pem
WEB_PUSH_SUBJECT=mailto:you@example.com
```

設定後はPC・スマホとも `https://192.168.1.10:8000`（実際のLANのIPに置き換え）で開き、証明書の警告が出ないことを確認して通知を有効にします。警告画面を進むだけではService Workerや通知を利用できません。HTTPSへの切り替え後、アプリはHTTPSの8000番、証明書ダウンロードはHTTPの8001番で利用します。LANの外から通知をタップして履歴を開くには、その端末からサーバーへ接続できるVPN等も必要です。

---

### 4. 履歴の操作

- 生成結果はサーバー再起動後も保持されます。
- **Delete** ボタン：タイルを個別に削除します。全接続クライアントに即時反映されます。共有する入力画像・除去結果のキャッシュは保持されます。
- **Load** ボタン：そのエントリのプロンプトとパラメータをフォームに復元します。入力画像があった場合はドロップゾーンにも復元されます。

#### パラメータ一覧ポップアップ

タイル内のプロンプト文または生成パラメータ（モデル名など）をクリックすると、そのエントリで使用した入力パラメータ一覧がポップアップ表示されます。ポップアップ内には以下のボタンがあります。

- **プロンプトをコピー**：プロンプトの全文をクリップボードにコピーします。
- **プロンプトのみロード**：他のパラメータは変更せず、プロンプト欄だけをそのエントリの内容で上書きします。

#### 表示モード切り替え

履歴セクション右上の **Cover / Contain** ボタンで全タイルの画像フィットモードを切り替えられます。設定は次回以降も維持されます。

---

### 5. ライトボックス（全画面表示）

完了済みタイルの画像をクリック/タップすると全画面のライトボックスで表示されます。

| 操作 | PC | スマホ |
|---|---|---|
| ズームイン | ホイール上 | ピンチアウト |
| ズームアウト | ホイール下 | ピンチイン |
| パン（移動） | ドラッグ（ズーム時のみ） | ドラッグ（ズーム時のみ） |
| 次の画像 / 前の画像 | 左ボタンで左へドラッグ / 右へドラッグ（未ズーム時のみ） | 左スワイプ / 右スワイプ（未ズーム時のみ） |
| 2× ズーム | ダブルクリック（等倍時） | ダブルタップ（等倍時） |
| ズームリセット | ダブルクリック（ズーム中） | ダブルタップ（ズーム中） |
| 全画面表示切替 | ⛶ボタン / `F` キー | ⛶ボタン |
| 閉じる | Esc / 背景クリック / ×ボタン / ブラウザ戻る | 背景タップ / ×ボタン / スワイプバック |

未ズーム時は、画像や背景を左右にドラッグ／スワイプすると、指やマウスボタンを離した時に画像が切り替わります。ライトボックスを開いた時の一覧の表示順に沿って移動し、お気に入り一覧から開いた場合は、お気に入り画像だけが対象です。先頭・末尾ではそれ以上移動しません。ズーム中のドラッグ／スワイプは画像のパンとして動作します。

ブラウザの戻るボタンや iOS/Android のスワイプバックでも閉じられます。画像を何枚切り替えても、戻る操作1回で一覧へ戻れます。
