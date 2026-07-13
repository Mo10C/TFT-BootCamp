/* =============================================================
   worker.js — Cloudflare Worker
   マウンテンチョンク校 ログイン式リーダーボード用バックエンド

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
     DISCORD_GUILD_ID      マウンテンチョンク校サーバーのID
     RETURN_ORIGINS        戻り先として許可するオリジン（カンマ区切り）
                           例: "https://mo10c.github.io,http://localhost:8000"

   Discord Developer Portal 側の設定:
     OAuth2 → Redirects に「このWorkerのURL + /auth/callback」を登録
     例: https://mcc-login-board.xxx.workers.dev/auth/callback
   ============================================================= */

const ALLOWED_REGIONS = ["asia", "americas", "europe"];
const ALLOWED_PLATFORMS = ["jp1", "kr", "na1", "euw1", "eun1", "oc1", "br1", "la1", "la2", "tr1", "ru", "ph2", "sg2", "th2", "tw2", "vn2"];
const DISCORD_API = "https://discord.com/api/v10";

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
      switch (path) {
        case "/health":        return json({ ok: true, now: Date.now() });
        case "/account":       return riotAccount(url, env);
        case "/rank":          return riotRank(url, env);
        case "/matches":       return riotMatches(url, env);
        case "/match":         return riotMatch(url, env);
        case "/auth/login":    return authLogin(url, env);
        case "/auth/callback": return authCallback(url, env);
        case "/roles":         return guildRoles(env);
        default:               return json({ error: "unknown endpoint: " + path }, 404);
      }
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  }
};

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
    state,
    prompt: "none"
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
