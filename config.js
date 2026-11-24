// ============================================================
// レシート家計簿 設定ファイル
// GAS URL・Geminiモデル・バージョンはここだけ書き換えればOK
// ============================================================
window.APP_CONFIG = {
  // フロントエンドのバージョン（画面下部に表示）
  APP_VERSION: 'v1.2.0',

  // GASのWebアプリ公開URL（.../exec）
  GAS_EXEC_URL: 'https://script.google.com/macros/s/AKfycbzJmO3WWtFMzSEMQupzHG-5jUGSKBrtI3q5vXYVLOLPwjZuMd0HcZBLjBNeo4ovArmV/exec',

  // 既定のGeminiモデル（ユーザーが画面で選んでいない時に使う）
  // 空文字 '' = 自動（汎用の最新モデル）
  GEMINI_MODEL: '',

  // 画面の「読み取りに使うAIモデル」の選択肢（value がAPIのモデルID）
  // 指定モデルに該当がない（廃止・未公開・名前違い）場合は
  // GAS側で汎用の最新モデルへ自動で切り替わる
  GEMINI_MODEL_OPTIONS: [
    { value: '',                  label: '自動モード（汎用の最新）' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen（日々の暮らしをサポート）' },
    { value: 'gemini-4-neon',     label: '4 Neon（Deeper analysis）' },
    { value: 'gemini-4-carbon',   label: '4 Carbon（Code & complex work）' },
    { value: 'gemini-4-argon',    label: '4 Argon' },
    { value: 'gemini-3.8-flash',  label: '3.8 Flash' },
    { value: 'gemini-3.5-flash',  label: '3.5 Flash' }
  ]
};
