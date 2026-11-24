/**
 * レシート家計簿 — バックエンド API（Google Apps Script）
 *
 * 通信仕様
 *   POST  body(JSON文字列): { action: string, token?: string, payload?: object }
 *   応答               : { ok: true, data: any } | { ok: false, error: string, code?: string }
 *   ※ フロントは Content-Type: text/plain で送信（CORSプリフライト回避）
 *
 * スクリプトプロパティ
 *   GEMINI_API_KEY   (必須) Gemini APIキー
 *   DRIVE_FOLDER_ID  (必須) レシート画像の保存先フォルダID
 *   APP_URL          (推奨) GitHub PagesのURL（仮パスワードメールに記載）
 *   SPREADSHEET_ID   (任意) 未設定ならコンテナバインドのスプレッドシートを使用
 *   GEMINI_MODEL     (任意) 画面で「自動モード」を選んだ時に使うモデル。未設定なら汎用の最新モデル
 *
 * Geminiモデルの決定順
 *   1. 画面の「読み取りに使うAIモデル」で選んだモデル
 *   2. スクリプトプロパティ GEMINI_MODEL
 *   3. 汎用の最新モデル FALLBACK_GEMINI_MODELS を先頭から順に試す
 *   ※ 指定モデルに該当がない（廃止・未公開・名前違い）場合は、自動で 3 に切り替えて再実行する
 *   ※ モデル名は "gemini-" で始まる英小文字・数字・ハイフン・ドットのみ受け付ける
 *
 * 初回は setup() を一度実行してシートを作成してください。
 * 仮パスワードのメール送信のため、testSendMail() を一度実行して権限を承認してください。
 */

// ============================================================
// 設定
// ============================================================
const APP = {
  NAME: 'レシート家計簿',
  HASH_ITERATIONS: 800,             // パスワードハッシュのストレッチ回数
  SESSION_DAYS: 30,                 // 通常セッションの有効日数
  CHANGE_SESSION_MINUTES: 60,       // 仮パスワードでログインした後、再設定までの猶予
  TEMP_PASSWORD_HOURS: 24,          // 仮パスワードの有効時間
  TEMP_PASSWORD_LENGTH: 10,
  MAIL_INTERVAL_SECONDS: 180,       // 同じメールアドレスへの送信間隔
  MAX_IMAGE_BYTES: 7 * 1024 * 1024, // 受け付ける画像の上限（デコード後）
  LOGIN_MAX_FAILS: 5,               // 連続失敗でロック
  LOGIN_LOCK_SECONDS: 15 * 60,      // ロック時間
  VERSION: 'v1.2.0'                 // GASバックエンドのバージョン（デプロイ時に更新）
};

// 指定なし・該当なしの時に使う汎用最新モデル（先頭から順に試す）
//   gemini-flash-latest : Googleが常に最新の汎用モデルへ自動で差し替えるエイリアス
//   gemini-4-hydrogen   : 2026年11月時点の汎用最新モデル（「日々の暮らしをサポート」）
//   gemini-3.8-flash    : 最終的な保険
const FALLBACK_GEMINI_MODELS = ['gemini-flash-latest', 'gemini-4-hydrogen', 'gemini-3.8-flash'];
const GEMINI_MODEL_PATTERN = /^gemini-[a-z0-9][a-z0-9.\-]{0,60}$/;

const SHEETS = {
  USERS: {
    name: 'Users',
    headers: ['User_ID', 'Email', 'PasswordHash', 'Salt', 'Created_At',
              'Must_Change', 'Temp_Hash', 'Temp_Salt', 'Temp_Expires_At', 'Updated_At']
  },
  SESSIONS: {
    name: 'Sessions',
    headers: ['Token', 'User_ID', 'Created_At', 'Expires_At', 'Scope']
  },
  EXPENSES: {
    name: 'Expenses',
    headers: ['ID', 'User_ID', 'Date', 'Store', 'Category', 'Amount', 'Image_URL', 'Memo', 'Items_JSON', 'Created_At', 'Updated_At']
  },
  INCOMES: {
    name: 'Incomes',
    headers: ['ID', 'User_ID', 'Month', 'Source', 'Amount', 'Memo', 'Created_At', 'Updated_At']
  },
  CATEGORIES: {
    name: 'Categories',
    headers: ['Name', 'Color', 'Sort_Order', 'User_ID']   // User_ID が空の行＝新規会員の初期値
  }
};

// Users シートの列番号（1始まり）
const UC = {
  ID: 1, EMAIL: 2, HASH: 3, SALT: 4, CREATED: 5,
  MUST_CHANGE: 6, TEMP_HASH: 7, TEMP_SALT: 8, TEMP_EXPIRES: 9, UPDATED: 10
};

// セッションの種類
const SCOPE = {
  FULL: 'full',                 // 通常ログイン
  CHANGE: 'change_password'     // 仮パスワードでログイン中（パスワード再設定のみ可）
};

const DEFAULT_CATEGORIES = [
  ['食費', '#3E7C59', 1],
  ['日用品', '#5B82B8', 2],
  ['住居・光熱費', '#7A6A9E', 3],
  ['交際費', '#C98536', 4],
  ['交通費', '#3F8C96', 5],
  ['趣味・娯楽', '#B8566F', 6],
  ['その他', '#8A9096', 7]
];

const FALLBACK_CATEGORY = 'その他';   // 削除・名前変更できない受け皿の種別
const CATEGORY_MAX = 30;
const CATEGORY_NAME_MAX = 20;

// ============================================================
// エラー
// ============================================================
class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AppError';
    this.code = code || 'BAD_REQUEST';
  }
}

// ============================================================
// エントリーポイント
// ============================================================
function doGet() {
  return json_({ ok: true, data: { service: 'receipt-kakeibo-api', version: APP.VERSION, time: new Date().toISOString() } });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの形式が正しくありません。', code: 'BAD_REQUEST' });
  }

  const action = String(body.action || '');
  const route = getRoutes_()[action];

  try {
    if (!route) throw new AppError('不明な操作です: ' + action);

    let user = null;
    if (route.auth !== 'none') {
      user = requireSession_(body.token);
      if (route.auth === 'full' && user.scope !== SCOPE.FULL) {
        throw new AppError('新しいパスワードを設定してください。', 'MUST_CHANGE');
      }
    }
    const data = route.fn(body.payload || {}, user, body.token);
    return json_({ ok: true, data: data });
  } catch (err) {
    if (err instanceof AppError) {
      return json_({ ok: false, error: err.message, code: err.code });
    }
    console.error(action, err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。', code: 'SERVER' });
  }
}

/** auth: 'none' = 認証不要 / 'any' = 仮パスワードログイン中も可 / 'full' = 通常ログインのみ */
function getRoutes_() {
  return {
    getVersion:          { auth: 'none', fn: getVersion_ },
    register:            { auth: 'none', fn: register_ },
    requestTempPassword: { auth: 'none', fn: requestTempPassword_ },
    login:               { auth: 'none', fn: login_ },
    logout:              { auth: 'any',  fn: logout_ },
    me:                  { auth: 'any',  fn: me_ },
    changePassword:      { auth: 'any',  fn: changePassword_ },
    analyzeReceipt:      { auth: 'full', fn: analyzeReceipt_ },
    saveExpense:         { auth: 'full', fn: saveExpense_ },
    deleteExpense:       { auth: 'full', fn: deleteExpense_ },
    listIncomes:         { auth: 'full', fn: listIncomes_ },
    saveIncome:          { auth: 'full', fn: saveIncome_ },
    deleteIncome:        { auth: 'full', fn: deleteIncome_ },
    copyIncomes:         { auth: 'full', fn: copyIncomes_ },
    listExpenses:        { auth: 'full', fn: listExpenses_ },
    getSummary:          { auth: 'full', fn: getSummary_ },
    getCategories:       { auth: 'full', fn: function (p, user) { return { categories: getCategories_(user.id) }; } },
    addCategory:         { auth: 'full', fn: addCategory_ },
    updateCategory:      { auth: 'full', fn: updateCategory_ },
    deleteCategory:      { auth: 'full', fn: deleteCategory_ },
    reorderCategories:   { auth: 'full', fn: reorderCategories_ }
  };
}

