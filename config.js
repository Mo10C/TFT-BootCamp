/* =============================================================
   クラウドハッシュテイル校 TFT ログイン式リーダーボード - 設定ファイル

   ⚠️ このファイルは「あなた専用の設定」です。
      配布ZIPを展開して全ファイルを上書きすると、ここも上書きされます。
      更新時は、下の ★ が付いた項目が消えていないか必ず確認してください。
      （特に admins.discordIds — 消えると全員が管理者になります）
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

  /* ---- 2. ★ Cloudflare Worker（Riot API 中継 ＋ Discord OAuth）----
     worker.js をデプロイした Worker の URL。末尾のスラッシュは付けない。
     ※ パスは各機能が自動で付けるので、ここはドメインまで。
       （"/health" などを付けると unknown endpoint になります） */
  workerUrl: "https://tft-riot-proxy.moto-moto-tennis.workers.dev",

  /* ---- 3. Riot ルーティング ----
     region   = account / match API（asia / americas / europe）
     platform = ランク取得（league API）用のプラットフォーム（jp1 など） */
  region: "asia",
  platform: "jp1",

  /* ---- 4. Discord（表示用・任意）----
     認証処理自体は Worker 側で完結します（Client ID / Secret は Worker のシークレット）。
     ここは「未参加の人向けにサーバー招待リンクを出す」などの表示用途のみ。 */
  discord: {
    guildName: "クラウドハッシュテイル校",
    inviteUrl: ""              // 例: "https://discord.gg/xxxx"（空なら非表示）
  },

  /* ---- 5. ボードの初期値（任意・あとから画面でも変更可）---- */
  defaults: {
    matchCount: 3,   // 試合数
    tableCount: 2    // 卓数
  },

  /* ---- 6. ★★ 管理者（ここが権限ロックの心臓部）----
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
    // ★★ Discord の「ユーザー名」で指定（一番手軽）。@ は付けても付けなくてもOK。
    //     大文字小文字は区別しません。
    usernames: ["mo10c"],

    // ★★ Discord の「ユーザーID」で指定（最も確実・推奨）。
    //     ユーザー名は本人が変更できるため、厳密にやるならこちら。
    //     調べ方: 開発者モードON → 自分のアイコンを右クリック → ユーザーIDをコピー
    //     HOME画面の自分のカードにも表示されるので、そこからコピーできます。
    discordIds: [],              // 例: ["123456789012345678"]

    // riotIds は空のままを推奨。
    // Riot ID はログイン画面で誰でも自由に入力できる文字列で、Worker は所有者確認を
    // していないため、ここに入れると「その Riot ID を打った人」が誰でも管理者になれます。
    riotIds: []
  },

  /* ---- 7. HOME（home.html）に並べるツール ----
     name / url は必須。icon は絵文字、desc は説明文（省略可）。
     external: true で別タブ。
     roleIds を指定すると、そのロールを持つ人にだけ表示されます（管理者は常に表示）。 */
  home: {
    tools: [
      // { name: "クラウドハッシュテイル校 TOOLS", url: "https://mo10c.github.io/portal/", icon: "🏫",
      //   desc: "既存のポータル", external: true },
      // { name: "オーグメント図鑑", url: "../augument.html", icon: "📖", desc: "オーグメントの一覧と評価" },
      // { name: "合宿コンテンツ", url: "../camp/", icon: "⛺", desc: "クラウドハッシュテイル校",
      //   roleIds: ["合宿参加者ロールのID"] }
    ]
  },

  /* ---- 8. ロール設定（任意）----
     pinnedOrder : フィルタ・組卓UIでの表示順を固定
     adminRoleIds: このロールを持つ人も管理者として扱う（運営ロールを作った場合に便利） */
  roles: {
    pinnedOrder: [],           // 例: ["123456789012345678", "..."]
    adminRoleIds: []           // 例: ["運営ロールのID"]
  }
};
