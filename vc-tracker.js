/* =============================================================
   vc-tracker.js — DiscordのVC滞在を記録して、Firestore へ日次集計を送る

   置き場所: 既存Bot（Railway）のリポジトリ直下。index.js に3行足すだけ。
     const { startVcTracker } = require("./vc-tracker");
     // client の intents に GatewayIntentBits.GuildVoiceStates を必ず追加すること
     startVcTracker(client);

   画面は クラウドハッシュテイル校 TOOLS の vc.html で見ます。
   このBotは Firestore の
     lboard_index/vc_YYYY-MM   … その月の日次集計
     lboard_index/vc           … 記録開始日などの控え
   に書き込むだけです（既存ルール match /lboard_index/{id} のまま書けます）。

   ★ 大事なこと
     ・Discordに「過去のVC履歴」を取るAPIはありません。
       記録できるのは、このBotが動き出したあとの分だけです。
     ・Botが落ちている間のVCは記録されません（再デプロイ中も同じ）。
     ・Railwayのディスクは再デプロイで消えます。必ず Volume を付けて
       VC_DATA_DIR にマウント先（例 /data）を指定してください。
       ここには「生ログ」が入り、集計をやり直すときの元になります。

   環境変数
     VC_DATA_DIR          生ログの保存先（既定: ./data）★Railwayでは /data
     FIREBASE_PROJECT_ID  例 tft-leaderboard-f6897（Worker と同じ値）
     FIREBASE_API_KEY     config.js の apiKey と同じ値
     VC_MIN_SEC           これより短い滞在は捨てる（既定: 10秒）
     VC_PUSH_MIN          Firestore へ送る間隔・分（既定: 5）
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.VC_DATA_DIR || path.join(__dirname, "data");
const FILE     = path.join(DATA_DIR, "vc-sessions.json");
const TMP      = FILE + ".tmp";
const MIN_SEC  = Number(process.env.VC_MIN_SEC || 10);
const PUSH_MS  = Math.max(1, Number(process.env.VC_PUSH_MIN || 5)) * 60 * 1000;
const SAVE_MS  = 60 * 1000;
const JST      = 9 * 60 * 60 * 1000;

let store = { version: 2, startedAt: 0, sessions: [] };
const openMap = new Map();          // `${userId}:${channelId}` → セッション
const dirtyDays = new Set();        // Firestore に送り直す必要がある日
let dirty = false;

/* =============================================================
   生ログの読み書き
   ============================================================= */
function dayKey(ms) { return new Date(ms + JST).toISOString().slice(0, 10); }
function monthKey(d) { return String(d).slice(0, 7); }
function dayStart(key) {            // その日の0:00(JST)のms
  return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) - JST;
}

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      store.sessions = Array.isArray(j.sessions) ? j.sessions : [];
      store.startedAt = j.startedAt || 0;
      /* 前回Botが落ちたときに入室中だったぶんは、最後に確認できた時刻で閉じる。
         「落ちてから今まで」を丸ごと足してしまわないようにするため。 */
      let rescued = 0;
      (Array.isArray(j.open) ? j.open : []).forEach(o => {
        const end = o.seen || o.s;
        if (end - o.s >= MIN_SEC * 1000) { push({ u: o.u, n: o.n, c: o.c, cn: o.cn, s: o.s, e: end, cut: true }); rescued++; }
      });
      if (rescued) console.log("[vc] 前回の入室中セッション " + rescued + " 件を、最後に確認できた時刻で閉じました");
    }
  } catch (e) {
    console.error("[vc] 生ログを読めませんでした（新規として続行）", e.message);
    store.sessions = [];
  }
  if (!store.startedAt) store.startedAt = Date.now();
}
function save() {
  try {
    const now = Date.now();
    const open = [...openMap.values()].map(o => Object.assign({}, o, { seen: now }));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TMP, JSON.stringify({ version: 2, startedAt: store.startedAt, sessions: store.sessions, open }));
    fs.renameSync(TMP, FILE);
    dirty = false;
  } catch (e) { console.error("[vc] 生ログの保存に失敗", e.message); }
}
function push(s) {
  store.sessions.push(s);
  daySlices(s).forEach(x => dirtyDays.add(x.day));   // 送り直す日を覚えておく
  dirty = true;
}