// ============================================================
// 初期セットアップ（エディタから実行。列を追加したときも再実行してOK）
// ============================================================
function setup() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(function (key) {
    const def = SHEETS[key];
    const sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    // ヘッダー行を最新の定義で上書き（列は末尾に追加しているので既存データはずれない）
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  // 文字列として保持したい列（自動で日付・数値に変換されるのを防ぐ）
  ss.getSheetByName(SHEETS.EXPENSES.name).getRange('C:C').setNumberFormat('@');
  ss.getSheetByName(SHEETS.SESSIONS.name).getRange('A:A').setNumberFormat('@');
  ss.getSheetByName(SHEETS.INCOMES.name).getRange('C:C').setNumberFormat('@');

  const cat = ss.getSheetByName(SHEETS.CATEGORIES.name);
  if (cat.getLastRow() < 2) {
    cat.getRange(2, 1, DEFAULT_CATEGORIES.length, 4)
      .setValues(DEFAULT_CATEGORIES.map(function (r) { return r.concat(['']); }));
  }

  const props = PropertiesService.getScriptProperties();
  ['GEMINI_API_KEY', 'DRIVE_FOLDER_ID', 'APP_URL'].forEach(function (k) {
    Logger.log(k + ': ' + (props.getProperty(k) ? '設定済み' : '★未設定★'));
  });
  if (props.getProperty('DRIVE_FOLDER_ID')) {
    Logger.log('Driveフォルダ: ' + DriveApp.getFolderById(props.getProperty('DRIVE_FOLDER_ID')).getName());
  }
  Logger.log('メール送信の残り回数（本日）: ' + MailApp.getRemainingDailyQuota());
  Logger.log('セットアップ完了: ' + ss.getUrl());
}

/** 期限切れセッションの一括削除（時間主導トリガーに設定しても可） */
function cleanupSessions() {
  rewriteSessions_(function (r) { return new Date(r[3]).getTime() > Date.now(); });
}

// ============================================================
// 会員登録・仮パスワード
// ============================================================

/** 新規登録：メールアドレスだけ受け取り、仮パスワードをメールで送る */
function register_(p) {
  const email = normalizeEmail_(p.email);
  validateEmail_(email);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let rowNumber;
  let temp;
  try {
    if (findUserByEmail_(email)) {
      throw new AppError(
        'このメールアドレスはすでに登録されています。パスワードがわからない場合は「パスワードを忘れた方」から仮パスワードを発行してください。',
        'EMAIL_TAKEN');
    }
    throttleMail_(email);

    temp = buildTempPassword_();
    const now = nowIso_();
    const sh = sheet_(SHEETS.USERS);
    sh.appendRow(['U_' + Utilities.getUuid(), email, '', '', now,
                  true, temp.hash, temp.salt, temp.expiresIso, now]);
    rowNumber = sh.getLastRow();
  } finally {
    lock.releaseLock();
  }

  try {
    sendTempPasswordMail_(email, temp, 'register');
  } catch (err) {
    // メールが届かなければログインできないので、登録を取り消す
    console.error('mail failed', err);
    try { sheet_(SHEETS.USERS).deleteRow(rowNumber); } catch (e) { /* noop */ }
    CacheService.getScriptCache().remove('mail:' + email);
    throw new AppError('仮パスワードのメールを送信できませんでした。メールアドレスを確認して、もう一度お試しください。', 'MAIL_FAILED');
  }

  return { sent: true, email: email, expiresHours: APP.TEMP_PASSWORD_HOURS };
}

/** パスワードを忘れた場合：仮パスワードを発行してメールで送る */
function requestTempPassword_(p) {
  const email = normalizeEmail_(p.email);
  validateEmail_(email);
  throttleMail_(email);

  const user = findUserByEmail_(email);
  if (user) {
    // 今のパスワードは残したまま、仮パスワードを別枠で発行する
    // （第三者が勝手に申請しても、本人は今のパスワードでログインを続けられる）
    const temp = buildTempPassword_();
    updateUser_(user.row, {
      TEMP_HASH: temp.hash, TEMP_SALT: temp.salt, TEMP_EXPIRES: temp.expiresIso, UPDATED: nowIso_()
    });
    try {
      sendTempPasswordMail_(email, temp, 'reset');
    } catch (err) {
      console.error('mail failed', err);
      CacheService.getScriptCache().remove('mail:' + email);
      throw new AppError('仮パスワードのメールを送信できませんでした。時間をおいてもう一度お試しください。', 'MAIL_FAILED');
    }
  }
  // 登録の有無は答えない（他人のメールアドレスの登録状況を調べられないようにする）
  return { sent: true, email: email, expiresHours: APP.TEMP_PASSWORD_HOURS };
}

function buildTempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password;
  do {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Utilities.getUuid() + Date.now() + Math.random());
    password = '';
    for (let i = 0; i < APP.TEMP_PASSWORD_LENGTH; i++) {
      password += chars[((bytes[i] + 256) % 256) % chars.length];
    }
  } while (!/[A-Za-z]/.test(password) || !/\d/.test(password));

  const salt = Utilities.getUuid().replace(/-/g, '');
  const expires = new Date(Date.now() + APP.TEMP_PASSWORD_HOURS * 3600000);
  return {
    password: password,
    salt: salt,
    hash: hashPassword_(password, salt),
    expires: expires,
    expiresIso: expires.toISOString()
  };
}

function sendTempPasswordMail_(email, temp, kind) {
  const appUrl = PropertiesService.getScriptProperties().getProperty('APP_URL') || '';
  const tz = Session.getScriptTimeZone();
  const expiresText = Utilities.formatDate(temp.expires, tz, 'yyyy年M月d日 H:mm');

  const subject = kind === 'register'
    ? '【' + APP.NAME + '】仮パスワードのお知らせ（会員登録）'
    : '【' + APP.NAME + '】仮パスワードのお知らせ（パスワード再設定）';

  const lines = [
    kind === 'register'
      ? APP.NAME + 'へのご登録ありがとうございます。'
      : APP.NAME + 'のパスワード再設定のお申し込みを受け付けました。',
    '',
    '仮パスワード： ' + temp.password,
    '有効期限　　： ' + expiresText + ' まで',
    '',
    '下のページを開き、メールアドレスと仮パスワードでログインしてください。',
    'ログイン後に、ご自分で決めた新しいパスワードを設定していただきます。',
    appUrl ? appUrl : '',
    ''
  ];
  if (kind === 'reset') {
    lines.push('お心当たりがない場合は、このメールを破棄してください。');
    lines.push('今お使いのパスワードは、そのままご利用いただけます。');
  } else {
    lines.push('お心当たりがない場合は、このメールを破棄してください。');
  }
  lines.push('', '※このメールは送信専用です。');

  MailApp.sendEmail({
    to: email,
    subject: subject,
    body: lines.join('\n'),
    name: APP.NAME
  });
}

function throttleMail_(email) {
  const cache = CacheService.getScriptCache();
  const key = 'mail:' + email;
  if (cache.get(key)) {
    throw new AppError('少し前に仮パスワードを送信しました。メールが届いていない場合は、3分ほど待ってからもう一度お試しください。', 'THROTTLED');
  }
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new AppError('本日はこれ以上メールを送信できません。明日もう一度お試しください。', 'MAIL_QUOTA');
  }
  cache.put(key, '1', APP.MAIL_INTERVAL_SECONDS);
}

