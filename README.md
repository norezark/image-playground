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

```bash
PORT=8080 MAX_RETRIES=5 node server.js
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

---

### 2. 生成パラメータ

| パラメータ | 値の例 | 説明 |
|---|---|---|
| **Model / 接続先** | CometAPI: `gpt-image-2-all` と下記GPT Imageモデル / OpenAI公式: `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini` / Nano Banana: `gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview` | モデルと接続先をまとめて選択 |
| **Number of images** | 1〜10 | 1リクエストで生成する枚数(Gemini はモデル内部で複数呼び出し) |
| **Size** | 向き × アスペクト比 × 大きさ（S=1024px / M=1536px / L=2048px / XL=2880px）の組み合わせ | 出力解像度（CometAPI・OpenAI公式）またはアスペクト比（Nano Banana）。公式のGPT Image 1 / 1.5 / 1 miniは向きに応じた標準サイズ（1024×1024 / 1536×1024 / 1024×1536、またはAuto）を使用 |
| **Image Size** *(Nano Banana のみ)* | `512` / `1K` / `2K` / `4K` | Gemini 画像の最大辺ピクセル数（`gemini-2.5-flash-image` は非対応） |
| **Quality** | `auto` / `low` / `medium` / `high` / `xhigh` / `max` | 画質（CometAPI・OpenAI公式）。`xhigh` / `max` は GPT Image 2.5 のみ。旧モデルに切り替えると Default に戻ります |
| **Input fidelity** | `low` / `high` | 入力画像の再現度（Edits モード・CometAPI・OpenAI公式） |
| **Background** | `opaque` | 背景設定（CometAPI・OpenAI公式） |
| **Format** | `png` / `jpeg` / `webp` | 出力ファイル形式（CometAPI・OpenAI公式。Gemini は PNG 固定） |
| **Compression** | 0〜100 | jpeg/webp 圧縮率（CometAPI・OpenAI公式） |
| **Moderation** | `auto` / `low` | モデレーション厳密度（CometAPI・OpenAI公式） |

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
- 生成待機中・リトライ中のエントリは **Cancel** ボタンで中断できます。

---

### 4. 履歴の操作

- 生成結果はサーバー再起動後も保持されます。
- **Delete** ボタン：タイルを個別に削除します。全接続クライアントに即時反映されます。
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
