/* =============================================================
   マウンテンチョンク校 TFT ログイン式リーダーボード - 設定ファイル
   ここだけ書き換えればOK。login.html / index.html / editor.html が参照します。
   ============================================================= */

window.MCC_LB_CONFIG = {

  /* ---- 1. Firebase（全員でリアルタイム共有するために必須）----
     既存リーダーボードと同じプロジェクトを使い回せます。
     データは別コレクション（lboards）に保存されるため既存の boards とは衝突しません。 */
  firebase: {
    apiKey: "AIzaSyCyZ7IbKh02V8fvILTCDTgLPKRuoNFS78Y",
    authDomain: "tft-leaderboard-f6897.firebaseapp.com",
    projectId: "tft-leaderboard-f6897",
    storageBucket: "tft-leaderboard-f6897.firebasestorage.app",
    messagingSenderId: "931359784793",
    appId: "1:931359784793:web:d7c2bf264d517974a9d648",
    measurementId: "G-T14B3XQY8R"
  },

  /* ---- 2. Cloudflare Worker（Riot API 中継 ＋ Discord OAuth）----
     この一式の worker.js を「新しい Worker」としてデプロイした URL を貼る。
     既存の tft-riot-proxy とは別 Worker にしてください（OAuth 機能が増えているため）。
     例: "https://mcc-login-board.moto-moto-tennis.workers.dev" */
  workerUrl: "",

  /* ---- 3. Riot ルーティング ----
     region   = account / match API（asia / americas / europe）
     platform = ランク取得（league API）用のプラットフォーム（jp1 など） */
  region: "asia",
  platform: "jp1",

  /* ---- 4. Discord（表示用・任意）----
     認証処理自体は Worker 側で完結します（Client ID / Secret は Worker のシークレット）。
     ここは「未参加の人向けにサーバー招待リンクを出す」などの表示用途のみ。 */
  discord: {
    guildName: "マウンテンチョンク校",
    inviteUrl: ""              // 例: "https://discord.gg/xxxx"（空なら非表示）
  },

  /* ---- 5. ボードの初期値（任意・あとから画面でも変更可）---- */
  defaults: {
    matchCount: 3,   // 試合数
    tableCount: 2    // 卓数
  },

  /* ---- 6. ロール設定（任意）----
     ここに Discord ロールIDを並べると、フィルタ・組卓 UI での表示順を固定できます。
     空のままでもOK（ログインした人のロールから自動で一覧を作ります）。
     adminRoleIds に入れたロールを持つ人だけ editor.html の操作を推奨（画面上の注意書き用）。 */
  roles: {
    pinnedOrder: [],           // 例: ["123456789012345678", "..."]
    adminRoleIds: []           // 例: ["管理者ロールのID"]
  }
};