// ============================================================
// ログイン・ログアウト・パスワード変更
// ============================================================
function login_(p) {
  const email = normalizeEmail_(p.email);
  const password = String(p.password || '');
  if (!email || !password) throw new AppError('メールアドレスとパスワードを入力してください。');

  const cache = CacheService.getScriptCache();
  const failKey = 'fail:' + email;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= APP.LOGIN_MAX_FAILS) {
    throw new AppError('ログインに続けて失敗したため、15分間ログインできません。パスワードがわからない場合は「パスワードを忘れた方」から仮パスワードを発行してください。', 'LOCKED');
  }

  const user = findUserByEmail_(email);
  let scope = null;
  let usedTemp = false;

  if (user) {
    if (user.hash && user.salt && safeEqual_(hashPassword_(password, user.salt), user.hash)) {
      scope = user.mustChange ? SCOPE.CHANGE : SCOPE.FULL;
    } else if (user.tempHash && user.tempSalt &&
               new Date(user.tempExpires).getTime() > Date.now() &&
               safeEqual_(hashPassword_(password, user.tempSalt), user.tempHash)) {
      scope = SCOPE.CHANGE;
      usedTemp = true;
    }
  }

  if (!scope) {
    cache.put(failKey, String(fails + 1), APP.LOGIN_LOCK_SECONDS);
    const expiredTemp = user && user.tempHash && new Date(user.tempExpires).getTime() <= Date.now();
    throw new AppError(
      expiredTemp
        ? 'メールアドレスまたはパスワードが違います。仮パスワードは有効期限が切れている可能性があります。'
        : 'メールアドレスまたはパスワードが違います。',
      'LOGIN_FAILED');
  }
  cache.remove(failKey);

  // 今のパスワードでログインできた＝思い出せたので、未使用の仮パスワードは無効にする
  if (!usedTemp && user.tempHash) {
    updateUser_(user.row, { TEMP_HASH: '', TEMP_SALT: '', TEMP_EXPIRES: '' });
  }

  if (Math.random() < 0.1) {
    try { cleanupSessions(); } catch (e) { console.warn('cleanup skipped', e); }
  }

  const mustChange = scope !== SCOPE.FULL;
  return {
    token: createSession_(user.id, scope),
    user: { id: user.id, email: user.email },
    mustChange: mustChange,
    categories: mustChange ? [] : getCategories_(user.id)
  };
}

function logout_(p, user, token) {
  CacheService.getScriptCache().remove('sess:' + token);
  rewriteSessions_(function (r) { return r[0] !== token; });
  return { loggedOut: true };
}

function me_(p, user) {
  const u = findUserById_(user.id);
  if (!u) throw new AppError('アカウントが見つかりません。もう一度ログインしてください。', 'AUTH');
  const mustChange = user.scope !== SCOPE.FULL;
  return {
    user: { id: u.id, email: u.email },
    mustChange: mustChange,
    categories: mustChange ? [] : getCategories_(u.id)
  };
}

/**
 * パスワード変更
 *  - 仮パスワードでログイン中：現在のパスワードは不要
 *  - 通常ログイン中        ：現在のパスワードが必要
 * 変更後は全端末のログインを無効にし、新しいトークンを返す
 */
function changePassword_(p, user) {
  const u = findUserById_(user.id);
  if (!u) throw new AppError('アカウントが見つかりません。もう一度ログインしてください。', 'AUTH');

  const newPassword = String(p.newPassword || '');

  if (user.scope === SCOPE.FULL) {
    const current = String(p.currentPassword || '');
    if (!current) throw new AppError('現在のパスワードを入力してください。');
    if (!u.hash || !safeEqual_(hashPassword_(current, u.salt), u.hash)) {
      throw new AppError('現在のパスワードが違います。', 'BAD_CURRENT');
    }
  }

  validatePassword_(newPassword, u.email);

  if (u.hash && u.salt && safeEqual_(hashPassword_(newPassword, u.salt), u.hash)) {
    throw new AppError('今までと同じパスワードは使えません。別のパスワードを設定してください。');
  }
  if (u.tempHash && u.tempSalt && safeEqual_(hashPassword_(newPassword, u.tempSalt), u.tempHash)) {
    throw new AppError('仮パスワードとは別の、ご自分で決めたパスワードを設定してください。');
  }

  const salt = Utilities.getUuid().replace(/-/g, '');
  updateUser_(u.row, {
    HASH: hashPassword_(newPassword, salt),
    SALT: salt,
    MUST_CHANGE: false,
    TEMP_HASH: '', TEMP_SALT: '', TEMP_EXPIRES: '',
    UPDATED: nowIso_()
  });

  revokeUserSessions_(u.id);
  CacheService.getScriptCache().remove('fail:' + u.email);

  return {
    token: createSession_(u.id, SCOPE.FULL),
    user: { id: u.id, email: u.email },
    mustChange: false,
    categories: getCategories_(u.id)
  };
}

// ============================================================
// 入力チェック・ハッシュ
// ============================================================
function validateEmail_(email) {
  if (!email) throw new AppError('メールアドレスを入力してください。');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError('メールアドレスの形式が正しくありません。');
  }
}

function validatePassword_(password, email) {
  if (password.length < 8) throw new AppError('パスワードは8文字以上にしてください。');
  if (password.length > 128) throw new AppError('パスワードは128文字以内にしてください。');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new AppError('パスワードには英字と数字を両方含めてください。');
  }
  if (/\s/.test(password)) throw new AppError('パスワードに空白は使えません。');
  if (email && password.toLowerCase() === String(email).toLowerCase()) {
    throw new AppError('メールアドレスと同じパスワードは使えません。');
  }
}

function normalizeEmail_(v) {
  return String(v || '').trim().toLowerCase();
}

function hashPassword_(password, salt) {
  const saltBytes = Utilities.newBlob(salt).getBytes();
  let digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8);
  for (let i = 1; i < APP.HASH_ITERATIONS; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest.concat(saltBytes));
  }
  return toHex_(digest);
}

function toHex_(bytes) {
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ============================================================
// Users シート
// ============================================================
function readUsers_() {
  const sh = sheet_(SHEETS.USERS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SHEETS.USERS.headers.length).getValues().map(function (r, i) {
    return {
      row: i + 2,
      id: r[UC.ID - 1],
      email: String(r[UC.EMAIL - 1]).toLowerCase(),
      hash: String(r[UC.HASH - 1] || ''),
      salt: String(r[UC.SALT - 1] || ''),
      mustChange: r[UC.MUST_CHANGE - 1] === true || String(r[UC.MUST_CHANGE - 1]).toUpperCase() === 'TRUE',
      tempHash: String(r[UC.TEMP_HASH - 1] || ''),
      tempSalt: String(r[UC.TEMP_SALT - 1] || ''),
      tempExpires: r[UC.TEMP_EXPIRES - 1] || ''
    };
  });
}

function findUserByEmail_(email) {
  const users = readUsers_();
  for (let i = 0; i < users.length; i++) if (users[i].email === email) return users[i];
  return null;
}

function findUserById_(id) {
  const users = readUsers_();
  for (let i = 0; i < users.length; i++) if (users[i].id === id) return users[i];
  return null;
}

/** fields: { HASH: '...', MUST_CHANGE: false, ... }（キーは UC の名前） */
function updateUser_(row, fields) {
  const sh = sheet_(SHEETS.USERS);
  Object.keys(fields).forEach(function (k) {
    if (!UC[k]) throw new Error('unknown user column: ' + k);
    sh.getRange(row, UC[k]).setValue(fields[k]);
  });
}

// ============================================================
// セッション
// ============================================================
function createSession_(userId, scope) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const now = new Date();
  const lifeMs = scope === SCOPE.FULL
    ? APP.SESSION_DAYS * 86400000
    : APP.CHANGE_SESSION_MINUTES * 60000;
  const expires = new Date(now.getTime() + lifeMs);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet_(SHEETS.SESSIONS).appendRow([token, userId, now.toISOString(), expires.toISOString(), scope]);
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().put(
    'sess:' + token, JSON.stringify({ id: userId, scope: scope }), Math.min(21600, Math.floor(lifeMs / 1000)));
  return token;
}