/* =============================================================
   入室・退室
   ============================================================= */
const keyOf = (u, c) => u + ":" + c;

function openSession(member, channel, at) {
  if (!member || !channel || member.user.bot) return;
  const k = keyOf(member.id, channel.id);
  if (openMap.has(k)) return;
  openMap.set(k, {
    u: member.id,
    n: member.displayName || member.user.username,
    c: channel.id,
    cn: channel.name || "(不明なVC)",
    s: at || Date.now()
  });
  dirty = true;
}
function closeSession(userId, channelId, at) {
  const k = keyOf(userId, channelId);
  const o = openMap.get(k);
  if (!o) return;
  openMap.delete(k);
  const e = at || Date.now();
  if (e - o.s >= MIN_SEC * 1000) push({ u: o.u, n: o.n, c: o.c, cn: o.cn, s: o.s, e: e });
}
function closeAll(at) { [...openMap.values()].forEach(o => closeSession(o.u, o.c, at)); }

/* =============================================================
   日次集計

   1本のセッションが日をまたぐことがあるので、0:00(JST)で切り分けてから数える。
   こうしておくと「9/1〜9/15」のような期間指定を、日ごとの足し算で正確に出せる。
   ============================================================= */
function daySlices(s) {
  const out = [];
  let a = s.s;
  while (a < s.e) {
    const d = dayKey(a);
    const end = Math.min(s.e, dayStart(d) + 86400000);
    out.push({ day: d, a: a, b: end });
    a = end;
  }
  return out;
}
function unionSec(ranges) {
  if (!ranges.length) return 0;
  const r = ranges.slice().sort((x, y) => x.a - y.a);
  let total = 0, curA = r[0].a, curB = r[0].b;
  for (let i = 1; i < r.length; i++) {
    if (r[i].a > curB) { total += curB - curA; curA = r[i].a; curB = r[i].b; }
    else if (r[i].b > curB) curB = r[i].b;
  }
  return Math.round((total + curB - curA) / 1000);
}
/* その日のぶんを組み立てる。いま入室中のぶんも「今まで」で含める。
   { ch: { <VCのID>: { n:VC名, up:稼働秒, sec:延べ秒, u:{ <ユーザーID>: 秒 } } } } */
function rollupDay(day) {
  const now = Date.now();
  const live = [...openMap.values()].map(o => ({ u: o.u, n: o.n, c: o.c, cn: o.cn, s: o.s, e: now }));
  const ch = {};
  const names = {};
  const ranges = {};
  store.sessions.concat(live).forEach(s => {
    daySlices(s).forEach(x => {
      if (x.day !== day) return;
      const sec = Math.round((x.b - x.a) / 1000);
      if (sec <= 0) return;
      if (!ch[s.c]) { ch[s.c] = { n: s.cn, up: 0, sec: 0, u: {} }; ranges[s.c] = []; }
      ch[s.c].n = s.cn;
      ch[s.c].sec += sec;
      ch[s.c].u[s.u] = (ch[s.c].u[s.u] || 0) + sec;
      ranges[s.c].push({ a: x.a, b: x.b });
      names[s.u] = s.n;
    });
  });
  Object.keys(ch).forEach(id => ch[id].up = unionSec(ranges[id]));
  return { ch, names };
}

/* =============================================================
   Firestore（REST + Web APIキー。worker.js と同じやり方）
   ============================================================= */
