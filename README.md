# レシート家計簿 — 構築ガイド

GitHub Pages（フロント）＋ Google Apps Script（API）＋ Googleスプレッドシート（DB）＋ Google Drive（画像）＋ Gemini API（OCR）で動く、レシート読み取り付き家計簿です。

```
receipt-kakeibo/
├─ frontend/          ← GitHub Pages に置く
│   ├─ index.html
│   └─ app.js
└─ gas/               ← Apps Script に貼る
    ├─ Code.gs
    └─ appsscript.json
```

---

## 1. スプレッドシートの構造

`setup()` を実行すると、以下の4シートとヘッダー行が自動で作られます（手作業は不要）。

### Users（会員）
| 列 | 項目 | 内容 |
|---|---|---|
| A | User_ID | `U_` ＋ UUID |
| B | Email | 小文字に正規化したメールアドレス |
| C | PasswordHash | SHA-256（ソルト付き・800回ストレッチ）の16進文字列。仮パスワードのみの間は空 |
| D | Salt | ユーザーごとのランダムなソルト |
| E | Created_At | 登録日時（ISO 8601） |
| F | Must_Change | TRUE＝まだ自分のパスワードを設定していない（新規登録直後） |
| G | Temp_Hash | 仮パスワードのハッシュ |
| H | Temp_Salt | 仮パスワードのソルト |
| I | Temp_Expires_At | 仮パスワードの有効期限（発行から24時間） |
| J | Updated_At | 最終更新日時 |

> 要件の4列に **Salt** と仮パスワード関連の列を追加しています。仮パスワードは今のパスワードとは別枠で保存するので、第三者が勝手に「パスワードを忘れた方」を申請しても、本人は今のパスワードでログインを続けられます。

### Sessions（ログイン状態）
| 列 | 項目 | 内容 |
|---|---|---|
| A | Token | ログイン時に発行するトークン（UUID×2） |
| B | User_ID | 紐づく会員 |
| C | Created_At | 発行日時 |
| D | Expires_At | 有効期限（通常30日／仮パスワードでのログインは60分） |
| E | Scope | `full`＝通常ログイン／`change_password`＝仮パスワードでログイン中（パスワード設定しかできない） |

> トークンをサーバー側でも保持するためのシートです。ログアウトや期限切れを確実に判定できます。検証結果はCacheServiceにも載せるので、毎回シートを読むことはありません。

### Expenses（家計簿明細）
| 列 | 項目 | 内容 |
|---|---|---|
| A | ID | `E_` ＋ UUID |
| B | User_ID | 所有者 |
| C | Date | `YYYY-MM-DD`（書式「書式なしテキスト」に固定） |
| D | Store | 店舗名・支払先 |
| E | Category | Categoriesシートの名前 |
| F | Amount | 合計金額（整数・円） |
| G | Image_URL | DriveのレシートURL（手入力は空） |
| H | Memo | メモ |
| I | Items_JSON | 品目一覧 `[{"name":"牛乳","price":198}]` |
| J | Created_At | 登録日時 |
| K | Updated_At | 更新日時 |

> 要件の7列（A〜G）の後ろに、手入力のメモ・品目・日時の4列を追加しています。

### Categories（カテゴリ）
| Name | Color | Sort_Order |
|---|---|---|
| 食費 | #3E7C59 | 1 |
| 日用品 | #5B82B8 | 2 |
| 住居・光熱費 | #7A6A9E | 3 |
| 交際費 | #C98536 | 4 |
| 交通費 | #3F8C96 | 5 |
| 趣味・娯楽 | #B8566F | 6 |
| その他 | #8A9096 | 7 |

> ここを編集すると、入力画面の選択肢・グラフの色・Geminiへの分類候補がすべて連動します。「その他」は分類できなかったときの受け皿なので残してください。

---

## 2. GAS（バックエンド）の設定

### 2-1. プロジェクト作成
1. Googleスプレッドシートを新規作成（名前は例：`レシート家計簿DB`）。
2. メニュー **拡張機能 → Apps Script** を開く（コンテナバインドになるので `SPREADSHEET_ID` は不要）。
3. `コード.gs` の中身を `gas/Code.gs` で丸ごと置き換える。
4. **プロジェクトの設定（⚙）→「appsscript.json」マニフェスト ファイルをエディタで表示する** にチェック → `appsscript.json` を `gas/appsscript.json` で置き換える（タイムゾーンが Asia/Tokyo になります）。