function requireSession_(token) {
  if (!token || typeof token !== 'string') throw new AppError('ログインしてください。', 'AUTH');

  const cache = CacheService.getScriptCache();
  const cached = cache.get('sess:' + token);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 読み直す */ }
  }

  const sh = sheet_(SHEETS.SESSIONS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const rows = sh.getRange(2, 1, last - 1, SHEETS.SESSIONS.headers.length).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] !== token) continue;
      const remainMs = new Date(rows[i][3]).getTime() - Date.now();
      if (remainMs <= 0) break;
      const session = { id: rows[i][1], scope: rows[i][4] || SCOPE.FULL };
      cache.put('sess:' + token, JSON.stringify(session),
        Math.max(1, Math.min(21600, Math.floor(remainMs / 1000))));
      return session;
    }
  }
  throw new AppError('ログインの有効期限が切れました。もう一度ログインしてください。', 'AUTH');
}

/** そのユーザーの全セッションを無効にする（パスワード変更時） */
function revokeUserSessions_(userId) {
  const cache = CacheService.getScriptCache();
  rewriteSessions_(function (r) {
    if (r[1] === userId) { cache.remove('sess:' + r[0]); return false; }
    return true;
  });
}

/** keep(row) が true の行だけ残して Sessions シートを書き直す */
function rewriteSessions_(keep) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(SHEETS.SESSIONS);
    const last = sh.getLastRow();
    if (last < 2) return;
    const width = SHEETS.SESSIONS.headers.length;
    const values = sh.getRange(2, 1, last - 1, width).getValues();
    const alive = values.filter(keep);
    if (alive.length === values.length) return;
    sh.getRange(2, 1, last - 1, width).clearContent();
    if (alive.length) sh.getRange(2, 1, alive.length, width).setValues(alive);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// カテゴリ（種別）— 会員ごとに持つ
//   Categories シートで User_ID が空の行 = 新規会員の初期値
//   会員が一度でも編集すると、その会員専用の行がコピーされる
// ============================================================
function readCategoryRows_() {
  const sh = sheet_(SHEETS.CATEGORIES);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SHEETS.CATEGORIES.headers.length).getValues()
    .filter(function (r) { return String(r[0]).trim(); });
}

function rowsToCategories_(rows) {
  return rows
    .slice()
    .sort(function (a, b) { return Number(a[2]) - Number(b[2]); })
    .map(function (r) { return { name: String(r[0]).trim(), color: String(r[1] || '#8A9096') }; });
}

function defaultCategories_(rows) {
  const base = (rows || readCategoryRows_()).filter(function (r) { return !String(r[3] || ''); });
  if (base.length) return rowsToCategories_(base);
  return DEFAULT_CATEGORIES.map(function (r) { return { name: r[0], color: r[1] }; });
}

function getCategories_(userId) {
  const rows = readCategoryRows_();
  const mine = rows.filter(function (r) { return userId && r[3] === userId; });
  const list = mine.length ? rowsToCategories_(mine) : defaultCategories_(rows);
  // 受け皿の「その他」は必ず存在させる
  if (!list.some(function (c) { return c.name === FALLBACK_CATEGORY; })) {
    list.push({ name: FALLBACK_CATEGORY, color: '#8A9096' });
  }
  return list;
}

function categoryNames_(userId) {
  return getCategories_(userId).map(function (c) { return c.name; });
}

/** 会員の種別一覧を丸ごと書き換える（呼び出し側でロックを取ること） */
function writeUserCategories_(userId, list) {
  const sh = sheet_(SHEETS.CATEGORIES);
  const width = SHEETS.CATEGORIES.headers.length;
  const last = sh.getLastRow();
  const all = last >= 2 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  const others = all.filter(function (r) { return String(r[0]).trim() && r[3] !== userId; });
  const mine = list.map(function (c, i) { return [c.name, c.color, i + 1, userId]; });
  const rows = others.concat(mine);
  if (last >= 2) sh.getRange(2, 1, last - 1, width).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
}

function validateCategoryName_(name) {
  name = String(name || '').trim();
  if (!name) throw new AppError('種別の名前を入力してください。');
  if (name.length > CATEGORY_NAME_MAX) throw new AppError('種別の名前は' + CATEGORY_NAME_MAX + '文字以内にしてください。');
  if (/^__/.test(name)) throw new AppError('この名前は使えません。');
  return name;
}

function validateColor_(color, fallback) {
  color = String(color || '').trim();
  if (!color) return fallback || '#8A9096';
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new AppError('色の指定が正しくありません。');
  return color.toUpperCase();
}

function withCategoryLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 種別を追加 */
function addCategory_(p, user) {
  const name = validateCategoryName_(p.name);
  const color = validateColor_(p.color, '#5B82B8');
  return withCategoryLock_(function () {
    const list = getCategories_(user.id);
    if (list.some(function (c) { return c.name === name; })) {
      throw new AppError('「' + name + '」はすでにあります。');
    }
    if (list.length >= CATEGORY_MAX) throw new AppError('種別は' + CATEGORY_MAX + '個までです。');
    // 「その他」は常に最後に置く
    const idx = list.findIndex(function (c) { return c.name === FALLBACK_CATEGORY; });
    list.splice(idx >= 0 ? idx : list.length, 0, { name: name, color: color });
    writeUserCategories_(user.id, list);
    return { categories: getCategories_(user.id) };
  });
}

/** 種別の名前・色を変更（名前を変えたら、登録済みの支出・品目も新しい名前に置き換える） */
function updateCategory_(p, user) {
  const oldName = String(p.oldName || '').trim();
  const name = validateCategoryName_(p.name);
  return withCategoryLock_(function () {
    const list = getCategories_(user.id);
    const target = list.find(function (c) { return c.name === oldName; });
    if (!target) throw new AppError('種別「' + oldName + '」が見つかりません。', 'NOT_FOUND');
    if (oldName === FALLBACK_CATEGORY && name !== FALLBACK_CATEGORY) {
      throw new AppError('「' + FALLBACK_CATEGORY + '」は名前を変えられません（色は変更できます）。');
    }
    if (name !== oldName && list.some(function (c) { return c.name === name; })) {
      throw new AppError('「' + name + '」はすでにあります。別の名前にしてください。');
    }
    target.name = name;
    target.color = validateColor_(p.color, target.color);
    writeUserCategories_(user.id, list);

    let changed = 0;
    if (name !== oldName) changed = reassignCategory_(user.id, oldName, name);
    return { categories: getCategories_(user.id), changedExpenses: changed };
  });
}

/** 種別を削除（その種別の支出・品目は moveTo の種別へ移す） */
function deleteCategory_(p, user) {
  const name = String(p.name || '').trim();
  if (name === FALLBACK_CATEGORY) throw new AppError('「' + FALLBACK_CATEGORY + '」は削除できません。');
  return withCategoryLock_(function () {
    const list = getCategories_(user.id);
    if (!list.some(function (c) { return c.name === name; })) {
      throw new AppError('種別「' + name + '」が見つかりません。', 'NOT_FOUND');
    }
    const moveTo = String(p.moveTo || FALLBACK_CATEGORY);
    if (moveTo === name || !list.some(function (c) { return c.name === moveTo; })) {
      throw new AppError('移動先の種別を選び直してください。');
    }
    writeUserCategories_(user.id, list.filter(function (c) { return c.name !== name; }));
    const changed = reassignCategory_(user.id, name, moveTo);
    return { categories: getCategories_(user.id), changedExpenses: changed };
  });
}