function fsReady() { return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_API_KEY); }
function fsBase() {
  return "https://firestore.googleapis.com/v1/projects/" +
    process.env.FIREBASE_PROJECT_ID + "/databases/(default)/documents";
}
function enc(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(enc) } };
  if (typeof x === "object") {
    const fields = {};
    Object.entries(x).forEach(([k, v]) => { fields[k] = enc(v); });
    return { mapValue: { fields } };
  }
  return { stringValue: String(x) };
}
async function fsPatch(docPath, obj, maskPaths) {
  const fields = {};
  Object.entries(obj).forEach(([k, v]) => { fields[k] = enc(v); });
  const mask = maskPaths.map(p => "updateMask.fieldPaths=" + encodeURIComponent(p)).join("&");
  const r = await fetch(fsBase() + "/" + docPath + "?key=" + process.env.FIREBASE_API_KEY + "&" + mask, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error("Firestore書き込み失敗 " + r.status + " " + (await r.text()).slice(0, 200));
}

/* 直したい日ぶんだけ送る。1日 = 1フィールドなので、他の日は上書きされない。 */
async function pushToFirestore(days) {
  if (!fsReady()) return;
  const list = [...new Set(days)].filter(Boolean).sort();
  if (!list.length) return;

  // 月ごとにまとめる
  const byMonth = {};
  list.forEach(d => (byMonth[monthKey(d)] = byMonth[monthKey(d)] || []).push(d));

  for (const [m, ds] of Object.entries(byMonth)) {
    const obj = { days: {}, names: {}, updatedAt: Date.now() };
    const mask = ["updatedAt", "names"];
    ds.forEach(d => {
      const r = rollupDay(d);
      obj.days[d] = r.ch;
      Object.assign(obj.names, r.names);
      mask.push("days." + d);
    });
    // 月の名前表は、その月に出てくる人を毎回まとめて入れ直す
    try {
      await fsPatch("lboard_index/vc_" + m, obj, mask);
      console.log("[vc] Firestoreへ送信: " + m + " の " + ds.join(", "));
    } catch (e) {
      console.error("[vc] 送信に失敗（次回また送ります）", e.message);
      ds.forEach(d => dirtyDays.add(d));
      return;
    }
  }
  try {
    await fsPatch("lboard_index/vc", { startedAt: store.startedAt, updatedAt: Date.now() },
      ["startedAt", "updatedAt"]);
  } catch (e) { /* 控えなので失敗しても続行 */ }
}

/* =============================================================
   起動
   ============================================================= */
function startVcTracker(client) {
  load();
  if (!fsReady()) console.warn("[vc] FIREBASE_PROJECT_ID / FIREBASE_API_KEY が未設定です。記録はしますが画面には出ません");

  const onReady = async () => {
    for (const guild of client.guilds.cache.values()) {
      try { await guild.channels.fetch(); } catch (e) { }
      for (const vs of guild.voiceStates.cache.values()) {
        if (!vs.channelId) continue;
        const ch = vs.channel || guild.channels.cache.get(vs.channelId);
        if (vs.member && ch) openSession(vs.member, ch);
      }
    }
    console.log("[vc] 計測開始。いまVCにいる人: " + openMap.size + "人");
    save();
    // 落ちていた間の取りこぼしを直すため、直近3日を送り直す
    const t = Date.now();
    await pushToFirestore([dayKey(t), dayKey(t - 86400000), dayKey(t - 2 * 86400000)]);
  };
  client.once("clientReady", onReady);   // discord.js v15
  client.once("ready", onReady);         // discord.js v14

  client.on("voiceStateUpdate", (oldS, newS) => {
    const at = Date.now();
    const member = newS.member || oldS.member;
    if (!member || member.user.bot) return;
    if (oldS.channelId === newS.channelId) return;     // ミュート切替などは無視
    if (oldS.channelId) closeSession(member.id, oldS.channelId, at);
    if (newS.channelId) {
      const ch = newS.channel || (newS.guild && newS.guild.channels.cache.get(newS.channelId));
      if (ch) openSession(member, ch, at);
    }
  });

  const t1 = setInterval(() => { if (dirty || openMap.size) save(); }, SAVE_MS);
  const t2 = setInterval(() => {
    // 入室中の人がいる日は、途中経過も送っておく（画面がリアルタイムに近くなる）
    const today = dayKey(Date.now());
    if (openMap.size) dirtyDays.add(today);
    const ds = [...dirtyDays]; dirtyDays.clear();
    pushToFirestore(ds).catch(e => console.error("[vc]", e.message));
  }, PUSH_MS);
  t1.unref && t1.unref(); t2.unref && t2.unref();

  // 再デプロイ・停止のときは、入室中のぶんを閉じて保存してから終わる
  let bying = false;
  const bye = async () => {
    if (bying) return; bying = true;
    closeAll(Date.now());
    save();
    try { await pushToFirestore([...dirtyDays, dayKey(Date.now())]); } catch (e) { }
    process.exit(0);
  };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);

  return { rollupDay, pushToFirestore };
}

module.exports = { startVcTracker, rollupDay, daySlices, _load: load, _push: push };
