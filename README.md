> [!NOTE]
> このプロジェクトは全てGitHub Copilot製のため、不自然なドキュメントやコードが存在する可能性があります。

# Image Playground

OpenAI CometAPI および Google Gemini の画像生成 API を手軽に試せるローカル Web アプリです。  
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

#### テキストからの生成

1. プロンプト入力欄に生成したい画像の説明を入力する。
2. 必要に応じてモデル・サイズ・クオリティなどのパラメータを設定する。
3. **Generate** ボタンを押す。
4. 画面下部の履歴グリッドにタイルが追加され、生成完了後に画像が表示される。

#### 入力画像を使った編集（Edits モード）

1. フォーム上部のドロップゾーンに画像をドラッグ＆ドロップ、またはクリックしてファイルを選択する（最大 16 枚）。
2. 入力画像が 1 枚以上セットされると自動的に編集モードに切り替わる。
3. プロンプトで変更内容を指示して **Generate** を押す。

---

### 2. 生成パラメータ

| パラメータ | 値の例 | 説明 |
|---|---|---|
| **Model** | CometAPI: `gpt-image-2-all`, `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini` / Nano Banana: `gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview` | 使用するモデル |
| **Number of images** | 1〜8 | 1リクエストで生成する枚数（Gemini はモデル内部で複数呼び出し） |
| **Size** | 向き × アスペクト比 × 大きさ（S=1024px / M=1536px / L=2048px / XL=2880px）の組み合わせ | 出力解像度（CometAPI）またはアスペクト比（Nano Banana） |
| **Image Size** *(Nano Banana のみ)* | `512` / `1K` / `2K` / `4K` | Gemini 画像の最大辺ピクセル数（`gemini-2.5-flash-image` は非対応） |
| **Quality** | `low` / `medium` / `high` | 画質（CometAPI のみ） |
| **Input fidelity** | `low` / `high` | 入力画像の再現度（Edits モード・CometAPI のみ） |
| **Background** | `opaque` | 背景設定（CometAPI のみ） |
| **Format** | `png` / `jpeg` / `webp` | 出力ファイル形式（CometAPI のみ。Gemini は PNG 固定） |
| **Compression** | 0〜100 | jpeg/webp 圧縮率（CometAPI のみ） |
| **Moderation** | `auto` / `low` | モデレーション厳密度（CometAPI のみ） |

---

### 3. リトライとキャンセル

- API 呼び出しが失敗した場合、最大 **10 回**（`MAX_RETRIES` で変更可）まで自動リトライします。リトライ中のタイルには「リトライ中… (N 回目)」と表示されます。
- 生成待機中・リトライ中のエントリは **Cancel** ボタンで中断できます。

---

### 4. 履歴の操作

- 生成結果はサーバー再起動後も保持されます。
- **Delete** ボタン：タイルを個別に削除します。全接続クライアントに即時反映されます。
- **Load** ボタン：そのエントリのプロンプトとパラメータをフォームに復元します。入力画像があった場合はドロップゾーンにも復元されます。

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
| 2× ズーム | ダブルクリック（等倍時） | ダブルタップ（等倍時） |
| ズームリセット | ダブルクリック（ズーム中） | ダブルタップ（ズーム中） |
| 全画面表示切替 | ⛶ボタン / `F` キー | ⛶ボタン |
| 閉じる | Esc / 背景クリック / ×ボタン / ブラウザ戻る | 背景タップ / ×ボタン / スワイプバック |

ブラウザの戻るボタンや iOS/Android のスワイプジェスチャーでも閉じられます。
