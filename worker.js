/* =============================================================
   worker.js — Cloudflare Worker
   クラウドハッシュテイル校 ログイン式リーダーボード用バックエンド

   役割:
     1) Riot API 中継（APIキー秘匿・CORS回避）
        GET /account?gameName=Mo10C&tagLine=JP1&region=asia
        GET /rank?puuid=...&platform=jp1            ← TFTランク取得
        GET /matches?puuid=...&count=20&region=asia
        GET /match?matchId=...&region=asia
     2) Discord OAuth2（アイコン・名前・ロール取得）
        GET /auth/login?return=<戻り先URL>           ← Discordの認可画面へ302
        GET /auth/callback                           ← Discordから戻る。結果を
                                                        <return>#dc=<base64url(JSON)> で返す
        GET /roles                                   ← ギルドのロール一覧（名前・色）
     3) GET /health                                  ← 動作確認

   必要なシークレット（Settings → Variables and Secrets → Secret）:
     RIOT_API_KEY          RGAPI-...
     DISCORD_CLIENT_ID     DiscordアプリのClient ID
     DISCORD_CLIENT_SECRET DiscordアプリのClient Secret
     DISCORD_BOT_TOKEN     ロール名・色の解決用（Botをサーバーに入れておく）
   必要な変数（Text でOK）:
     DISCORD_GUILD_ID      クラウドハッシュテイル校サーバーのID
     RETURN_ORIGINS        戻り先として許可するオリジン（カンマ区切り）
                           例: "https://mo10c.github.io,http://localhost:8000"

   Discord Developer Portal 側の設定:
     OAuth2 → Redirects に「このWorkerのURL + /auth/callback」を登録
     例: https://mcc-login-board.xxx.workers.dev/auth/callback

   --- 変更履歴 -------------------------------------------------
   v2.1  /auth/login から prompt=none を削除。
         prompt=none は「すでにこのアプリを認可済みの人」しか通らないため、
         初回ログインの参加者が必ず consent_required で弾かれていた。
   v2.2  /member を追加（Botトークンで1人のロールを引く。管理コンソールの
         「全員のロールを再取得」用。本人の再ログインが不要になる）
   v3.0  毎日23:45(JST)のLP一斉集計を追加（Cron Trigger: "45 14 * * *" = UTC）。
         Firestore REST でメンバーを読み、Riotから最新ランクを取り、履歴に書き戻す。
         ティアが上がった人は Discord の指定チャンネルへお祝いを自動投稿。
         手動実行用に GET /collect?key=<CRON_KEY> も用意。
   v2.3  ★重要バグ修正: ルーティングの各 async 関数に await が無く、
         reject が try/catch の外へ抜けて Cloudflare の Error 1101 に
         なっていた。おかげで失敗理由（401/403/未設定など）が
         一切見えなかった。全経路に await を追加。
         あわせて /diag（設定の自己診断）を追加。
   ============================================================= */

const ALLOWED_REGIONS = ["asia", "americas", "europe"];
const ALLOWED_PLATFORMS = ["jp1", "kr", "na1", "euw1", "eun1", "oc1", "br1", "la1", "la2", "tr1", "ru", "ph2", "sg2", "th2", "tw2", "vn2"];
const DISCORD_API = "https://discord.com/api/v10";
const WORKER_VERSION = "3.2";

// ブラウザからのAPI呼び出しを許可するオリジン（"*" か "https://mo10c.github.io" 等）
const ALLOW_ORIGIN = "*";

