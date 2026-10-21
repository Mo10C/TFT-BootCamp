/* =============================================================
   chc-vc-bot — DiscordのVC滞在時間を記録するだけのBot

   やることは1つだけ。誰がどのVCに何分いたかを記録して、
   Firestore（lboard_index/vc_YYYY-MM）へ日ごとの集計を送ります。
   画面は クラウドハッシュテイル校 TOOLS の vc.html で見ます。

   このBotはメッセージを一切送りません（読むこともしません）。
   必要な権限は「チャンネルを見る」だけです。

   環境変数（Railway の Variables に入れる）
     DISCORD_BOT_TOKEN    TOOLSのWorkerで使っているものと同じでOK
     FIREBASE_PROJECT_ID  例 tft-leaderboard-f6897
     FIREBASE_API_KEY     config.js の apiKey と同じ
     VC_DATA_DIR          /data（Railwayで付けたVolumeのマウント先）
   ============================================================= */
"use strict";

// ローカルPCで試すとき用（.env を置いていれば読む。無ければ何もしない）
try { require("dotenv").config(); } catch (e) { }

const { Client, GatewayIntentBits } = require("discord.js");
const { startVcTracker } = require("./vc-tracker");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates   // ★これが無いとVCの出入りが届きません
  ]
});

client.on("error", e => console.error("[discord] エラー", e));
client.on("shardDisconnect", (ev, id) => console.warn("[discord] 接続が切れました shard " + id));

startVcTracker(client);

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN が設定されていません。Railway の Variables を確認してください。");
  process.exit(1);
}
client.login(process.env.DISCORD_BOT_TOKEN);