### 2-2. Driveフォルダの用意
1. Googleドライブにレシート保存用フォルダを作成（例：`家計簿レシート`）。
2. フォルダを開いたときのURL `https://drive.google.com/drive/folders/【ここ】` の部分がフォルダIDです。
3. 画像は `家計簿レシート/U_xxxx/receipt_日時.jpg` のように会員ごとのサブフォルダに保存されます。
4. フォルダは**共有しない**ままにしてください。画像リンクはあなた（デプロイした本人）のアカウントでのみ開けます。

### 2-3. Gemini APIキー
1. [Google AI Studio](https://aistudio.google.com/apikey) でAPIキーを作成。

### 2-4. スクリプトプロパティ
**プロジェクトの設定（⚙）→ スクリプト プロパティ → プロパティを追加**

| プロパティ | 値 | 必須 |
|---|---|---|
| `GEMINI_API_KEY` | AI Studioで作ったキー | ○ |
| `DRIVE_FOLDER_ID` | 2-2のフォルダID | ○ |
| `APP_URL` | GitHub PagesのURL（例 `https://kenken6291.github.io/receipt-kakeibo/`）。仮パスワードのメールに載ります | 推奨 |
| `SPREADSHEET_ID` | スタンドアロンGASにした場合のみ、スプレッドシートID | － |
| `GEMINI_MODEL` | 既定は `gemini-2.5-flash`。変えたいときだけ | － |

### 2-5. 初期化と動作確認
1. エディタ上部の関数選択で **`setup`** を選び「実行」。初回は権限の承認を求められるので許可する。
2. 実行ログに `GEMINI_API_KEY: 設定済み` `DRIVE_FOLDER_ID: 設定済み` とフォルダ名が出ればOK。スプレッドシートに4シートができています。
3. **`testGeminiConnection`** を実行し、ログが `200 …接続OK…` になればGemini連携もOK。
4. **`testSendMail`** を実行。メール送信の権限を承認すると、自分宛てにテストメールが届きます（仮パスワードのメールはこのGoogleアカウントから送信されます）。

> 以前のバージョンから更新する場合も `setup()` をもう一度実行してください。Users・Sessionsシートのヘッダーに新しい列が追加されます（既存データはそのまま使えます）。

### 2-6. Webアプリとして公開
1. **デプロイ → 新しいデプロイ → 種類：ウェブアプリ**
2. 次のユーザーとして実行：**自分**
3. アクセスできるユーザー：**全員**
4. 「デプロイ」→ 表示された **ウェブアプリURL（…/exec）** をコピー。

> コードを修正したら **デプロイを管理 → 編集（鉛筆）→ バージョン：新バージョン → デプロイ** で更新してください。「新しいデプロイ」にするとURLが変わってしまいます。

### 2-7. 期限切れセッションの掃除（任意）
ログイン時にも10%の確率で自動掃除しますが、確実にしたい場合は **トリガー → トリガーを追加 → `cleanupSessions` / 時間主導型 / 日付ベース** を設定してください。

---

## 3. フロントエンド（GitHub Pages）の設定

1. `frontend/app.js` 冒頭の `API_URL` を 2-6 のURLに書き換える。
   ```js
   const API_URL = 'https://script.google.com/macros/s/AKfy..../exec';
   ```
2. `index.html` と `app.js` をリポジトリ（例：`kenken6291/receipt-kakeibo`）のルートに置いてpush。
3. **Settings → Pages → Branch: main / (root)** で公開。
4. `https://kenken6291.github.io/receipt-kakeibo/` を開き、新規登録 → レシート撮影で動作確認。

---

## 4. 会員登録・パスワードの流れ

**新規登録**
1. 「新規登録」でメールアドレスだけ入力 →「仮パスワードを送信」
2. 届いたメールの仮パスワードでログイン
3. 「新しいパスワードの設定」画面で自分のパスワードを決める → 家計簿が使えるようになる

**パスワードを忘れた場合**
1. ログイン画面の「パスワードを忘れた方」→ メールアドレスを入力 →「仮パスワードを送信」
2. 仮パスワードでログイン → 新しいパスワードを設定
   ※ 途中で元のパスワードを思い出したら、そのままログインできます（未使用の仮パスワードは無効になります）。

**ログイン中の変更**
- 画面上部の「パスワード変更」から、現在のパスワード＋新しいパスワードで変更できます。

**共通のルール**
- パスワード入力欄にはすべて「表示／隠す」ボタンがあります。
- パスワードは8文字以上、英字と数字を両方含めます。
- 仮パスワードの有効期限は24時間。同じメールアドレスへの送信は3分に1回まで。
- 仮パスワードでログインした状態では、パスワード設定以外の操作はサーバー側で拒否されます。
- パスワードを変更すると、ほかの端末のログインはすべて解除されます。
- 仮パスワードの申請画面では、そのメールアドレスが登録済みかどうかを答えません（他人の登録状況を調べられないようにするため）。
- 無料のGoogleアカウントでは、GASから送れるメールは1日100通までです。

---

## 5. 通信とセキュリティの仕組み

- **CORS**：フロントは `Content-Type: text/plain` でPOSTします。これで「単純リクエスト」になり、GASが対応できないプリフライト（OPTIONS）が発生しません。GASの応答は `ContentService.MimeType.JSON` で返し、リダイレクト先から読み取れます。
- **トークンの受け渡し**：GASの `doPost` はリクエストヘッダーを読めないため、トークンはリクエスト本文の `token` に入れて送ります。
- **パスワード**：ソルト付きSHA-256を800回繰り返したハッシュで保存。5回連続で失敗すると、そのメールアドレスは15分間ログインできません。GASで使える範囲の対策であり、bcryptなどの専用アルゴリズムほど強くはない点はご承知おきください。
- **画像**：スマホで撮った写真はブラウザ側で長辺1600pxのJPEGに縮小してから送信するため、通信量とGeminiの処理時間が抑えられます。
- **Gemini**：`responseMimeType: application/json` と `responseSchema`（カテゴリは列挙型）でJSON形式を強制しています。429/5xxは最大3回まで自動で再試行します。読み取りに失敗しても画像は保存済みなので、フォームに手入力して登録できます。
- **削除**：明細を削除すると、レシート画像はDriveの**ゴミ箱へ移動**します（完全削除はしません。30日後にGoogleが自動で削除）。

---

## 6. API一覧（`action`）

| action | 認証 | payload | 返り値 |
|---|---|---|---|
| `register` | － | `{email}` | `{sent, email, expiresHours}`（仮パスワードをメール送信） |
| `requestTempPassword` | － | `{email}` | `{sent, email, expiresHours}` |
| `login` | － | `{email, password}` | `{token, user, mustChange, categories}` |
| `changePassword` | 仮も可 | `{currentPassword?, newPassword}` | `{token, user, mustChange:false, categories}` |
| `logout` | 仮も可 | － | `{loggedOut}` |
| `me` | 仮も可 | － | `{user, mustChange, categories}` |
| `analyzeReceipt` | ○ | `{imageBase64, mimeType}` | `{parsed, warning, imageUrl, fileId}` |
| `saveExpense` | ○ | `{id?, date, store, category, amount, memo, items, imageUrl}` | `{id}` |
| `deleteExpense` | ○ | `{id}` | `{id}` |
| `listExpenses` | ○ | `{limit?, month?}` | `{items, total}` |
| `getSummary` | ○ | `{months}`（1〜24） | `{months, series, monthTotals, current, previous}` |

---

## 7. よくあるつまずき

| 症状 | 原因と対処 |
|---|---|
| 「サーバーの応答を読み取れませんでした」 | アクセスできるユーザーが「全員」になっていない／URLが `/dev` になっている。`/exec` のURLを使う。 |
| 「シート『Users』がありません」 | `setup()` を実行していない。 |
| 「スクリプトプロパティ … が未設定です」 | 2-4のプロパティ名のスペルを確認。 |
| 仮パスワードのメールが届かない | `testSendMail` を実行して権限を承認したか確認。迷惑メールフォルダも確認。実行数ログに `MailApp` のエラーが出ていないか見る。 |
| 「新しいパスワードを設定してください」と出る | 仮パスワードでログイン中です。パスワードを設定すると使えるようになります。 |
| レシート読み取りだけ失敗する | `testGeminiConnection` を実行してログを確認。APIキーの制限やモデル名の誤りが多い。 |
| コードを直したのに反映されない | 「デプロイを管理」から新バージョンで更新したか確認。ブラウザのキャッシュも再読み込み。 |
