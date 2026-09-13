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

  /* ---- 6. ★管理者（ここが権限ロックの心臓部）----
     ここに載っている人だけが
       ・試合数 / 卓数 / 大会名の変更
       ・組卓・席の配置・順位の入力・自動取得
       ・出欠の一括操作
       ・editor.html（管理コンソール）全体
     を操作できます。載っていない人は「閲覧 ＋ 自分の出欠チェック」のみ。

     ⚠️ discordIds / riotIds / roles.adminRoleIds が3つとも空だと
        「セットアップ中」とみなして全員が管理者になります。必ず埋めてください。

     riotIds は Name#TAG（大文字小文字は無視）。
     discordIds が最も確実（Discordの開発者モード → 自分を右クリック → ユーザーIDをコピー）。 */
  admins: {
    discordIds: [],              // 例: ["123456789012345678"] ← 推奨。判明したら追加
    riotIds: ["Mo10C#819"]       // Riot ID での指定（ログイン時に入力したIDと照合）
  },

  /* ---- 7. ロール設定（任意）----
     pinnedOrder : フィルタ・組卓UIでの表示順を固定
     adminRoleIds: このロールを持つ人も管理者として扱う（運営ロールを作った場合に便利） */
  roles: {
    pinnedOrder: [],           // 例: ["123456789012345678", "..."]
    adminRoleIds: []           // 例: ["運営ロールのID"]
  }
};