/** 並び順を保存（names の順に並べる。「その他」は最後） */
function reorderCategories_(p, user) {
  const names = Array.isArray(p.names) ? p.names.map(String) : [];
  return withCategoryLock_(function () {
    const list = getCategories_(user.id);
    const byName = {};
    list.forEach(function (c) { byName[c.name] = c; });
    const ordered = [];
    names.forEach(function (n) {
      if (byName[n] && n !== FALLBACK_CATEGORY) { ordered.push(byName[n]); delete byName[n]; }
    });
    list.forEach(function (c) { if (byName[c.name] && c.name !== FALLBACK_CATEGORY) ordered.push(c); });
    ordered.push(list.find(function (c) { return c.name === FALLBACK_CATEGORY; }));
    writeUserCategories_(user.id, ordered);
    return { categories: getCategories_(user.id) };
  });
}

/** その会員の支出（全体カテゴリ・品目の種別）を from → to に置き換える。戻り値は変更した支出の件数 */
function reassignCategory_(userId, from, to) {
  const sh = sheet_(SHEETS.EXPENSES);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  // B(User_ID)〜I(Items_JSON) を読み、E(Category) と I(Items_JSON) だけ書き戻す
  const range = sh.getRange(2, 2, last - 1, 8);
  const rows = range.getValues();
  let changed = 0;
  rows.forEach(function (r, i) {
    if (r[0] !== userId) return;
    let dirty = false;
    if (r[3] === from) { r[3] = to; dirty = true; }
    const items = parseJson_(r[7], []);
    let itemsDirty = false;
    items.forEach(function (it) { if (it.category === from) { it.category = to; itemsDirty = true; } });
    if (itemsDirty) { r[7] = JSON.stringify(items); dirty = true; }
    if (dirty) {
      sh.getRange(i + 2, 5).setValue(r[3]);
      sh.getRange(i + 2, 9).setValue(r[7]);
      changed++;
    }
  });
  return changed;
}


// ============================================================
// レシート解析（Drive保存 → Gemini）
// ============================================================
function analyzeReceipt_(p, user) {
  const mimeType = String(p.mimeType || '').toLowerCase();
  if (['image/jpeg', 'image/png'].indexOf(mimeType) === -1) {
    throw new AppError('JPGまたはPNGの画像を送信してください。');
  }
  const base64 = String(p.imageBase64 || '').replace(/^data:[^,]+,/, '');
  if (!base64) throw new AppError('画像データがありません。');

  const bytes = Utilities.base64Decode(base64);
  if (bytes.length > APP.MAX_IMAGE_BYTES) {
    throw new AppError('画像が大きすぎます。7MB以下の画像を選んでください。');
  }

  // 1) Driveへ保存
  const file = saveReceiptImage_(bytes, mimeType, user.id);

  // 2) Geminiで解析（失敗しても画像は保存済みなので手入力で続行できるようにする）
  const requestedModel = resolveGeminiModel_(p.model);
  let usedModel = requestedModel;
  let parsed = null;
  let warning = '';
  try {
    const result = callGemini_(base64, mimeType, categoryNames_(user.id), requestedModel);
    parsed = result.parsed;
    usedModel = result.usedModel;
    if (!parsed.isReceipt) warning = 'レシートとして読み取れませんでした。内容を確認して入力してください。';
  } catch (err) {
    console.error('Gemini error', err && err.stack ? err.stack : err);
    warning = (err instanceof AppError) ? err.message : 'レシートの読み取りに失敗しました。手入力で補ってください。';
  }

  return {
    parsed: parsed,
    warning: warning,
    imageUrl: file.getUrl(),
    fileId: file.getId(),
    model: usedModel,
    requestedModel: requestedModel,
    fallback: usedModel !== requestedModel
  };
}

function saveReceiptImage_(bytes, mimeType, userId) {
  const root = DriveApp.getFolderById(requiredProp_('DRIVE_FOLDER_ID'));
  const it = root.getFoldersByName(userId);
  const folder = it.hasNext() ? it.next() : root.createFolder(userId);
  const tz = Session.getScriptTimeZone();
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const name = 'receipt_' + Utilities.formatDate(new Date(), tz, 'yyyyMMdd_HHmmss') + '_' +
    Utilities.getUuid().slice(0, 8) + '.' + ext;
  return folder.createFile(Utilities.newBlob(bytes, mimeType, name));
}

/** バージョン情報（認証不要。画面下部の表示用） */
function getVersion_() {
  return {
    gasVersion: APP.VERSION,
    defaultModel: resolveGeminiModel_(''),
    fallbackModels: FALLBACK_GEMINI_MODELS
  };
}

/**
 * 使用するGeminiモデル名を決定する。画面の指定 → スクリプトプロパティ → 汎用の最新モデル の順。
 * 不正な名前は無視する。
 */
function resolveGeminiModel_(requested) {
  const req = String(requested || '').trim().toLowerCase();
  if (req && GEMINI_MODEL_PATTERN.test(req)) return req;
  const prop = String(PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || '').trim().toLowerCase();
  if (prop && GEMINI_MODEL_PATTERN.test(prop)) return prop;
  return FALLBACK_GEMINI_MODELS[0];
}

/** モデルが存在しない（廃止・名前違い・未公開）ことを示す応答かどうか */
function isModelNotFound_(code, text) {
  if (code === 404) return true;
  if (code === 400) return /not found|is not supported|NOT_FOUND|unknown model|invalid model/i.test(text);
  return false;
}

/** 思考設定（thinkingConfig）をそのモデルが受け付けないことを示す応答かどうか */
function isThinkingConfigRejected_(code, text) {
  return code === 400 && /thinking/i.test(text);
}

/**
 * 1モデルに対してGemini APIを呼ぶ。混雑(429/5xx)時は待ち時間を伸ばしながら最大3回まで再試行。
 * 思考設定を受け付けないモデルなら、思考設定を外して1回だけ再実行する。
 */
function fetchGemini_(model, apiKey, body) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const send = function (b) {
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(b),
      muteHttpExceptions: true
    };
    let code = 0, text = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = UrlFetchApp.fetch(url, options);
      code = res.getResponseCode();
      text = res.getContentText();
      if (code === 200) break;
      if (code === 429 || code >= 500) {
        Utilities.sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      break;
    }
    return { code: code, text: text };
  };

  let r = send(body);
  if (isThinkingConfigRejected_(r.code, r.text) && body.generationConfig && body.generationConfig.thinkingConfig) {
    const b2 = JSON.parse(JSON.stringify(body));
    delete b2.generationConfig.thinkingConfig;
    console.warn('Geminiモデル「' + model + '」は思考設定を受け付けないため、外して再実行します');
    r = send(b2);
  }
  return r;
}

/**
 * 思考（thinking）を省いて速く返すための設定。モデル世代で書き方が違うため分ける。
 *   gemini-2.5 系 : thinkingBudget: 0
 *   それ以外（3系・4系・latest等）: thinkingLevel: 'low'
 * 受け付けないモデルは fetchGemini_ が自動で外して再実行する。
 */
function thinkingConfigFor_(model) {
  if (/^gemini-2\.5-/.test(model)) return { thinkingBudget: 0 };
  return { thinkingLevel: 'low' };
}