// ロール一覧の簡易キャッシュ（Workerインスタンス内・5分）
let rolesCache = { at: 0, data: null };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    try {
      // ★ 必ず await すること。
      //   await を付けずに async 関数を return すると、reject が try/catch の外へ抜け、
      //   Cloudflare の「Error 1101 Worker threw exception」になって理由が見えなくなる。
      switch (path) {
        case "/health":        return json({ ok: true, now: Date.now(), version: WORKER_VERSION });
        case "/account":       return await riotAccount(url, env);
        case "/rank":          return await riotRank(url, env);
        case "/matches":       return await riotMatches(url, env);
        case "/match":         return await riotMatch(url, env);
        case "/auth/login":    return await authLogin(url, env);
        case "/auth/callback": return await authCallback(url, env);
        case "/roles":         return await guildRoles(env);
        case "/member":        return await guildMember(url, env);
        case "/diag":          return await diagnostics(env);
        case "/collect":       return await collectEndpoint(url, env);
        case "/notify":        return await notifyEndpoint(url, env);
        default:               return json({ error: "unknown endpoint: " + path }, 404);
      }
    } catch (e) {
      return json({
        error: String((e && e.message) || e),
        endpoint: path,
        stack: (e && e.stack) ? String(e.stack).split("\n").slice(0, 3).join(" | ") : undefined
      }, 502);
    }
  },

  /* Cron Trigger から呼ばれる。Cloudflare のダッシュボード（Settings → Triggers）
     または wrangler.jsonc の triggers.crons で "45 14 * * *" を設定すると
     毎日 23:45(JST) に走る。 */
  async scheduled(event, env, ctx) {
    // Cron Trigger は2本ある。どちらが鳴ったかで処理を分ける。
    //   45 14 * * *  → 23:45 JST  LPの一斉集計
    //    0  0 * * *  →  9:00 JST  きょうの予定をDiscordへ
    const cron = String((event && event.cron) || "").trim();
    if (cron === "0 0 * * *") {
      ctx.waitUntil(announceToday(env).then(
        r => console.log("予定の通知 完了", JSON.stringify(r)),
        e => console.error("予定の通知 失敗", e && e.message)
      ));
      return;
    }
    if (cron === "45 14 * * *" || !cron) {
      ctx.waitUntil(collectLp(env).then(
        r => console.log("LP集計 完了", JSON.stringify(r)),
        e => console.error("LP集計 失敗", e && e.message)
      ));
      return;
    }
    console.warn("知らないCronが鳴りました: " + cron);
  }
};

/* =============================================================
   LP の一斉集計（毎日23:45 JST）

   1) Firestore の lboard_index/lp から members を読む
   2) 各メンバーの puuid で Riot から最新ランクを取る
   3) hist に今日の絶対LPを書く / members を更新
   4) ティアが上がった人がいれば Discord の談話室へお祝いを投稿

   Firestore はセキュリティルールが公開状態なので REST + Web APIキーで読み書きできる。
   （ルールを締めたら、ここもサービスアカウント認証に差し替えが必要）
   ============================================================= */
const TIER_BASE_W = { IRON:0, BRONZE:400, SILVER:800, GOLD:1200, PLATINUM:1600,
  EMERALD:2000, DIAMOND:2400, MASTER:2800, GRANDMASTER:2800, CHALLENGER:2800 };
const DIV_ADD_W = { IV:0, III:100, II:200, I:300 };
const TIER_RANK_W = ["IRON","BRONZE","SILVER","GOLD","PLATINUM","EMERALD","DIAMOND","MASTER","GRANDMASTER","CHALLENGER"];

function absLpW(tier, division, lp) {
  const base = TIER_BASE_W[tier];
  if (base == null) return null;
  if (base >= 2800) return 2800 + (lp | 0);
  return base + (DIV_ADD_W[division] || 0) + (lp | 0);
}
function jstDayKey(now) {
  const d = new Date((now || Date.now()) + 9 * 3600 * 1000);   // JSTに寄せる
  const p = n => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

/* ---- Firestore REST（公開ルール前提・Web APIキーを使用）---- */
function fsBase(env) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) {
    throw new Error("FIREBASE_PROJECT_ID / FIREBASE_API_KEY 未設定");
  }
  return "https://firestore.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID +
         "/databases/(default)/documents";
}
// Firestore の値表現 → 素のJS
function fsDecode(v) {
  if (v == null) return null;
  if ("mapValue" in v) {
    const o = {};
    Object.entries((v.mapValue.fields) || {}).forEach(([k, x]) => { o[k] = fsDecode(x); });
    return o;
  }
  if ("arrayValue" in v) return ((v.arrayValue.values) || []).map(fsDecode);
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return !!v.booleanValue;
  if ("nullValue" in v) return null;
  return v.stringValue != null ? v.stringValue : null;
}
function fsEncode(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(fsEncode) } };
  if (typeof x === "object") {
    const fields = {};
    Object.entries(x).forEach(([k, v]) => { fields[k] = fsEncode(v); });
    return { mapValue: { fields } };
  }
  return { stringValue: String(x) };
}
async function fsGet(env, path) {
  const r = await fetch(fsBase(env) + "/" + path + "?key=" + env.FIREBASE_API_KEY);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore読み取り失敗 " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const out = {};
  Object.entries(j.fields || {}).forEach(([k, v]) => { out[k] = fsDecode(v); });
  return out;
}
// updateMask を付けて部分更新（他のフィールドを消さない）
async function fsPatch(env, path, obj) {
  const fields = {};
  Object.entries(obj).forEach(([k, v]) => { fields[k] = fsEncode(v); });
  const mask = Object.keys(obj).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const r = await fetch(fsBase(env) + "/" + path + "?key=" + env.FIREBASE_API_KEY + "&" + mask, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error("Firestore書き込み失敗 " + r.status + " " + (await r.text()).slice(0, 200));
  return true;
}

async function collectLp(env) {
  if (!env.RIOT_API_KEY) throw new Error("RIOT_API_KEY 未設定");
  const doc = await fsGet(env, "lboard_index/lp");
  const members = (doc && doc.members) || {};
  const hist = (doc && doc.hist) || {};
  const ids = Object.keys(members);
  if (!ids.length) return { ok: true, note: "メンバーがまだいません", updated: 0 };

  const today = jstDayKey();
  const platform = env.RIOT_PLATFORM || "jp1";
  const nextMembers = {}, nextHist = {};
  const promotions = [];
  let ok = 0, ng = 0, skip = 0;

  for (const id of ids) {
    const m = members[id] || {};
    if (!m.puuid) { skip++; continue; }
    let entries = null;
    try {
      const r = await fetch("https://" + platform + ".api.riotgames.com/tft/league/v1/by-puuid/" + enc(m.puuid),
        { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
      if (!r.ok) { ng++; continue; }
      entries = await r.json();
    } catch (e) { ng++; continue; }

    const pick = q => (Array.isArray(entries) ? entries.find(e => e.queueType === q) : null);
    const e = pick("RANKED_TFT") || pick("RANKED_TFT_DOUBLE_UP") || (Array.isArray(entries) ? entries[0] : null);
    if (!e || !e.tier) { skip++; continue; }

    const tier = e.tier, division = e.rank || "", lp = e.leaguePoints | 0;
    const abs = absLpW(tier, division, lp);
    if (abs == null) { skip++; continue; }

    // 昇格判定: ティアが上がったか（保存済みの tier と比較）
    const before = TIER_RANK_W.indexOf(String(m.tier || ""));
    const after = TIER_RANK_W.indexOf(tier);
    if (before >= 0 && after > before) {
      promotions.push({ name: m.name || "選手", from: m.tier, to: tier, division, lp });
    }

    nextMembers[id] = Object.assign({}, m, { tier, division, lp, abs, updatedAt: Date.now() });
    nextHist[id] = Object.assign({}, hist[id] || {}, { [today]: abs });
    ok++;
    await new Promise(r => setTimeout(r, 120));   // Riotのレート制限に配慮
  }

  // 更新されなかった人はそのまま残す
  Object.keys(members).forEach(id => { if (!nextMembers[id]) nextMembers[id] = members[id]; });
  Object.keys(hist).forEach(id => { if (!nextHist[id]) nextHist[id] = hist[id]; });

  await fsPatch(env, "lboard_index/lp", {
    members: nextMembers, hist: nextHist, updatedAt: Date.now(), lastCollect: today
  });

  let announced = 0;
  if (promotions.length) announced = await announcePromotions(env, promotions);
  return { ok: true, date: today, updated: ok, failed: ng, skipped: skip, promotions: promotions.length, announced };
}

/* ---- ランクアップを Discord の談話室へ投稿 ---- */
async function announcePromotions(env, list) {
  const ch = env.DISCORD_ANNOUNCE_CHANNEL_ID;
  if (!ch || !env.DISCORD_BOT_TOKEN) return 0;
  const emoji = { BRONZE:"🥉", SILVER:"🥈", GOLD:"🥇", PLATINUM:"💎", EMERALD:"💚",
                  DIAMOND:"💠", MASTER:"👑", GRANDMASTER:"🔥", CHALLENGER:"🏆" };
  const lines = list.map(p =>
    (emoji[p.to] || "🎉") + " **" + p.name + "** さんが **" + p.to + "** に昇格しました！（" + p.from + " → " + p.to + "）");
  const content = "🎊 **ランクアップのお知らせ** 🎊\n" + lines.join("\n") + "\nおめでとうございます！";

  const r = await fetch(DISCORD_API + "/channels/" + enc(ch) + "/messages", {
    method: "POST",
    headers: { Authorization: "Bot " + String(env.DISCORD_BOT_TOKEN).trim(), "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900) })
  });
  if (!r.ok) { console.error("Discord投稿に失敗", r.status, (await r.text()).slice(0, 200)); return 0; }
  return list.length;
}

/* ---- 手動実行用。CRON_KEY を知っている人だけ ---- */
async function collectEndpoint(url, env) {
  if (!env.CRON_KEY) return json({ error: "CRON_KEY が未設定のため手動実行は無効です" }, 403);
  if (url.searchParams.get("key") !== env.CRON_KEY) return json({ error: "key が違います" }, 403);
  const r = await collectLp(env);
  return json(r);
}

/* =============================================================
   きょうの予定を Discord の「連絡事項」チャンネルへ（毎朝9:00 JST）

   Firestore の lboard_index/schedule を読み、
   きょうの日付（JST）の予定があれば1通だけ投稿する。
   予定が無い日は何もしない（毎朝おはようだけ流れると邪魔なので）。

   ★ 投稿先は DISCORD_SCHEDULE_CHANNEL_ID（連絡事項）。
      ランクアップのお祝いは DISCORD_ANNOUNCE_CHANNEL_ID（談話室）で別枠。
      SCHEDULE 側が未設定のときだけ、談話室にフォールバックする。
   ============================================================= */
async function announceToday(env) {
  const today = jstDayKey();
  const doc = await fsGet(env, "lboard_index/schedule");
  if (!doc) return { ok: true, date: today, note: "予定表がまだ保存されていません", posted: 0 };
  if (doc.notify === false) return { ok: true, date: today, note: "通知がオフです", posted: 0 };

  const all = Array.isArray(doc.events) ? doc.events : [];
  const todays = all.filter(e => e && String(e.date) === today && String(e.name || "").trim());
  if (!todays.length) return { ok: true, date: today, note: "きょうは予定なし", posted: 0 };

  // ★（大きな行事）を先に
  todays.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0));

  const title = String(doc.title || "").trim();
  const wd = ["日", "月", "火", "水", "木", "金", "土"][jstWeekday(today)];
  const head = "🗓 **きょう " + Number(today.slice(5, 7)) + "/" + Number(today.slice(8)) +
    "（" + wd + "）の予定**" + (title ? "　― " + title : "");
  const lines = todays.map(e =>
    (e.star ? "⭐ **" : "・**") + String(e.name).trim() + "**" +
    (String(e.note || "").trim() ? "　" + String(e.note).trim() : ""));
  const content = head + "\n" + lines.join("\n") + "\n\nみなさん参加おまちしています！";

  const ch = env.DISCORD_SCHEDULE_CHANNEL_ID || env.DISCORD_ANNOUNCE_CHANNEL_ID;
  const ok = await postTo(env, ch, content);
  return { ok: true, date: today, posted: ok ? todays.length : 0,
           channel: env.DISCORD_SCHEDULE_CHANNEL_ID ? "連絡事項" : "談話室（連絡事項が未設定のため）",
           events: todays.map(e => e.name), discord: ok ? "投稿しました" : "投稿できませんでした" };
}

function jstWeekday(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/* ---- 指定チャンネルへ1通投げる（お祝いと予定で共用）---- */
async function postTo(env, ch, content) {
  if (!ch || !env.DISCORD_BOT_TOKEN) {
    console.warn("チャンネルID / DISCORD_BOT_TOKEN が未設定のため投稿しません");
    return false;
  }
  const r = await fetch(DISCORD_API + "/channels/" + enc(ch) + "/messages", {
    method: "POST",
    headers: { Authorization: "Bot " + String(env.DISCORD_BOT_TOKEN).trim(), "Content-Type": "application/json" },
    body: JSON.stringify({ content: String(content).slice(0, 1900) })
  });
  if (!r.ok) { console.error("Discord投稿に失敗", r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}

/* ---- 手動実行用。CRON_KEY を知っている人だけ ---- */
async function notifyEndpoint(url, env) {
  if (!env.CRON_KEY) return json({ error: "CRON_KEY が未設定のため手動実行は無効です" }, 403);
  if (url.searchParams.get("key") !== env.CRON_KEY) return json({ error: "key が違います" }, 403);
  const r = await announceToday(env);
  return json(r);
}

/* =============================================================
   /diag — 設定の自己診断
   シークレットの中身は絶対に返さない。「入っているか」と
   「Discord に通るか」だけを返す。
   ============================================================= */
async function diagnostics(env) {
  const present = k => !!(env[k] && String(env[k]).trim());
  const out = {
    version: WORKER_VERSION,
    vars: {
      RIOT_API_KEY: present("RIOT_API_KEY"),
      DISCORD_CLIENT_ID: present("DISCORD_CLIENT_ID"),
      DISCORD_CLIENT_SECRET: present("DISCORD_CLIENT_SECRET"),
      DISCORD_BOT_TOKEN: present("DISCORD_BOT_TOKEN"),
      DISCORD_GUILD_ID: present("DISCORD_GUILD_ID"),
      RETURN_ORIGINS: present("RETURN_ORIGINS") ? env.RETURN_ORIGINS : false,
      FIREBASE_PROJECT_ID: present("FIREBASE_PROJECT_ID") ? env.FIREBASE_PROJECT_ID : false,
      FIREBASE_API_KEY: present("FIREBASE_API_KEY"),
      DISCORD_ANNOUNCE_CHANNEL_ID: present("DISCORD_ANNOUNCE_CHANNEL_ID") ? env.DISCORD_ANNOUNCE_CHANNEL_ID : false,
      CRON_KEY: present("CRON_KEY")
    },
    checks: {}
  };

  // Bot トークンの形だけ確認（値は出さない）
  if (present("DISCORD_BOT_TOKEN")) {
    const t = String(env.DISCORD_BOT_TOKEN).trim();
    out.checks.botTokenShape =
      /^Bot\s/i.test(t) ? "NG: 先頭の 'Bot ' は不要です。トークンだけを登録してください"
      : /^\d{17,20}$/.test(t) ? "NG: これは ID です。Bot トークンではありません"
      : (t.split(".").length === 3 ? "OK（形式は正常）" : "注意: 通常とは違う形式です");
  }

  // 実際に Discord を叩いてみる
  if (present("DISCORD_BOT_TOKEN") && present("DISCORD_GUILD_ID")) {
    try {
      const r = await fetch(DISCORD_API + "/guilds/" + enc(env.DISCORD_GUILD_ID) + "/roles", {
        headers: { Authorization: "Bot " + String(env.DISCORD_BOT_TOKEN).trim() }
      });
      out.checks.rolesStatus = r.status;
      out.checks.rolesMeaning =
        r.status === 200 ? "OK: ロールを取得できます"
        : r.status === 401 ? "Bot トークンが無効です（Reset Token して登録し直す）"
        : r.status === 403 ? "Bot がこのサーバーに入っていません（招待URLで招待する）"
        : r.status === 404 ? "DISCORD_GUILD_ID が違います（サーバーIDを取り直す）"
        : "想定外のステータス";
      if (r.status === 200) {
        const rr = await r.json();
        out.checks.roleCount = Array.isArray(rr) ? rr.length : 0;
      }
    } catch (e) {
      out.checks.rolesError = String((e && e.message) || e);
    }
  } else {
    out.checks.rolesMeaning = "DISCORD_BOT_TOKEN / DISCORD_GUILD_ID のどちらかが未設定です";
  }

  // LP一斉集計に必要なものが揃っているか
  const need = ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY", "RIOT_API_KEY"].filter(k => !present(k));
  out.checks.lpCollect = need.length
    ? "未設定のため毎日の集計は動きません: " + need.join(", ")
    : "OK: 毎日の集計に必要な設定は揃っています（Cron Trigger \"45 14 * * *\" の登録も必要）";
  out.checks.announce = present("DISCORD_ANNOUNCE_CHANNEL_ID")
    ? "OK: ランクアップを投稿します"
    : "DISCORD_ANNOUNCE_CHANNEL_ID 未設定のため、お祝い投稿は行いません";

  // 予定表の当日通知（毎朝9:00 JST → 連絡事項チャンネル）
  const schCh = present("DISCORD_SCHEDULE_CHANNEL_ID") || present("DISCORD_ANNOUNCE_CHANNEL_ID");
  const needSch = ["FIREBASE_PROJECT_ID", "FIREBASE_API_KEY", "DISCORD_BOT_TOKEN"]
    .filter(k => !present(k)).concat(schCh ? [] : ["DISCORD_SCHEDULE_CHANNEL_ID"]);
  out.checks.scheduleNotify = needSch.length
    ? "未設定のため当日通知は動きません: " + needSch.join(", ")
    : "OK: 当日9:00の予定通知に必要な設定は揃っています（Cron Trigger \"0 0 * * *\" の登録も必要）";
  out.checks.scheduleChannel = present("DISCORD_SCHEDULE_CHANNEL_ID")
    ? "予定は DISCORD_SCHEDULE_CHANNEL_ID（連絡事項）へ投稿します"
    : (present("DISCORD_ANNOUNCE_CHANNEL_ID")
        ? "⚠️ DISCORD_SCHEDULE_CHANNEL_ID が未設定のため、予定も談話室へ投稿されます"
        : "投稿先が未設定です");
  try {
    if (present("FIREBASE_PROJECT_ID") && present("FIREBASE_API_KEY")) {
      const doc = await fsGet(env, "lboard_index/schedule");
      const n = (doc && Array.isArray(doc.events)) ? doc.events.length : 0;
      out.checks.scheduleSaved = doc
        ? ("保存済み: " + n + "件" + (doc.notify === false ? "（通知オフ）" : ""))
        : "予定表がまだ保存されていません（管理コンソール →「🗓 予定表」で保存してください）";
    }
  } catch (e) {
    out.checks.scheduleSaved = "読み取り失敗: " + String((e && e.message) || e);
  }

  return json(out);
}

/* =============================================================
   Riot 中継
   ============================================================= */
function needRiotKey(env) {
  if (!env.RIOT_API_KEY) throw new Error("RIOT_API_KEY 未設定（Workerのシークレットを設定してください）");
}
async function riotFetch(riotUrl, env) {
  const r = await fetch(riotUrl, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
  const body = await r.text();
  return new Response(body, { status: r.status, headers: { ...cors(), "Content-Type": "application/json" } });
}

async function riotAccount(url, env) {
  needRiotKey(env);
  const region = pick(url.searchParams.get("region"), ALLOWED_REGIONS, "asia");
  const gameName = url.searchParams.get("gameName");
  const tagLine = url.searchParams.get("tagLine");
  if (!gameName || !tagLine) return json({ error: "gameName と tagLine が必要です" }, 400);
  return riotFetch(`https://${region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${enc(gameName)}/${enc(tagLine)}`, env);
}

async function riotRank(url, env) {
  needRiotKey(env);
  const platform = pick(url.searchParams.get("platform"), ALLOWED_PLATFORMS, "jp1");
  const puuid = url.searchParams.get("puuid");
  if (!puuid) return json({ error: "puuid が必要です" }, 400);
  // TFT-LEAGUE-V1: ランク情報（RANKED_TFT / RANKED_TFT_DOUBLE_UP / RANKED_TFT_TURBO）
  return riotFetch(`https://${platform}.api.riotgames.com/tft/league/v1/by-puuid/${enc(puuid)}`, env);
}

async function riotMatches(url, env) {
  needRiotKey(env);
  const region = pick(url.searchParams.get("region"), ALLOWED_REGIONS, "asia");
  const puuid = url.searchParams.get("puuid");
  const count = Math.min(parseInt(url.searchParams.get("count") || "20", 10), 50);
  if (!puuid) return json({ error: "puuid が必要です" }, 400);
  return riotFetch(`https://${region}.api.riotgames.com/tft/match/v1/matches/by-puuid/${enc(puuid)}/ids?count=${count}`, env);
}

async function riotMatch(url, env) {
  needRiotKey(env);
  const region = pick(url.searchParams.get("region"), ALLOWED_REGIONS, "asia");
  const matchId = url.searchParams.get("matchId");
  if (!matchId) return json({ error: "matchId が必要です" }, 400);
  return riotFetch(`https://${region}.api.riotgames.com/tft/match/v1/matches/${enc(matchId)}`, env);
}

/* =============================================================
   Discord OAuth2
   ============================================================= */
function needDiscord(env) {
  const miss = [];
  if (!env.DISCORD_CLIENT_ID) miss.push("DISCORD_CLIENT_ID");
  if (!env.DISCORD_CLIENT_SECRET) miss.push("DISCORD_CLIENT_SECRET");
  if (!env.DISCORD_GUILD_ID) miss.push("DISCORD_GUILD_ID");
  if (miss.length) throw new Error("未設定: " + miss.join(", "));
}
function redirectUri(url) {
  return url.origin + "/auth/callback";
}
function okReturn(env, ret) {
  if (!ret) return false;
  let u;
  try { u = new URL(ret); } catch (e) { return false; }
  const allow = (env.RETURN_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allow.length) return true; // 未設定なら制限なし（READMEで設定を推奨）
  return allow.includes(u.origin);
}

// /auth/login?return=... → Discord 認可画面へ
function authLogin(url, env) {
  needDiscord(env);
  const ret = url.searchParams.get("return") || "";
  if (!okReturn(env, ret)) return json({ error: "return が許可オリジンではありません: " + ret }, 400);

  const state = b64url(JSON.stringify({ r: ret, n: crypto.randomUUID() }));
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(url),
    scope: "identify guilds.members.read",
    state
    // ★ prompt は指定しない。
    //   "none" にすると未認可のユーザーが consent_required で必ず失敗する。
    //   未指定なら「初回は認可画面 / 2回目以降は自動で素通り」という理想の挙動になる。
  });
  return Response.redirect("https://discord.com/oauth2/authorize?" + q.toString(), 302);
}

// Discordから戻ってくる → トークン交換 → ユーザー/メンバー情報 → returnへ #dc= で返す
async function authCallback(url, env) {
  needDiscord(env);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  let ret = "";
  try { ret = JSON.parse(unb64url(stateRaw)).r || ""; } catch (e) { }
  if (!okReturn(env, ret)) return json({ error: "state / return が不正です" }, 400);

  const back = (payload) => Response.redirect(ret + "#dc=" + b64url(JSON.stringify(payload)), 302);

  if (!code) return back({ ok: false, error: url.searchParams.get("error_description") || "認可がキャンセルされました" });

  // 1) code → access_token
  const tokenRes = await fetch(DISCORD_API + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(url)
    })
  });
  if (!tokenRes.ok) return back({ ok: false, error: "トークン交換に失敗 (" + tokenRes.status + ")" });
  const token = await tokenRes.json();
  const auth = { Authorization: "Bearer " + token.access_token };

  // 2) ユーザー基本情報
  const meRes = await fetch(DISCORD_API + "/users/@me", { headers: auth });
  if (!meRes.ok) return back({ ok: false, error: "ユーザー情報の取得に失敗 (" + meRes.status + ")" });
  const me = await meRes.json();

  // 3) ギルドメンバー情報（ニックネーム・ロールID）
  let member = null;
  const memRes = await fetch(DISCORD_API + "/users/@me/guilds/" + env.DISCORD_GUILD_ID + "/member", { headers: auth });
  if (memRes.ok) member = await memRes.json();

  // 4) ロールID → 名前・色（Botトークンがあれば解決）
  let roles = [];
  if (member && Array.isArray(member.roles) && member.roles.length) {
    const catalog = await fetchGuildRoles(env).catch(() => null);
    if (catalog) {
      const map = new Map(catalog.map(r => [r.id, r]));
      roles = member.roles.map(id => map.get(id)).filter(Boolean)
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, color: r.color }));
    } else {
      roles = member.roles.map(id => ({ id, name: null, color: 0 }));
    }
  }

  const displayName = (member && member.nick) || me.global_name || me.username;
  const avatarHash = (member && member.avatar) || me.avatar;
  const avatarUrl = avatarHash
    ? (member && member.avatar
        ? `https://cdn.discordapp.com/guilds/${env.DISCORD_GUILD_ID}/users/${me.id}/avatars/${avatarHash}.png?size=128`
        : `https://cdn.discordapp.com/avatars/${me.id}/${avatarHash}.png?size=128`)
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(me.id) >> 22n) % 6}.png`;

  return back({
    ok: true,
    id: me.id,
    username: me.username,
    name: displayName,
    avatar: avatarUrl,
    inGuild: !!member,
    roles
  });
}

/* ---- ギルドのロール一覧（Botトークン使用・5分キャッシュ）---- */
async function fetchGuildRoles(env) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) throw new Error("DISCORD_BOT_TOKEN / DISCORD_GUILD_ID 未設定");
  const now = Date.now();
  if (rolesCache.data && now - rolesCache.at < 5 * 60 * 1000) return rolesCache.data;
  const r = await fetch(DISCORD_API + "/guilds/" + env.DISCORD_GUILD_ID + "/roles", {
    headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN }
  });
  if (!r.ok) throw new Error("roles " + r.status);
  const raw = await r.json();
  const data = raw
    .filter(x => x.name !== "@everyone")
    .map(x => ({ id: x.id, name: x.name, color: x.color, position: x.position }))
    .sort((a, b) => b.position - a.position);
  rolesCache = { at: now, data };
  return data;
}

async function guildRoles(env) {
  const data = await fetchGuildRoles(env);
  return json({ roles: data });
}

/* ---- 1人のギルドメンバーを Botトークンで引く ----
   GET /member?userId=123456789012345678
   管理コンソールの「全員のロールを再取得」で使用。
   本人のOAuthトークンが不要なので、再ログインを待たずにロールを最新化できる。
   ※ REST の members 取得に特権インテントは不要（Botがサーバーに入っていればよい） */
async function guildMember(url, env) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) throw new Error("DISCORD_BOT_TOKEN / DISCORD_GUILD_ID 未設定");
  const userId = url.searchParams.get("userId");
  if (!userId) return json({ error: "userId が必要です" }, 400);

  const r = await fetch(DISCORD_API + "/guilds/" + env.DISCORD_GUILD_ID + "/members/" + enc(userId), {
    headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN }
  });
  if (r.status === 404) return json({ inGuild: false, nick: null, roles: [] });
  if (!r.ok) return json({ error: "member " + r.status }, r.status);

  const m = await r.json();
  let roles = [];
  if (Array.isArray(m.roles) && m.roles.length) {
    const catalog = await fetchGuildRoles(env).catch(() => null);
    if (catalog) {
      const map = new Map(catalog.map(x => [x.id, x]));
      roles = m.roles.map(id => map.get(id)).filter(Boolean)
        .sort((a, b) => b.position - a.position)
        .map(x => ({ id: x.id, name: x.name, color: x.color }));
    } else {
      roles = m.roles.map(id => ({ id, name: null, color: 0 }));
    }
  }
  return json({ inGuild: true, nick: (m.nick || null), roles });
}

/* =============================================================
   小物
   ============================================================= */
function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors(), "Content-Type": "application/json" }
  });
}
function enc(s) { return encodeURIComponent(s); }
function pick(v, allowed, fallback) { return allowed.includes(v) ? v : fallback; }
function b64url(s) {
  const b = btoa(unescape(encodeURIComponent(s)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}