function callGemini_(base64, mimeType, categories, model) {
  const apiKey = requiredProp_('GEMINI_API_KEY');
  const geminiModel = model || resolveGeminiModel_('');
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const prompt = [
    'あなたは日本のレシート・領収書を読み取る専門家です。画像から家計簿用の情報を抽出してください。',
    '',
    '# ルール',
    '- is_receipt: 画像がレシート・領収書・請求書でなければ false。その場合も他の項目は分かる範囲で埋める。',
    '- date: 購入日を YYYY-MM-DD 形式で。和暦（令和・R）は西暦に変換。年が省略されている場合は今日（' + today + '）を基準に最も近い過去の日付にする。読み取れなければ null。',
    '- store: 店舗名・支払先。正式名称が分かればそれを使う（支店名は含めてよい）。',
    '- total: 実際に支払った税込の合計金額（整数・円）。「合計」「お支払い」「ご請求額」を優先。お預かり・お釣りと混同しない。',
    '- items: 品目ごとの名称・金額（整数・円）・カテゴリ。値引き・割引・クーポンは負の金額の品目として含め、カテゴリは値引き対象の品目と同じにする。小計・税・合計・お預かり・お釣りの行は含めない。',
    '- items[].category: 品目ごとに、次のいずれか1つを選ぶ: ' + categories.join('、'),
    '  同じレシートでも品目によってカテゴリが違ってよい（例：スーパーで食品→食費、洗剤→日用品）。',
    '- category: 支出全体として最も適切なもの（通常は金額が最も大きいカテゴリ）を、同じ候補から1つ選ぶ。',
    '  目安: スーパー・コンビニの食品や飲食店→食費、ドラッグストア・100円ショップの消耗品→日用品、電気・ガス・水道・家賃→住居・光熱費、',
    '  贈答品・飲み会→交際費、電車・バス・タクシー・ガソリン・駐車場→交通費、本・映画・ゲーム・趣味用品・レジャー→趣味・娯楽。',
    '- 金額の数字は桁区切りや「¥」「円」を除いた整数で返す。'
  ].join('\n');

  const schema = {
    type: 'OBJECT',
    properties: {
      is_receipt: { type: 'BOOLEAN' },
      date: { type: 'STRING', nullable: true, description: 'YYYY-MM-DD' },
      store: { type: 'STRING' },
      total: { type: 'INTEGER' },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            price: { type: 'INTEGER' },
            category: { type: 'STRING', enum: categories }
          },
          required: ['name', 'price', 'category'],
          propertyOrdering: ['name', 'price', 'category']
        }
      },
      category: { type: 'STRING', enum: categories }
    },
    required: ['is_receipt', 'date', 'store', 'total', 'items', 'category'],
    propertyOrdering: ['is_receipt', 'date', 'store', 'total', 'items', 'category']
  };

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType, data: base64 } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  // 指定モデル → 汎用の最新モデル（順番に）で、該当があるまで試す
  const candidates = [geminiModel].concat(FALLBACK_GEMINI_MODELS.filter(function (m) { return m !== geminiModel; }));
  let usedModel = geminiModel;
  let code = 0, text = '';
  for (let i = 0; i < candidates.length; i++) {
    usedModel = candidates[i];
    body.generationConfig.thinkingConfig = thinkingConfigFor_(usedModel);
    const r = fetchGemini_(usedModel, apiKey, body);
    code = r.code;
    text = r.text;
    if (!isModelNotFound_(code, text)) break;
    console.warn('Geminiモデル「' + usedModel + '」に該当がないため次の候補に切り替えます');
  }

  if (code !== 200) {
    console.error('Gemini HTTP ' + code + ' (' + usedModel + '): ' + text);
    if (code === 429) throw new AppError('読み取りが混み合っています。少し待ってからもう一度お試しください。', 'RATE_LIMIT');
    throw new AppError('レシートの読み取りに失敗しました（' + code + '）。手入力で補ってください。', 'GEMINI');
  }

  const result = JSON.parse(text);
  const cand = result.candidates && result.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  if (!parts || !parts.length) {
    throw new AppError('レシートの内容を読み取れませんでした。明るい場所で撮り直してください。', 'GEMINI');
  }
  const raw = parts.map(function (x) { return x.text || ''; }).join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return { parsed: normalizeParsed_(JSON.parse(raw), categories, today), usedModel: usedModel };
}

function normalizeParsed_(obj, categories, today) {
  const category = categories.indexOf(obj.category) >= 0 ? obj.category : FALLBACK_CATEGORY;
  const items = sanitizeItems_(obj.items, categories, category);

  let total = toInt_(obj.total);
  if (total === null || total < 0) {
    total = items.reduce(function (s, it) { return s + it.price; }, 0);
  }

  const date = isValidDate_(obj.date) ? obj.date : today;

  return {
    isReceipt: obj.is_receipt !== false,
    date: date,
    dateDetected: isValidDate_(obj.date),
    store: String(obj.store || '').trim().slice(0, 100),
    total: Math.max(0, total),
    items: items,
    category: category
  };
}

// ============================================================
// 品目とカテゴリ（種別）
// ============================================================

/** 品目を整形。カテゴリ（種別）が候補外・未設定なら、レシート全体のカテゴリを使う */
function sanitizeItems_(items, categories, fallbackCategory) {
  return (Array.isArray(items) ? items : [])
    .map(function (it) {
      const cat = categories.indexOf(it && it.category) >= 0 ? it.category : fallbackCategory;
      return { name: String((it && it.name) || '').trim().slice(0, 100), price: toInt_(it && it.price), category: cat };
    })
    .filter(function (it) { return it.name && it.price !== null; })
    .slice(0, 100);
}

/**
 * 1件の支出を、品目のカテゴリごとの金額に振り分ける。
 *  - 品目がない／カテゴリが1種類 → 合計金額をすべて明細のカテゴリ（または品目のカテゴリ）へ
 *  - 複数カテゴリ → 品目金額の比率で合計金額を按分（税・端数も比率で配分し、合計は必ず一致）
 *  - 値引きなどでカテゴリの小計が0以下になったものは配分しない
 * 戻り値: [{ category, amount }]（金額の大きい順）
 */
function allocateExpense_(expense, validNames) {
  const valid = {};
  validNames.forEach(function (n) { valid[n] = true; });
  const base = valid[expense.category] ? expense.category : FALLBACK_CATEGORY;
  const amount = Number(expense.amount) || 0;

  const sums = {};
  (expense.items || []).forEach(function (it) {
    const c = valid[it.category] ? it.category : base;
    sums[c] = (sums[c] || 0) + (Number(it.price) || 0);
  });
  const cats = Object.keys(sums).filter(function (c) { return sums[c] > 0; });

  if (cats.length === 0) return [{ category: base, amount: amount }];
  if (cats.length === 1) return [{ category: cats[0], amount: amount }];

  const positiveTotal = cats.reduce(function (s, c) { return s + sums[c]; }, 0);
  const parts = cats.map(function (c) {
    const exact = amount * sums[c] / positiveTotal;
    return { category: c, amount: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let remain = amount - parts.reduce(function (s, x) { return s + x.amount; }, 0);
  parts.slice().sort(function (a, b) { return b.frac - a.frac; }).forEach(function (x) {
    if (remain > 0) { x.amount++; remain--; }
  });
  return parts
    .filter(function (x) { return x.amount > 0; })
    .map(function (x) { return { category: x.category, amount: x.amount }; })
    .sort(function (a, b) { return b.amount - a.amount; });
}

// ============================================================
// 明細 CRUD
// ============================================================
function saveExpense_(p, user) {
  const date = String(p.date || '');
  if (!isValidDate_(date)) throw new AppError('日付を正しく入力してください。');

  const amount = toInt_(p.amount);
  if (amount === null || amount < 0) throw new AppError('金額は0以上の整数で入力してください。');
  if (amount > 100000000) throw new AppError('金額が大きすぎます。');

  const cats = categoryNames_(user.id);
  const category = cats.indexOf(p.category) >= 0 ? p.category : FALLBACK_CATEGORY;
  const store = String(p.store || '').trim().slice(0, 100);
  const memo = String(p.memo || '').trim().slice(0, 500);
  const items = sanitizeItems_(p.items, cats, category);
  const imageUrl = /^https:\/\/drive\.google\.com\//.test(String(p.imageUrl || '')) ? String(p.imageUrl) : '';
  const now = nowIso_();

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_(SHEETS.EXPENSES);

    if (p.id) {
      const row = findExpenseRow_(sh, String(p.id), user.id);
      if (row < 0) throw new AppError('明細が見つかりません。すでに削除された可能性があります。', 'NOT_FOUND');
      const current = sh.getRange(row, 1, 1, SHEETS.EXPENSES.headers.length).getValues()[0];
      const keepImage = imageUrl || current[6];
      sh.getRange(row, 3, 1, 9).setValues([[
        date, store, category, amount, keepImage, memo, JSON.stringify(items), current[9], now
      ]]);
      return { id: String(p.id) };
    }

    const id = 'E_' + Utilities.getUuid();
    sh.appendRow([id, user.id, date, store, category, amount, imageUrl, memo, JSON.stringify(items), now, now]);
    // appendRow後も日付が文字列のままになるよう念のため書式を指定
    sh.getRange(sh.getLastRow(), 3).setNumberFormat('@').setValue(date);
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

function deleteExpense_(p, user) {
  const id = String(p.id || '');
  if (!id) throw new AppError('削除する明細が指定されていません。');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let imageUrl = '';
  try {
    const sh = sheet_(SHEETS.EXPENSES);
    const row = findExpenseRow_(sh, id, user.id);
    if (row < 0) throw new AppError('明細が見つかりません。すでに削除された可能性があります。', 'NOT_FOUND');
    imageUrl = String(sh.getRange(row, 7).getValue() || '');
    sh.deleteRow(row);
  } finally {
    lock.releaseLock();
  }

  // レシート画像はゴミ箱へ移動（完全削除はしない）
  const m = imageUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || imageUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) {
    try { DriveApp.getFileById(m[1]).setTrashed(true); } catch (e) { console.warn('trash failed', e); }
  }
  return { id: id };
}

function listExpenses_(p, user) {
  const limit = Math.min(Math.max(parseInt(p.limit, 10) || 20, 1), 5000);
  const month = /^\d{4}-\d{2}$/.test(String(p.month || '')) ? String(p.month) : '';

  let rows = readUserExpenses_(user.id);
  if (month) rows = rows.filter(function (r) { return r.date.slice(0, 7) === month; });
  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(a.createdAt) < String(b.createdAt) ? 1 : -1;
  });

  const names = categoryNames_(user.id);
  const items = rows.slice(0, limit).map(function (r) {
    r.breakdown = allocateExpense_(r, names);
    return r;
  });
  return { items: items, total: rows.length };
}

/**
 * 集計
 *  payload: { from: 'YYYY-MM', to: 'YYYY-MM' }（旧形式 { months: n } も可＝直近nか月）
 *  返り値:
 *   months / series / monthTotals / incomeTotals / balances … 期間内の月ごとの値（グラフ・表用）
 *   period         … 期間の合計（支出・収入・収支・件数・種別内訳・月平均）
 *   previousPeriod … 直前の同じ長さの期間の合計（比較用）
 *   current        … 今月の値（互換用）
 */
function getSummary_(p, user) {
  const MAX_MONTHS = 36;
  const tz = Session.getScriptTimeZone();
  const nowKey = Utilities.formatDate(new Date(), tz, 'yyyy-MM');

  let to = isValidMonth_(String(p.to || '')) ? String(p.to) : nowKey;
  let from;
  if (isValidMonth_(String(p.from || ''))) {
    from = String(p.from);
  } else {
    const n = Math.min(Math.max(parseInt(p.months, 10) || 6, 1), MAX_MONTHS);
    from = addMonths_(to, -(n - 1));
  }
  if (from > to) { const t = from; from = to; to = t; }
  if (monthDiff_(from, to) + 1 > MAX_MONTHS) from = addMonths_(to, -(MAX_MONTHS - 1));

  const span = monthDiff_(from, to) + 1;
  const keys = [];
  for (let i = 0; i < span; i++) keys.push(addMonths_(from, i));
  const prevTo = addMonths_(from, -1);
  const prevFrom = addMonths_(from, -span);

  const cats = getCategories_(user.id);
  const names = cats.map(function (c) { return c.name; });

  // 月×種別の支出（品目ごとの種別で按分）
  const table = {};
  const countByMonth = {};
  const expenseByMonth = {};
  readUserExpenses_(user.id).forEach(function (r) {
    const k = r.date.slice(0, 7);
    countByMonth[k] = (countByMonth[k] || 0) + 1;
    expenseByMonth[k] = (expenseByMonth[k] || 0) + r.amount;
    if (k < from || k > to) return;
    if (!table[k]) table[k] = {};
    allocateExpense_(r, names).forEach(function (part) {
      table[k][part.category] = (table[k][part.category] || 0) + part.amount;
    });
  });

  // 月ごとの収入
  const incomeByMonth = {};
  readUserIncomes_(user.id).forEach(function (r) {
    incomeByMonth[r.month] = (incomeByMonth[r.month] || 0) + r.amount;
  });

  const series = cats.map(function (c) {
    return {
      category: c.name,
      color: c.color,
      values: keys.map(function (k) { return (table[k] && table[k][c.name]) || 0; })
    };
  }).filter(function (x) { return x.values.some(function (v) { return v > 0; }); });

  const monthTotals = keys.map(function (k) { return expenseByMonth[k] || 0; });
  const incomeTotals = keys.map(function (k) { return incomeByMonth[k] || 0; });
  const balances = keys.map(function (k, i) { return incomeTotals[i] - monthTotals[i]; });
  const sum = function (arr) { return arr.reduce(function (a, b) { return a + b; }, 0); };

  const byCategory = series
    .map(function (x) { return { category: x.category, color: x.color, amount: sum(x.values) }; })
    .filter(function (x) { return x.amount > 0; })
    .sort(function (a, b) { return b.amount - a.amount; });

  const periodTotal = sum(monthTotals);
  const periodIncome = sum(incomeTotals);
  const rangeSum = function (map, a, b) {
    let t = 0;
    for (let k = a; k <= b; k = addMonths_(k, 1)) t += map[k] || 0;
    return t;
  };
  const prevTotal = rangeSum(expenseByMonth, prevFrom, prevTo);
  const prevIncome = rangeSum(incomeByMonth, prevFrom, prevTo);

  const curExpense = expenseByMonth[nowKey] || 0;
  const curIncome = incomeByMonth[nowKey] || 0;

  return {
    months: keys,
    series: series,
    monthTotals: monthTotals,
    incomeTotals: incomeTotals,
    balances: balances,
    period: {
      from: from,
      to: to,
      monthsCount: span,
      total: periodTotal,
      income: periodIncome,
      balance: periodIncome - periodTotal,
      count: keys.reduce(function (s, k) { return s + (countByMonth[k] || 0); }, 0),
      byCategory: byCategory,
      avgExpense: Math.round(periodTotal / span),
      avgIncome: Math.round(periodIncome / span)
    },
    previousPeriod: {
      from: prevFrom,
      to: prevTo,
      total: prevTotal,
      income: prevIncome,
      balance: prevIncome - prevTotal
    },
    current: {
      month: nowKey,
      total: curExpense,
      count: countByMonth[nowKey] || 0,
      income: curIncome,
      balance: curIncome - curExpense
    }
  };
}

/** 'YYYY-MM' に n か月を足す */
function addMonths_(key, n) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/** from から to までの月数の差 */
function monthDiff_(from, to) {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
}

// ============================================================
// 収入（月単位。1か月に複数件登録できる：給与・年金など）
// ============================================================
function isValidMonth_(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function readUserIncomes_(userId) {
  const sh = sheet_(SHEETS.INCOMES);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, last - 1, SHEETS.INCOMES.headers.length).getValues()
    .filter(function (r) { return r[1] === userId; })
    .map(function (r) {
      return {
        id: r[0],
        month: r[2] instanceof Date ? Utilities.formatDate(r[2], tz, 'yyyy-MM') : String(r[2]),
        source: String(r[3] || ''),
        amount: Number(r[4]) || 0,
        memo: String(r[5] || ''),
        createdAt: r[6] instanceof Date ? r[6].toISOString() : String(r[6] || '')
      };
    });
}

function findIncomeRow_(sh, id, userId) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const rows = sh.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === id && rows[i][1] === userId) return i + 2;
  }
  return -1;
}

/** 指定月の収入一覧（月合計・支出合計・収支つき） */
function listIncomes_(p, user) {
  const month = String(p.month || '');
  if (!isValidMonth_(month)) throw new AppError('月を正しく指定してください。');

  const items = readUserIncomes_(user.id)
    .filter(function (r) { return r.month === month; })
    .sort(function (a, b) { return String(a.createdAt) < String(b.createdAt) ? -1 : 1; });
  const income = items.reduce(function (s, r) { return s + r.amount; }, 0);
  const expense = readUserExpenses_(user.id)
    .filter(function (r) { return r.date.slice(0, 7) === month; })
    .reduce(function (s, r) { return s + r.amount; }, 0);

  // 登録済みの収入の種類（入力候補用）
  const sources = [];
  readUserIncomes_(user.id).forEach(function (r) {
    if (r.source && sources.indexOf(r.source) < 0) sources.push(r.source);
  });

  return { month: month, items: items, income: income, expense: expense, balance: income - expense, sources: sources };
}

function saveIncome_(p, user) {
  const month = String(p.month || '');
  if (!isValidMonth_(month)) throw new AppError('月を正しく入力してください。');
  const source = String(p.source || '').trim().slice(0, 30) || '収入';
  const amount = toInt_(p.amount);
  if (amount === null || amount < 0) throw new AppError('金額は0以上の整数で入力してください。');
  if (amount > 1000000000) throw new AppError('金額が大きすぎます。');
  const memo = String(p.memo || '').trim().slice(0, 200);
  const now = nowIso_();

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_(SHEETS.INCOMES);
    if (p.id) {
      const row = findIncomeRow_(sh, String(p.id), user.id);
      if (row < 0) throw new AppError('収入が見つかりません。すでに削除された可能性があります。', 'NOT_FOUND');
      sh.getRange(row, 3).setNumberFormat('@');
      sh.getRange(row, 3, 1, 4).setValues([[month, source, amount, memo]]);
      sh.getRange(row, 8).setValue(now);
      return { id: String(p.id) };
    }
    const id = 'I_' + Utilities.getUuid();
    sh.appendRow([id, user.id, month, source, amount, memo, now, now]);
    sh.getRange(sh.getLastRow(), 3).setNumberFormat('@').setValue(month);
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

function deleteIncome_(p, user) {
  const id = String(p.id || '');
  if (!id) throw new AppError('削除する収入が指定されていません。');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_(SHEETS.INCOMES);
    const row = findIncomeRow_(sh, id, user.id);
    if (row < 0) throw new AppError('収入が見つかりません。すでに削除された可能性があります。', 'NOT_FOUND');
    sh.deleteRow(row);
    return { id: id };
  } finally {
    lock.releaseLock();
  }
}

/** from 月の収入を to 月へコピー（毎月同じ年金・給与の入力を省く） */
function copyIncomes_(p, user) {
  const from = String(p.from || '');
  const to = String(p.to || '');
  if (!isValidMonth_(from) || !isValidMonth_(to) || from === to) {
    throw new AppError('コピー元とコピー先の月を正しく指定してください。');
  }
  const src = readUserIncomes_(user.id).filter(function (r) { return r.month === from; });
  if (!src.length) throw new AppError(from.slice(0, 4) + '年' + Number(from.slice(5)) + '月の収入は登録されていません。', 'NOT_FOUND');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_(SHEETS.INCOMES);
    const now = nowIso_();
    const rows = src.map(function (r) {
      return ['I_' + Utilities.getUuid(), user.id, to, r.source, r.amount, r.memo, now, now];
    });
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 3, rows.length, 1).setNumberFormat('@');
    sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
    return { copied: rows.length };
  } finally {
    lock.releaseLock();
  }
}

function readUserExpenses_(userId) {
  const sh = sheet_(SHEETS.EXPENSES);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, last - 1, SHEETS.EXPENSES.headers.length).getValues()
    .filter(function (r) { return r[1] === userId; })
    .map(function (r) {
      return {
        id: r[0],
        date: r[2] instanceof Date ? Utilities.formatDate(r[2], tz, 'yyyy-MM-dd') : String(r[2]),
        store: String(r[3] || ''),
        category: String(r[4] || FALLBACK_CATEGORY),
        amount: Number(r[5]) || 0,
        imageUrl: String(r[6] || ''),
        memo: String(r[7] || ''),
        items: parseJson_(r[8], []),
        createdAt: r[9] instanceof Date ? r[9].toISOString() : String(r[9] || '')
      };
    });
}

function findExpenseRow_(sh, id, userId) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const rows = sh.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === id && rows[i][1] === userId) return i + 2;
  }
  return -1;
}

// ============================================================
// ユーティリティ
// ============================================================
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートが見つかりません。SPREADSHEET_ID を設定してください。');
  return ss;
}

function sheet_(def) {
  const sh = ss_().getSheetByName(def.name);
  if (!sh) throw new Error('シート「' + def.name + '」がありません。setup() を実行してください。');
  return sh;
}

function requiredProp_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('スクリプトプロパティ ' + key + ' が未設定です。');
  return v;
}

function nowIso_() {
  return new Date().toISOString();
}

function isValidDate_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.getFullYear() === parts[0] && d.getMonth() === parts[1] - 1 && d.getDate() === parts[2];
}

function toInt_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,，¥￥円\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseJson_(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

// ============================================================
// 動作確認用（エディタから実行）
// ============================================================
function testGeminiConnection() {
  const apiKey = requiredProp_('GEMINI_API_KEY');
  const body = { contents: [{ parts: [{ text: '「接続OK」とだけ返してください。' }] }] };
  const first = resolveGeminiModel_('');
  const candidates = [first].concat(FALLBACK_GEMINI_MODELS.filter(function (m) { return m !== first; }));
  for (let i = 0; i < candidates.length; i++) {
    const r = fetchGemini_(candidates[i], apiKey, body);
    Logger.log('[' + candidates[i] + '] ' + r.code + ' ' + r.text.slice(0, 300));
    if (!isModelNotFound_(r.code, r.text)) break;
  }
  Logger.log('GASバージョン: ' + APP.VERSION);
}

/** 画面の選択肢にあるモデルが、今のAPIキーで使えるかを一覧で確認する（エディタから実行） */
function testGeminiModels() {
  const apiKey = requiredProp_('GEMINI_API_KEY');
  const body = { contents: [{ parts: [{ text: 'OK' }] }] };
  ['gemini-flash-latest', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon',
   'gemini-3.8-flash', 'gemini-3.5-flash'].forEach(function (m) {
    const r = fetchGemini_(m, apiKey, body);
    Logger.log((r.code === 200 ? '○ ' : '× ') + m + ' → ' + r.code + (r.code === 200 ? '' : ' ' + r.text.slice(0, 120)));
  });
}

/** メール送信の権限承認と動作確認（自分宛てにテストメールを送る） */
function testSendMail() {
  const me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({
    to: me,
    subject: '【' + APP.NAME + '】メール送信テスト',
    body: 'このメールが届いていれば、仮パスワードのメール送信は正常に動作します。',
    name: APP.NAME
  });
  Logger.log('送信しました: ' + me + '（本日の残り: ' + MailApp.getRemainingDailyQuota() + '通）');
}
