/* =============================================================
   core.js — ログイン式リーダーボード 共通コアロジック
   セッション / 権限 / データ模型 / 得点計算 / Firestore同期 / Riot API / ロール

   login.html / index.html / editor.html が読み込みます。

   ★ 選手（roster の1件）はログインしたユーザーそのもの:
     { id: "u_<discordId>",
       name, nameLocked, riotId, puuid,
       rank: { tier, division, lp, queue },
       discord: { id, name, username, avatar },
       roles: [{id, name, color}],   // ログイン時点のギルドロール
       joinedAt, updatedAt }

   ★ ボード状態（v2互換の縮小版・個人戦）:
     { mode:"solo", title, matchCount, tableCount,
       roster:[player], matches:[{ tables:[{seats[8], placements{}}], present }],
       updatedAt }
     present: pid配列（null=全員参加）

   ★ 権限（v2.1 で追加）:
     store.setActor({ pid, isAdmin }) を呼んでから使う。
     - 管理者          : すべての操作
     - 一般プレイヤー  : 閲覧 ＋ 自己登録（upsertSelf）＋ 自分の出欠のみ
     ガードに弾かれると window に "lb-denied" イベントが飛びます。
   ============================================================= */
(function () {
  "use strict";

  const CFG = window.MCC_LB_CONFIG || {};
  const SEATS_PER_TABLE = 8;
  /* ★ ダブルアップ（2人1組）。1卓は 2人×4チーム。
     卓の「席」には、ソロなら選手ID、ダブルアップならチームIDが入ります。
     この「席に入るもの」をコードの中では unit（ユニット）と呼んでいます。 */
  const TEAMS_PER_TABLE = 4;
  const TEAM_SIZE = 2;
  function isDouble(x) {
    const m = (x && typeof x === "object") ? x.mode : x;
    return m === "doubleup";
  }
  // その卓にいくつスロットがあるか（ソロ8／ダブルアップ4）
  function slotCount(x) { return isDouble(x) ? TEAMS_PER_TABLE : SEATS_PER_TABLE; }

  /* =============================================================
     接続設定（config.js を localStorage で上書きできる）
     ============================================================= */
  const RIOT_CFG_KEY = "mcc-lb2-riot-config";
  function readOverride() {
    try { const raw = localStorage.getItem(RIOT_CFG_KEY); return raw ? (JSON.parse(raw) || {}) : {}; }
    catch (e) { return {}; }
  }
  function effCfg() {
    const o = readOverride();
    const v = (k, d) => (o[k] != null && o[k] !== "") ? String(o[k]).trim() : (CFG[k] || d);
    return { workerUrl: v("workerUrl", ""), region: v("region", "asia"), platform: v("platform", "jp1") };
  }
  const RiotConfig = {
    effective() { return effCfg(); },
    base() { return { workerUrl: CFG.workerUrl || "", region: CFG.region || "asia", platform: CFG.platform || "jp1" }; },
    override() { return readOverride(); },
    isOverridden() {
      const o = readOverride(), b = this.base();
      return !!((o.workerUrl && o.workerUrl !== b.workerUrl) || (o.region && o.region !== b.region) || (o.platform && o.platform !== b.platform));
    },
    set(patch) {
      const o = readOverride();
      ["workerUrl", "region", "platform"].forEach(k => { if (patch && (k in patch)) o[k] = (patch[k] || "").trim(); });
      try { localStorage.setItem(RIOT_CFG_KEY, JSON.stringify(o)); } catch (e) { }
      return effCfg();
    },
    clear() { try { localStorage.removeItem(RIOT_CFG_KEY); } catch (e) { } return effCfg(); }
  };

  // ロール配列だけで運営かどうかを判定（Session.toPlayer から使う）
  function isStaffRoles(roles) {
    const ids = (((CFG.roles || {}).staffRoleIds) || []).map(x => String(x).trim()).filter(Boolean);
    if (!ids.length) return false;
    return (roles || []).some(r => r && ids.includes(String(r.id)));
  }

  /* =============================================================
     セッション（ログイン状態）
     ============================================================= */
  const SESSION_KEY = "mcc-lb2-session";
  const Session = {
    get() {
      try { const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }
      catch (e) { return null; }
    },
    set(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { } },
    clear() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { } },
    isComplete(s) {
      s = s || this.get();
      return !!(s && s.riot && s.riot.puuid && s.discord && s.discord.id);
    },
    // 未ログインなら login.html へ（?board= を引き継ぐ）
    require() {
      if (this.isComplete()) return this.get();
      const p = new URLSearchParams(location.search);
      const q = p.get("board") ? ("?board=" + encodeURIComponent(p.get("board"))) : "";
      location.replace("login.html" + q);
      return null;
    },
    // セッション → roster用プレイヤーへ変換
    toPlayer(s) {
      s = s || this.get();
      if (!this.isComplete(s)) return null;
      return {
        id: "u_" + s.discord.id,
        name: s.discord.name || s.riot.gameName,
        riotId: s.riot.gameName + "#" + s.riot.tagLine,
        puuid: s.riot.puuid,
        rank: s.riot.rank || null,
        discord: { id: s.discord.id, name: s.discord.name, username: s.discord.username, avatar: s.discord.avatar },
        roles: Array.isArray(s.discord.roles) ? s.discord.roles : [],
        staff: isStaffRoles(s.discord.roles),
        updatedAt: Date.now()
      };
    },
    riotIdOf(s) {
      s = s || this.get();
      if (!s || !s.riot) return "";
      return ((s.riot.gameName || "") + "#" + (s.riot.tagLine || ""));
    }
  };

  /* =============================================================
     権限判定
     config.js:
       admins: { discordIds: [...], riotIds: ["Mo10C#819"] }
       roles:  { adminRoleIds: [...] }
     3つとも空 = 初期セットアップ中とみなして全員管理者（警告つき）
     ============================================================= */
  function adminConfig() {
    const a = CFG.admins || {};
    return {
      discordIds: (a.discordIds || []).map(x => String(x).trim()).filter(Boolean),
      // Discordのユーザー名（@のあとの一意な名前）。大文字小文字は無視。
      usernames: (a.usernames || []).map(x => String(x).trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
      riotIds: (a.riotIds || []).map(x => String(x).trim().toLowerCase()).filter(Boolean),
      roleIds: (((CFG.roles || {}).adminRoleIds) || []).map(x => String(x).trim()).filter(Boolean)
    };
  }
  // 管理者が1人も設定されていない = 誰でも操作できてしまう状態
  function isAdminConfigured() {
    const c = adminConfig();
    return !!(c.discordIds.length || c.usernames.length || c.riotIds.length || c.roleIds.length);
  }
  function isAdmin(session) {
    const s = session || Session.get();
    if (!s) return false;
    const c = adminConfig();
    if (!isAdminConfigured()) return true; // 未設定 = セットアップ中

    const did = s.discord && s.discord.id ? String(s.discord.id) : "";
    if (did && c.discordIds.includes(did)) return true;

    const uname = (s.discord && s.discord.username ? String(s.discord.username) : "").toLowerCase();
    if (uname && c.usernames.includes(uname)) return true;

    const riot = Session.riotIdOf(s).toLowerCase();
    if (riot && riot !== "#" && c.riotIds.includes(riot)) return true;

    if (c.roleIds.length) {
      const roles = (s.discord && s.discord.roles) || [];
      if (roles.some(r => r && c.roleIds.includes(String(r.id)))) return true;
    }
    return false;
  }

  /* =============================================================
     運営（スタッフ）ロール
     config.js: roles.staffRoleIds = ["運営ロールのID"]

     このロールを持つ人は「観戦者」として扱う:
       ・すべての画面を閲覧できる（ロックしない）
       ・大会の参加者一覧・組卓・全体順位には入らない
       ・メンバー一覧・LPランキングにも出ない
     ただし記録自体は残すので、管理者が「大会に参加させる」を押せば
     普通の参加者に切り替えられる（player.optIn = true）。
     ============================================================= */
  function staffRoleIds() {
    return (((CFG.roles || {}).staffRoleIds) || []).map(x => String(x).trim()).filter(Boolean);
  }
  function isStaff(session) {
    const ids = staffRoleIds();
    if (!ids.length) return false;
    const s = session || Session.get();
    const roles = (s && s.discord && s.discord.roles) || [];
    return roles.some(r => r && ids.includes(String(r.id)));
  }
  // 選手レコードが「大会に出る人」か。運営ロール持ちは optIn されるまで出ない。
  function isParticipant(p) {
    if (!p) return false;
    if (!p.staff) return true;
    return !!p.optIn;
  }
  function participants(state) {
    return (state.roster || []).filter(isParticipant);
  }

  /* =============================================================
     得点・状態
     ============================================================= */
  function pointsFor(mode, rank) {
    if (!rank) return 0;
    if (mode === "doubleup") return ({ 1: 8, 2: 6, 3: 4, 4: 2 })[rank] || 0;
    return Math.max(0, SEATS_PER_TABLE + 1 - rank); // 9 - rank
  }

  function emptyTable(mode) { return { seats: new Array(slotCount(mode)).fill(null), placements: {} }; }
  function buildMatches(matchCount, tableCount, mode) {
    const out = [];
    for (let m = 0; m < matchCount; m++) {
      const tables = [];
      for (let t = 0; t < tableCount; t++) tables.push(emptyTable(mode));
      out.push({ tables, present: null });
    }
    return out;
  }
  function blankState() {
    const d = CFG.defaults || {};
    const mc = d.matchCount || 3, tc = d.tableCount || 2;
    return {
      mode: "solo", title: "", matchCount: mc, tableCount: tc,
      visibility: { mode: "all", roleIds: [] },
      roster: [],
      teams: [],                                  // ★ ダブルアップのペア
      matches: buildMatches(mc, tc, "solo"), updatedAt: Date.now()
    };
  }

  /* =============================================================
     ★ チーム（ダブルアップのペア）

       state.teams = [ { id, name, members:[選手ID, 選手ID], createdAt, updatedAt } ]

     ・ポイントは人ではなく「チーム」に付きます。
       途中でペアを入れ替えても、そのチームの持ちptはチームに残ります。
     ・name が空なら2人の名前から自動で作ります（「もと先生 ＆ すいちゃん」）。
     ============================================================= */
  function newTeamId() {
    return "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function teamsOf(state) { return (state && Array.isArray(state.teams)) ? state.teams : []; }
  function teamById(state, id) { return teamsOf(state).find(t => t && t.id === id) || null; }
  function teamOfPlayer(state, pid) {
    if (!pid) return null;
    return teamsOf(state).find(t => t && (t.members || []).indexOf(pid) >= 0) || null;
  }
  function teamMembers(state, team) {
    const t = (typeof team === "string") ? teamById(state, team) : team;
    return ((t && t.members) || []).map(pid => playerById(state, pid)).filter(Boolean);
  }
  function teamLabel(state, team) {
    const t = (typeof team === "string") ? teamById(state, team) : team;
    if (!t) return "—";
    if (t.name) return t.name;
    const ms = teamMembers(state, t);
    if (!ms.length) return "（空きチーム）";
    return ms.map(p => p.name).join(" ＆ ");
  }
  // チームに入っていない参加者
  function unpairedPlayers(state) {
    const used = {};
    teamsOf(state).forEach(t => (t.members || []).forEach(pid => { used[pid] = 1; }));
    return participants(state).filter(p => !used[p.id]);
  }

  /* ---- unit（席に入るもの）----
     ソロなら選手、ダブルアップならチーム。画面はこれだけ見ればよい。 */
  function unitsOf(state) {
    return isDouble(state) ? teamsOf(state).map(t => t.id) : participants(state).map(p => p.id);
  }
  function unitName(state, id) {
    return isDouble(state) ? teamLabel(state, id) : nameOf(state, id);
  }
  // そのユニットに属する選手たち（ソロなら本人1人）
  function unitPlayers(state, id) {
    if (!isDouble(state)) { const p = playerById(state, id); return p ? [p] : []; }
    return teamMembers(state, id);
  }
  // 選手ID → その人が座るユニットID
  function unitOfPlayer(state, pid) {
    if (!isDouble(state)) return pid;
    const t = teamOfPlayer(state, pid);
    return t ? t.id : null;
  }

  /* =============================================================
     ボードの公開範囲
       { mode: "all" }                        … ログイン済みの全員
       { mode: "roles", roleIds: [...] }      … いずれかのロール保持者のみ
     管理者は常に閲覧可。roleIds が空の "roles" は "all" と同じ扱い。
     ※ 画面側の制御です。Firestoreルールは別途（DESIGN-auth.md）。
     ============================================================= */
  function normVisibility(v) {
    if (!v || typeof v !== "object") return { mode: "all", roleIds: [] };
    const ids = Array.isArray(v.roleIds) ? v.roleIds.map(String).filter(Boolean) : [];
    return { mode: v.mode === "roles" ? "roles" : "all", roleIds: ids };
  }
  function canViewBoard(visibility, session) {
    const v = normVisibility(visibility);
    if (v.mode !== "roles" || !v.roleIds.length) return true;
    if (isAdmin(session)) return true;
    const s = session || Session.get();
    const roles = (s && s.discord && s.discord.roles) || [];
    return roles.some(r => r && v.roleIds.includes(String(r.id)));
  }
  function visibilityLabel(visibility, roleCatalog) {
    const v = normVisibility(visibility);
    if (v.mode !== "roles" || !v.roleIds.length) return { open: true, names: [] };
    const map = new Map((roleCatalog || []).map(r => [String(r.id), r]));
    return { open: false, names: v.roleIds.map(id => (map.get(id) || {}).name || id) };
  }

  /* =============================================================
     Store : 状態管理 + 同期（Firestore / localStorage フォールバック）
     コレクションは lboards（既存の boards と衝突しない）
     ============================================================= */
  function makeStore() {
    let state = blankState();
    let listeners = [];
    let boardId = "default";
    let mode = "local";
    let db = null, docRef = null, indexRef = null;
    let applyingRemote = false, saveTimer = null;
    let actor = { pid: null, isAdmin: false };
    let selfSession = null;   // 自動参加させる本人のセッション（ensureSelf が使う）
    const INDEX_LS_KEY = "mcc-lb2-board-index";
    const idxKey = id => encodeURIComponent(id);
    const lsKey = () => "mcclb2:" + boardId;

    function getBoardId() {
      const p = new URLSearchParams(location.search);
      return p.get("board") || "default";
    }
    function emit() { listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }
    function onChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; }

    /* ---- 権限 ---- */
    function setActor(a) {
      actor = { pid: (a && a.pid) || null, isAdmin: !!(a && a.isAdmin) };
      return actor;
    }
    function getActor() { return { pid: actor.pid, isAdmin: actor.isAdmin }; }
    function canEdit() { return !!actor.isAdmin; }
    function deny(op) {
      console.warn("[LB] 権限がないため中止しました: " + op);
      try { window.dispatchEvent(new CustomEvent("lb-denied", { detail: { op } })); } catch (e) { }
      return false;
    }
    function guard(op) { return actor.isAdmin ? true : deny(op); }

    async function init() {
      boardId = getBoardId();
      const fb = CFG.firebase || {};
      const hasFb = fb.apiKey && fb.projectId && typeof window.firebase !== "undefined" && firebase.firestore;
      if (hasFb) {
        try {
          if (!firebase.apps.length) firebase.initializeApp(fb);
          db = firebase.firestore();
          docRef = db.collection("lboards").doc(boardId);
          indexRef = db.collection("lboard_index").doc("registry");
          mode = "firestore";
          const snap = await docRef.get();
          if (!snap.exists) await docRef.set(blankState());
          // ★ 取得した内容を先に state へ入れておく。
          //   これをせずに init() を返すと、呼び出し側が upsertSelf() した直後に
          //   最初の onSnapshot が飛んできて state ごと上書きし、
          //   登録したばかりの自分が消える（参加者が0人のままになる原因だった）。
          else state = normalize(snap.data());
          docRef.onSnapshot(s => {
            if (!s.exists) return;
            applyingRemote = true;
            state = normalize(s.data());
            applyingRemote = false;
            ensureSelf();   // リモート側に自分が居なければ入れ直す
            emit();
          }, err => console.error("onSnapshot", err));
          upsertIndex();
          return { mode, boardId };
        } catch (e) { console.error("Firebase init failed, falling back to local:", e); }
      }
      mode = "local";
      const raw = localStorage.getItem(lsKey());
      state = raw ? normalize(JSON.parse(raw)) : blankState();
      window.addEventListener("storage", e => {
        if (e.key === lsKey() && e.newValue) {
          applyingRemote = true;
          state = normalize(JSON.parse(e.newValue));
          applyingRemote = false;
          ensureSelf();
          emit();
        }
      });
      emit();
      upsertIndex();
      return { mode, boardId };
    }

    /* ---- 受信データの形を整える ---- */
    function normalize(data) {
      const s = Object.assign(blankState(), data || {});
      s.mode = (s.mode === "doubleup") ? "doubleup" : "solo";   // ★ 個人戦 / ダブルアップ
      s.title = typeof s.title === "string" ? s.title : "";
      s.matchCount = Math.max(1, s.matchCount | 0 || 1);
      s.tableCount = Math.max(1, s.tableCount | 0 || 1);
      s.visibility = normVisibility(s.visibility);
      if (!Array.isArray(s.roster)) s.roster = [];
      s.roster = s.roster.filter(p => p && p.id).map(p => ({
        id: p.id, name: p.name || "—", nameLocked: !!p.nameLocked,
        staff: !!p.staff, optIn: !!p.optIn,
        riotId: p.riotId || "", puuid: p.puuid || "",
        rank: p.rank || null,
        discord: p.discord || null,
        roles: Array.isArray(p.roles) ? p.roles : [],
        joinedAt: p.joinedAt || 0, updatedAt: p.updatedAt || 0
      }));
      /* ★ チーム（ダブルアップのペア）を整える。
         ・存在しない選手は外す
         ・同じ人が2チームに入っていたら、先に出てきたほうを残す */
      {
        const seen = {};
        const alive = id => s.roster.some(p => p.id === id);
        s.teams = (Array.isArray(s.teams) ? s.teams : [])
          .filter(t => t && t.id)
          .map(t => {
            const ms = (Array.isArray(t.members) ? t.members : [])
              .filter(pid => alive(pid) && !seen[pid])
              .slice(0, TEAM_SIZE);
            ms.forEach(pid => { seen[pid] = 1; });
            return {
              id: String(t.id), name: typeof t.name === "string" ? t.name : "",
              members: ms,
              createdAt: t.createdAt || 0, updatedAt: t.updatedAt || 0
            };
          });
      }
      const slots = slotCount(s.mode);
      // 席に入ってよいIDの集合（ソロ=選手 / ダブルアップ=チーム）
      const unitOk = isDouble(s)
        ? id => s.teams.some(t => t.id === id)
        : id => s.roster.some(p => p.id === id);
      if (!Array.isArray(s.matches)) s.matches = buildMatches(s.matchCount, s.tableCount, s.mode);
      for (let m = 0; m < s.matchCount; m++) {
        if (!s.matches[m]) s.matches[m] = { tables: [], present: null };
        if (!Array.isArray(s.matches[m].tables)) s.matches[m].tables = [];
        for (let t = 0; t < s.tableCount; t++) {
          let tb = s.matches[m].tables[t];
          if (!tb) { tb = emptyTable(s.mode); s.matches[m].tables[t] = tb; }
          if (!Array.isArray(tb.seats)) tb.seats = new Array(slots).fill(null);
          // モードを切り替えたあとなど、席の数が合わなければ入れ直す
          tb.seats = tb.seats.filter(id => id && unitOk(id));
          while (tb.seats.length < slots) tb.seats.push(null);
          tb.seats.length = slots;
          if (!tb.placements || typeof tb.placements !== "object") tb.placements = {};
          Object.keys(tb.placements).forEach(id => { if (!unitOk(id)) delete tb.placements[id]; });
        }
        const pr = s.matches[m].present;
        s.matches[m].present = Array.isArray(pr) ? pr.filter(id => unitOk(id)) : null;
      }
      s.matches.length = s.matchCount;
      return s;
    }

    /* ---- 保存（デバウンス）---- */
    function save() {
      if (applyingRemote) return;
      state.updatedAt = Date.now();
      emit();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, 250);
    }
    async function persist() {
      try {
        if (mode === "firestore" && docRef) await docRef.set(JSON.parse(JSON.stringify(state)));
        else localStorage.setItem(lsKey(), JSON.stringify(state));
        upsertIndex();
      } catch (e) { console.error("persist failed", e); }
    }

    /* ---- ボード索引 ---- */
    function indexEntry() {
      return {
        title: state.title || "", matchCount: state.matchCount, tableCount: state.tableCount,
        players: participants(state).length, visibility: normVisibility(state.visibility),
        updatedAt: state.updatedAt || Date.now()
      };
    }
    async function upsertIndex() {
      try {
        if (mode === "firestore" && indexRef) await indexRef.set({ boards: { [idxKey(boardId)]: indexEntry() } }, { merge: true });
        else {
          const idx = JSON.parse(localStorage.getItem(INDEX_LS_KEY) || "{}");
          idx[boardId] = indexEntry();
          localStorage.setItem(INDEX_LS_KEY, JSON.stringify(idx));
        }
      } catch (e) { console.error("index upsert failed", e); }
    }
    async function listBoards() {
      let map = {};
      try {
        if (mode === "firestore" && indexRef) {
          const snap = await indexRef.get();
          if (snap.exists) Object.entries((snap.data() || {}).boards || {}).forEach(([k, v]) => { map[decodeURIComponent(k)] = v; });
        } else map = JSON.parse(localStorage.getItem(INDEX_LS_KEY) || "{}");
      } catch (e) { console.error("listBoards", e); map = {}; }
      if (!map[boardId]) map[boardId] = indexEntry();
      return Object.entries(map).map(([id, v]) => ({
        id, title: (v && v.title) || "", matchCount: v && v.matchCount, tableCount: v && v.tableCount,
        players: (v && v.players) || 0, visibility: normVisibility(v && v.visibility),
        updatedAt: (v && v.updatedAt) || 0
      })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    function setBoardTitle(name) {
      if (!guard("大会名の変更")) return;
      state.title = (name || "").trim();
      save();
    }
    // 公開範囲の設定（管理者のみ）
    function setVisibility(patch) {
      if (!guard("公開範囲の変更")) return;
      const cur = normVisibility(state.visibility);
      const next = normVisibility({
        mode: patch && patch.mode != null ? patch.mode : cur.mode,
        roleIds: patch && patch.roleIds != null ? patch.roleIds : cur.roleIds
      });
      state.visibility = next;
      save();
    }

    /* ---- 設定 ---- */
    function setSettings(patch) {
      if (!guard("試合数・卓数の変更")) return;
      const mc = Math.max(1, (patch.matchCount != null ? patch.matchCount : state.matchCount) | 0);
      const tc = Math.max(1, (patch.tableCount != null ? patch.tableCount : state.tableCount) | 0);
      // 既存データ温存でリサイズ
      const next = buildMatches(mc, tc);
      for (let m = 0; m < mc; m++) {
        const om = state.matches[m];
        if (!om) continue;
        for (let t = 0; t < tc; t++) {
          const old = om.tables[t];
          if (old) {
            if (Array.isArray(old.seats)) next[m].tables[t].seats = old.seats.slice(0, SEATS_PER_TABLE);
            if (old.placements) next[m].tables[t].placements = old.placements;
          }
        }
        next[m].present = om.present || null;
      }
      state.matches = next;
      state.matchCount = mc;
      state.tableCount = tc;
      save();
    }

    /* ---- ログインユーザーの登録（upsert）----
       権限に関係なく「自分自身」だけは登録・更新できる（＝自己登録）。
       同じ discord.id なら情報を最新化（ランク・ロール・アバター）。
       ★ nameLocked が立っている選手は、管理者が付けた表示名を保持する。 */
    /* 自分が roster から消えていたら入れ直す。
       他の人の書き込みで roster が丸ごと置き換わったとき（最後の書き手が勝つため）や、
       入場直後に最初のスナップショットが届いたときに効く。自己修復用。 */
    function ensureSelf() {
      if (!selfSession) return;
      const p = Session.toPlayer(selfSession);
      if (!p) return;
      if (state.roster.some(x => x.id === p.id)) return;
      p.joinedAt = Date.now();
      state.roster.push(p);
      save();
    }

    function upsertSelf(session) {
      selfSession = session || selfSession;
      const p = Session.toPlayer(session);
      if (!p) return null;
      const i = state.roster.findIndex(x => x.id === p.id);
      if (i >= 0) {
        const prev = state.roster[i];
        const merged = Object.assign({}, prev, p, { joinedAt: prev.joinedAt || Date.now() });
        if (prev.nameLocked) { merged.name = prev.name; merged.nameLocked = true; }
        merged.optIn = !!prev.optIn;   // 管理者が付けた「参加させる」は再ログインで消さない
        state.roster[i] = merged;
      } else {
        p.joinedAt = Date.now();
        state.roster.push(p);
      }
      save();
      return p.id;
    }
    /* ログイン済みメンバー（全体名簿）を、このボードの名簿に取り込む。
       すでに居る人はそのまま（表示名・大会に参加 の設定を壊さない）。 */
    function mergeMembers(list) {
      if (!guard("メンバーの取り込み")) return 0;
      let added = 0;
      (list || []).forEach(m => {
        if (!m || !m.id) return;
        if (state.roster.some(x => x.id === m.id)) return;
        state.roster.push(Object.assign({}, m, { joinedAt: m.joinedAt || Date.now() }));
        added++;
      });
      if (added) save();
      return added;
    }
    function updatePlayer(pid, patch) {
      if (!guard("選手情報の編集")) return;
      const p = state.roster.find(x => x.id === pid);
      if (!p) return;
      Object.assign(p, patch, { updatedAt: Date.now() });
      save();
    }
    // 表示名の手動設定（空文字でロック解除＝次回ログインでDiscord名に戻る）
    function setPlayerName(pid, name) {
      if (!guard("表示名の変更")) return;
      const p = state.roster.find(x => x.id === pid);
      if (!p) return;
      const nv = (name || "").trim();
      if (nv) { p.name = nv; p.nameLocked = true; }
      else { p.nameLocked = false; p.name = (p.discord && p.discord.name) || p.name; }
      p.updatedAt = Date.now();
      save();
    }
    // 運営ロールの人を大会に参加させる / 外す（管理者のみ）
    function setOptIn(pid, on) {
      if (!guard("運営メンバーの参加切り替え")) return;
      const p = state.roster.find(x => x.id === pid);
      if (!p) return;
      p.optIn = !!on;
      p.updatedAt = Date.now();
      if (!on) {
        // 外すときは席と順位からも抜く
        state.matches.forEach(mt => {
          if (Array.isArray(mt.present)) mt.present = mt.present.filter(id => id !== pid);
          mt.tables.forEach(tb => {
            const i = tb.seats.indexOf(pid);
            if (i >= 0) tb.seats[i] = null;
            delete tb.placements[pid];
          });
        });
      }
      save();
    }
    function removePlayer(pid) {
      if (!guard("選手の削除")) return;
      state.roster = state.roster.filter(p => p.id !== pid);
      state.matches.forEach(mt => {
        if (Array.isArray(mt.present)) mt.present = mt.present.filter(id => id !== pid);
        mt.tables.forEach(tb => {
          const i = tb.seats.indexOf(pid);
          if (i >= 0) tb.seats[i] = null;
          delete tb.placements[pid];
        });
      });
      save();
    }

    /* =============================================================
       ★ チーム（ダブルアップのペア）の編集
       ポイントはチームに付くので、中身の2人を入れ替えても
       そのチームが積んだptはそのまま残ります。
       ============================================================= */
    function setMode(mode) {
      if (!guard("モードの変更")) return;
      const next = (mode === "doubleup") ? "doubleup" : "solo";
      if (state.mode === next) return;
      state.mode = next;
      // 席に入るものが変わる（選手 ↔ チーム）ので、配置と順位はいったん白紙にする
      state.matches.forEach(mt => {
        mt.present = null;
        mt.tables.forEach(tb => {
          tb.seats = new Array(slotCount(state)).fill(null);
          tb.placements = {};
        });
      });
      save();
    }
    function createTeam(members, name) {
      if (!guard("チームの作成")) return null;
      const ms = (Array.isArray(members) ? members : [])
        .filter(pid => playerById(state, pid))
        .slice(0, TEAM_SIZE);
      // ほかのチームに入っている人は先に外す
      ms.forEach(pid => {
        const t = teamOfPlayer(state, pid);
        if (t) t.members = t.members.filter(x => x !== pid);
      });
      const t = {
        id: newTeamId(), name: String(name || "").trim().slice(0, 40),
        members: ms, createdAt: Date.now(), updatedAt: Date.now()
      };
      if (!Array.isArray(state.teams)) state.teams = [];
      state.teams.push(t);
      save();
      return t.id;
    }
    function setTeamMembers(teamId, members) {
      if (!guard("チームの変更")) return;
      const t = teamById(state, teamId);
      if (!t) return;
      const ms = (Array.isArray(members) ? members : [])
        .filter(pid => playerById(state, pid))
        .slice(0, TEAM_SIZE);
      ms.forEach(pid => {
        const other = teamOfPlayer(state, pid);
        if (other && other.id !== teamId) other.members = other.members.filter(x => x !== pid);
      });
      t.members = ms;
      t.updatedAt = Date.now();
      save();
    }
    function setTeamName(teamId, name) {
      if (!guard("チーム名の変更")) return;
      const t = teamById(state, teamId);
      if (!t) return;
      t.name = String(name || "").trim().slice(0, 40);
      t.updatedAt = Date.now();
      save();
    }
    /* チームを消す。ptの履歴ごと消えるので、席と順位からも外す。 */
    function removeTeam(teamId) {
      if (!guard("チームの削除")) return;
      state.teams = teamsOf(state).filter(t => t.id !== teamId);
      state.matches.forEach(mt => {
        if (Array.isArray(mt.present)) mt.present = mt.present.filter(id => id !== teamId);
        mt.tables.forEach(tb => {
          const i = tb.seats.indexOf(teamId);
          if (i >= 0) tb.seats[i] = null;
          delete tb.placements[teamId];
        });
      });
      save();
    }
    /* ペアが決まっていない参加者を、上から2人ずつ組ませる。
       すでにあるチームは触らない。 */
    function autoPairTeams() {
      if (!guard("自動でペアを作る")) return 0;
      const rest = unpairedPlayers(state);
      let made = 0;
      for (let i = 0; i + 1 < rest.length; i += 2) {
        const t = {
          id: newTeamId(), name: "",
          members: [rest[i].id, rest[i + 1].id],
          createdAt: Date.now(), updatedAt: Date.now()
        };
        if (!Array.isArray(state.teams)) state.teams = [];
        state.teams.push(t);
        made++;
      }
      if (made) save();
      return made;
    }
    /* 空きのあるチームに1人入れる。空きが無ければ新しいチームを作る。 */
    function addToTeam(teamId, pid) {
      if (!guard("チームへの追加")) return;
      const t = teamById(state, teamId);
      if (!t || !playerById(state, pid)) return;
      if (t.members.length >= TEAM_SIZE) return;
      const other = teamOfPlayer(state, pid);
      if (other) other.members = other.members.filter(x => x !== pid);
      t.members.push(pid);
      t.updatedAt = Date.now();
      save();
    }
    function removeFromTeam(pid) {
      if (!guard("チームからの除外")) return;
      const t = teamOfPlayer(state, pid);
      if (!t) return;
      t.members = t.members.filter(x => x !== pid);
      t.updatedAt = Date.now();
      save();
    }

    /* ---- 席・順位 ---- */
    function assignSeat(matchIdx, tableIdx, seatIdx, pid) {
      if (!guard("席の配置")) return;
      const tb = state.matches[matchIdx].tables[tableIdx];
      const kicked = tb.seats[seatIdx] || null;       // そこに座っていた人（居れば押し出される）
      // 同じ試合で既に座っていたら外す
      state.matches[matchIdx].tables.forEach(x => {
        const i = x.seats.indexOf(pid);
        if (i >= 0) x.seats[i] = null;
      });
      tb.seats[seatIdx] = pid;
      if (kicked && kicked !== pid) {
        state.matches[matchIdx].tables.forEach(x => { delete x.placements[kicked]; });
      }
      save();
    }
    function clearSeat(matchIdx, tableIdx, seatIdx) {
      if (!guard("席のクリア")) return;
      const tb = state.matches[matchIdx].tables[tableIdx];
      const pid = tb.seats[seatIdx];
      tb.seats[seatIdx] = null;
      if (pid) delete tb.placements[pid];
      save();
    }
    /* ドラッグ&ドロップ用。
       席 → 席 の移動。移動先に人が居たら入れ替える（＝席交換）。
       卓をまたいだ場合は、その卓で入れた順位は意味を失うので消す。 */
    function moveSeat(matchIdx, fromT, fromS, toT, toS) {
      if (!guard("席の入れ替え")) return;
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const a = mt.tables[fromT], b = mt.tables[toT];
      if (!a || !b) return;
      if (fromT === toT && fromS === toS) return;
      const pa = a.seats[fromS] || null;
      const pb = b.seats[toS] || null;
      a.seats[fromS] = pb;
      b.seats[toS] = pa;
      if (fromT !== toT) {
        if (pa) { delete a.placements[pa]; delete b.placements[pa]; }
        if (pb) { delete a.placements[pb]; delete b.placements[pb]; }
      }
      save();
    }
    /* ドラッグ&ドロップ用。その試合の席からこの選手を外す（参加者リストへ戻す）。 */
    function unseatPlayer(matchIdx, pid) {
      if (!guard("席から外す")) return;
      const mt = state.matches[matchIdx];
      if (!mt || !pid) return;
      mt.tables.forEach(tb => {
        const i = tb.seats.indexOf(pid);
        if (i >= 0) tb.seats[i] = null;
        delete tb.placements[pid];
      });
      save();
    }
    function setPlacement(matchIdx, tableIdx, pid, rank) {
      if (!guard("順位の入力")) return;
      const tb = state.matches[matchIdx].tables[tableIdx];
      if (rank) tb.placements[pid] = rank | 0;
      else delete tb.placements[pid];
      save();
    }
    function clearMatchSeats(matchIdx) {
      if (!guard("配置のクリア")) return;
      const mt = state.matches[matchIdx];
      if (!mt) return;
      mt.tables.forEach(tb => { tb.seats = new Array(slotCount(state)).fill(null); tb.placements = {}; });
      save();
    }
    function clearAllResults() {
      if (!guard("全結果のクリア")) return;
      state.matches.forEach(mt => mt.tables.forEach(tb => { tb.placements = {}; }));
      save();
    }
    function resetBoard() {
      if (!guard("ボードの初期化")) return;
      const roster = state.roster; // ログイン済みメンバーは残す
      state = blankState();
      state.roster = roster;
      save();
    }
    function importState(obj) {
      if (!guard("バックアップからの復元")) return;
      state = normalize(obj);
      save();
    }
    function loadBoardState(id) {
      // 読み取り専用で別ボードの状態を取得
      return (async () => {
        if (mode === "firestore" && db) {
          const snap = await db.collection("lboards").doc(id).get();
          return snap.exists ? normalize(snap.data()) : null;
        }
        const raw = localStorage.getItem("mcclb2:" + id);
        return raw ? normalize(JSON.parse(raw)) : null;
      })();
    }

    /* ---- 参加者（出席）管理 ----
       ★ ダブルアップでは「チーム単位」で出欠を持ちます。
         自分のチェックを外すと、相方ごと外れます（1人だけ出ることはできないため）。 */
    function materializePresent(matchIdx) {
      const mt = state.matches[matchIdx];
      if (!mt) return [];
      if (!Array.isArray(mt.present)) mt.present = unitsOf(state);
      return mt.present;
    }
    // その試合からこのユニットを外す（席と順位も消す）
    function dropUnit(mt, uid) {
      mt.tables.forEach(tb => {
        const si = tb.seats.indexOf(uid);
        if (si >= 0) tb.seats[si] = null;
        delete tb.placements[uid];
      });
    }
    // 一般プレイヤーは「自分の出欠」だけ切り替えられる
    function setPresent(matchIdx, pid, on) {
      if (!actor.isAdmin && pid !== actor.pid) return deny("他の選手の出欠変更");
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const uid = unitOfPlayer(state, pid);
      if (!uid) return;                    // ダブルアップでペアが未設定
      const arr = materializePresent(matchIdx);
      const i = arr.indexOf(uid);
      if (on) { if (i < 0) arr.push(uid); }
      else {
        if (i >= 0) arr.splice(i, 1);
        dropUnit(mt, uid);
      }
      save();
    }
    function setAllPresent(matchIdx, on, pids) {
      if (!guard("出欠の一括変更")) return;
      // pids を渡すとその集合だけを対象にする（ロールフィルタ用）
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const target = Array.isArray(pids)
        ? [...new Set(pids.map(pid => unitOfPlayer(state, pid)).filter(Boolean))]
        : unitsOf(state);
      const arr = materializePresent(matchIdx);
      if (on) {
        target.forEach(id => { if (!arr.includes(id)) arr.push(id); });
      } else {
        mt.present = arr.filter(id => !target.includes(id));
        target.forEach(uid => dropUnit(mt, uid));
      }
      save();
    }
    // 指定ロール保持者だけを参加にする
    function setPresentByRole(matchIdx, roleId) {
      if (!guard("ロールによる出欠の一括変更")) return;
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const keep = unitsOf(state).filter(uid =>
        unitPlayers(state, uid).some(p => hasRole(p, roleId)));
      mt.present = keep;
      unitsOf(state).forEach(uid => { if (keep.indexOf(uid) < 0) dropUnit(mt, uid); });
      save();
    }

    /* ---- 自動組卓 ----
       opts = {
         method: "random" | "points" | "roleBalance" | "roleGroup",
         roleId: roleBalance / roleGroup で使うロールID（roleGroupは省略可）,
         limitRoleId: このロール保持者だけを対象にする（省略可）
       }
       roleBalance : roleId 保持者を各卓へ均等に散らす（例: コーチを各卓1人ずつ）
       roleGroup   : 同じロールの人を同じ卓へ固める（roleId指定時はそのロール優先、
                     省略時は最上位ロールでグループ化） */
    function autoAssign(matchIdx, opts) {
      if (!guard("自動組卓")) return null;
      opts = opts || {};
      const method = opts.method || "random";
      const mt = state.matches[matchIdx];
      if (!mt) return null;
      const tableCount = state.tableCount;
      const cap = tableCount * slotCount(state);

      // ソロは選手ID、ダブルアップはチームIDが並ぶ
      let ids = presentUnits(state, matchIdx).slice();
      if (opts.limitRoleId) {
        ids = ids.filter(id => unitPlayers(state, id).some(p => hasRole(p, opts.limitRoleId)));
      }
      let dropped = 0;

      const shuffle = arr => {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      };
      const cumPts = () => {
        const pts = {};
        ids.forEach(id => { pts[id] = 0; });
        for (let m = 0; m < matchIdx; m++) {
          const pm = state.matches[m];
          if (!pm) continue;
          pm.tables.forEach(tb => tb.seats.forEach(uid => {
            if (uid && pts[uid] != null) {
              const r = tb.placements[uid];
              if (r) pts[uid] += pointsFor(state.mode, r);
            }
          }));
        }
        return pts;
      };

      if (ids.length > cap) { dropped = ids.length - cap; }

      // 卓ごとの定員（均等配分）
      const useCount = Math.min(ids.length, cap);
      const counts = new Array(tableCount).fill(0);
      {
        const base = Math.floor(useCount / tableCount), rem = useCount % tableCount;
        for (let t = 0; t < tableCount; t++) counts[t] = base + (t < rem ? 1 : 0);
      }

      // 席リセット
      mt.tables.forEach(tb => { tb.seats = new Array(slotCount(state)).fill(null); tb.placements = {}; });
      const fill = new Array(tableCount).fill(0);
      const put = (t, pid) => {
        if (fill[t] >= counts[t]) return false;
        mt.tables[t].seats[fill[t]++] = pid;
        return true;
      };

      if (method === "points") {
        const pts = cumPts();
        ids.sort((a, b) => (pts[b] - pts[a]) || (Math.random() - 0.5));
        let idx = 0;
        for (let t = 0; t < tableCount && idx < ids.length; t++)
          while (fill[t] < counts[t] && idx < ids.length) put(t, ids[idx++]);
      } else if (method === "roleBalance" && opts.roleId) {
        const hasR = id => unitPlayers(state, id).some(p => hasRole(p, opts.roleId));
        const withRole = shuffle(ids.filter(hasR));
        const rest = shuffle(ids.filter(id => !hasR(id)));
        // ロール保持者を卓0,1,2...へ順に散らす
        let t = 0;
        withRole.forEach(pid => {
          let tries = 0;
          while (!put(t % tableCount, pid) && tries < tableCount) { t++; tries++; }
          t++;
        });
        // 残りは空きの多い卓から
        rest.forEach(pid => {
          let best = -1, bestRoom = -1;
          for (let k = 0; k < tableCount; k++) {
            const room = counts[k] - fill[k];
            if (room > bestRoom) { bestRoom = room; best = k; }
          }
          if (best >= 0 && bestRoom > 0) put(best, pid);
        });
      } else if (method === "roleGroup") {
        // グループキー: roleId指定→そのロールの有無 / 未指定→最上位ロールID
        const keyOf = id => {
          const ps = unitPlayers(state, id);
          if (opts.roleId) return ps.some(p => hasRole(p, opts.roleId)) ? "in" : "out";
          const p = ps[0];
          return (p && p.roles && p.roles[0] && p.roles[0].id) || "_none";
        };
        const groups = {};
        shuffle(ids).forEach(pid => {
          const k = keyOf(pid);
          (groups[k] = groups[k] || []).push(pid);
        });
        // 大きいグループから卓へ詰める
        const ordered = Object.values(groups).sort((a, b) => b.length - a.length);
        const flat = [];
        ordered.forEach(g => flat.push(...g));
        let idx = 0;
        for (let t = 0; t < tableCount && idx < flat.length; t++)
          while (fill[t] < counts[t] && idx < flat.length) put(t, flat[idx++]);
      } else {
        shuffle(ids);
        let idx = 0;
        for (let t = 0; t < tableCount && idx < ids.length; t++)
          while (fill[t] < counts[t] && idx < ids.length) put(t, ids[idx++]);
      }

      save();
      return { assigned: Math.min(ids.length, cap), dropped, capacity: cap };
    }

    return {
      init, onChange, save,
      get state() { return state; },
      get mode() { return mode; },
      get boardId() { return boardId; },
      setActor, getActor, canEdit,
      setMode, createTeam, setTeamMembers, setTeamName, removeTeam,
      autoPairTeams, addToTeam, removeFromTeam,
      setSettings, upsertSelf, updatePlayer, setPlayerName, removePlayer, setOptIn,
      assignSeat, clearSeat, moveSeat, unseatPlayer, setPlacement, mergeMembers,
      clearMatchSeats, clearAllResults, resetBoard, importState, loadBoardState,
      setPresent, setAllPresent, setPresentByRole, autoAssign,
      listBoards, setBoardTitle, setVisibility,
      _persistNow: persist
    };
  }

  /* =============================================================
     ボード一覧（HOME用）— 特定のボードを開かずに索引だけ読む
     makeStore().init() と違い、default ボードを作ってしまわない。
     ============================================================= */
  const INDEX_LS_KEY_G = "mcc-lb2-board-index";
  function openDb() {
    const fb = CFG.firebase || {};
    const hasFb = fb.apiKey && fb.projectId && typeof window.firebase !== "undefined" && firebase.firestore;
    if (!hasFb) return null;
    if (!firebase.apps.length) firebase.initializeApp(fb);
    return firebase.firestore();
  }
  async function listAllBoards() {
    const db = openDb();
    let map = {};
    try {
      if (db) {
        const snap = await db.collection("lboard_index").doc("registry").get();
        if (snap.exists) Object.entries((snap.data() || {}).boards || {}).forEach(([k, v]) => { map[decodeURIComponent(k)] = v; });
      } else {
        map = JSON.parse(localStorage.getItem(INDEX_LS_KEY_G) || "{}");
      }
    } catch (e) { console.error("listAllBoards", e); }
    return Object.entries(map).map(([id, v]) => ({
      id,
      title: (v && v.title) || "",
      matchCount: (v && v.matchCount) || 0,
      tableCount: (v && v.tableCount) || 0,
      players: (v && v.players) || 0,
      visibility: normVisibility(v && v.visibility),
      updatedAt: (v && v.updatedAt) || 0
    })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  /* 大会名からボードIDを作る。日本語だけの名前なら日付ベースのIDになる。
     例: "第4回 校内カップ" → "board-20260913-4f2a" / "Camp 2026!" → "camp-2026" */
  function slugify(s) {
    const base = String(s || "").trim().toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "");
    // 英字が1文字も残らない場合は日付ベースにする。
    // 「第4回 校内カップ」が "4" になると「第5回」= "5" と衝突しやすく、意味も分からないため。
    if (base.length >= 2 && /[a-z]/.test(base)) return base;
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    const rnd = Math.random().toString(36).slice(2, 6);
    return "board-" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + rnd;
  }

  // 新規ボードを作る（管理者のみ）
  // createBoard(id, { title, visibility })   id を空にすると title から自動生成
  async function createBoard(id, opts) {
    opts = opts || {};
    id = String(id || "").trim();
    if (!id) id = slugify(opts.title);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error("ボードIDに使えるのは半角英数字・ハイフン・アンダースコアだけです（入力: " + id + "）");
    }
    if (!isAdmin()) throw new Error("ボードの作成は管理者のみです");

    const st = blankState();
    st.title = String(opts.title || "").trim();
    st.visibility = normVisibility(opts.visibility);
    const entry = {
      title: st.title, matchCount: st.matchCount, tableCount: st.tableCount,
      players: 0, visibility: st.visibility, updatedAt: st.updatedAt
    };

    const db = openDb();
    if (db) {
      let snap;
      try { snap = await db.collection("lboards").doc(id).get(); }
      catch (e) { throw new Error("Firestore を読めませんでした（" + (e.code || e.message) + "）。セキュリティルールに lboards / lboard_index を追加しているか確認してください"); }
      if (snap.exists) throw new Error("そのボードIDは既に使われています: " + id);
      try {
        await db.collection("lboards").doc(id).set(st);
        await db.collection("lboard_index").doc("registry")
          .set({ boards: { [encodeURIComponent(id)]: entry } }, { merge: true });
      } catch (e) {
        throw new Error("Firestore に書き込めませんでした（" + (e.code || e.message) + "）");
      }
    } else {
      if (localStorage.getItem("mcclb2:" + id)) throw new Error("そのボードIDは既に使われています: " + id);
      localStorage.setItem("mcclb2:" + id, JSON.stringify(st));
      const idx = JSON.parse(localStorage.getItem(INDEX_LS_KEY_G) || "{}");
      idx[id] = entry;
      localStorage.setItem(INDEX_LS_KEY_G, JSON.stringify(idx));
    }
    return id;
  }

  // ボードを削除する（管理者のみ）。索引からも消す。
  async function deleteBoard(id) {
    id = String(id || "").trim();
    if (!id) throw new Error("ボードIDが必要です");
    if (!isAdmin()) throw new Error("ボードの削除は管理者のみです");
    const db = openDb();
    if (db) {
      try {
        await db.collection("lboards").doc(id).delete();
        await db.collection("lboard_index").doc("registry").set({
          boards: { [encodeURIComponent(id)]: firebase.firestore.FieldValue.delete() }
        }, { merge: true });
      } catch (e) {
        throw new Error("削除に失敗しました（" + (e.code || e.message) + "）");
      }
    } else {
      localStorage.removeItem("mcclb2:" + id);
      const idx = JSON.parse(localStorage.getItem(INDEX_LS_KEY_G) || "{}");
      delete idx[id];
      localStorage.setItem(INDEX_LS_KEY_G, JSON.stringify(idx));
    }
    return id;
  }

  /* =============================================================
     HOME の設定（管理コンソールから編集できる）
     保存先は lboard_index/home — 既存のルール（match /lboard_index/{id}）で
     そのまま書けるので、セキュリティルールの追加は不要。
     ============================================================= */
  const HOME_LS_KEY = "mcc-lb2-home";
  // キービジュアル準拠の色。ui.css の --gold / --sky / … と対応。
  const TINTS = ["gold", "sky", "leaf", "mint", "coral", "navy"];
  // v2.8以前に保存されたタイルの色名を読み替える（設定を作り直さなくて済むように）
  const TINT_LEGACY = { pink: "gold", cyan: "sky", violet: "leaf", ok: "leaf", danger: "coral" };

  function defaultHomeConfig() {
    return {
      title: "クラウドハッシュテイル校 TOOLS",
      subtitle: "Discordログイン式ホーム",
      /* HOMEに並ぶタイル（この順番で出ます）。
         「ツール」「遊び場」は children を持つので、押すとHOMEの中でその場に開きます。
         VC稼働は管理コンソール（🔊 VC稼働タブ）にだけ置いてあり、ここには出しません。 */
      tiles: [
        { id: "schedule", icon: "🗓", img: "assets/tile-schedule.png", name: "予定表",       desc: "校内イベント・対抗戦の日程をカレンダーで確認。", url: "schedule.html", tint: "leaf", enabled: true, soon: false, roleIds: [] },
        { id: "members",  icon: "👥", img: "assets/tile-members.png",  name: "メンバー紹介", desc: "校のメンバーのプロフィールとロール。",           url: "members.html",  tint: "leaf", enabled: true, soon: true,  roleIds: [] },
        { id: "lp",       icon: "📈", img: "assets/tile-lp.png",       name: "LPランキング", desc: "メンバーのランクとLPを一覧で比較。",             url: "lp.html",       tint: "leaf", enabled: true, soon: false, roleIds: [] },
        { id: "boards",   icon: "🏆", img: "assets/tile-boards.png",   name: "大会",         desc: "リーダーボード。組卓・順位入力・全体順位。",     url: "boards.html",   tint: "leaf", enabled: true, soon: false, roleIds: [] },

        { id: "toolbox", icon: "🧰", img: "none", name: "ツール", desc: "練習やメモに使う道具をまとめてあります。",
          url: "", external: false, tint: "sky", enabled: true, soon: false, roleIds: [],
          children: [
            { id: "sim1st",  icon: "🥇", name: "1st simulator",     desc: "1位を取る練習をするシミュレーター。", url: "https://mo10c.github.io/TFT-Simulator/",    external: true, roleIds: [] },
            { id: "coating", icon: "📘", name: "コーチングノート",   desc: "コーチングのメモ。",                 url: "https://mo10c.github.io/TFT-CoachingNote/", external: true, roleIds: [] },
            { id: "augnote", icon: "📖", name: "オーグメントノート", desc: "オーグメントの評価とメモ。",         url: "",                                          external: true, roleIds: [] }
          ] },

        { id: "playground", icon: "🎮", img: "none", name: "遊び場", desc: "みんなで遊べるものを置いてあります。",
          url: "", external: false, tint: "coral", enabled: true, soon: false, roleIds: [],
          children: [
            { id: "midterm",  icon: "📝", name: "中間試験",            desc: "みんなで一斉に答えるクイズ。",      url: "exam.html", external: false, roleIds: [] },
            { id: "ito",      icon: "🎲", name: "ITO",                 desc: "みんなで遊ぶ ito 風カードゲーム。", url: "", external: true, roleIds: [] },
            { id: "codename", icon: "🕵️", name: "codenameジェネレータ", desc: "コードネームを作るツール。",        url: "", external: true, roleIds: [] },
            { id: "bloom",    icon: "🌸", name: "Bloom Spire",         desc: "",                                  url: "", external: true, roleIds: [] }
          ] }
      ].map(normTile),
      tools: ((((CFG.home || {}).tools) || []).slice()).map(normTool),
      channels: { promote: "notice", schedule: "notice", snapshot: "notice", final: "notice" },
      updatedAt: 0
    };
  }
  /* タイルの既定アイコン画像（idごと）。
     すでにHOME設定を保存してある場合、そこには img が入っていないので、
     ここを見て自動で補う。絵文字に戻したいときは img に "none" を入れる。 */
  const TILE_IMG = {
    boards: "assets/tile-boards.png",
    schedule: "assets/tile-schedule.png",
    members: "assets/tile-members.png",
    lp: "assets/tile-lp.png"
  };

  /* ★ ここで既定値を上書きしないこと。
     以前、保存済みの設定にURLや「中のリンク」を自動で補う仕組みを入れていたが、
     管理コンソールで消したり空にしたりしても復活してしまい、
     「保存しても元に戻る」状態になったので外した。
     既定値は defaultHomeConfig（＝まだ一度も保存していないとき）だけで使う。 */

  /* タイルの中に入るリンクカード（「遊び場」の中の Codename generator / ITO など）。
     children が1つ以上あるタイルは、押すとHOMEの中でその場に開く。 */
  function normChild(c, i) {
    c = c || {};
    return {
      id: String(c.id || ("kid" + i)),
      icon: String(c.icon || "🔗").slice(0, 4),
      name: String(c.name || "無題").slice(0, 40),
      desc: String(c.desc || "").slice(0, 120),
      url: String(c.url || "").slice(0, 300),
      external: c.external !== false,     // 中のリンクは外部サイトが基本
      roleIds: Array.isArray(c.roleIds) ? c.roleIds.map(String).filter(Boolean) : []
    };
  }
  // リンク先がまだ入っていないか（"#" や空は「未設定」とみなす）
  function noLink(u) {
    const v = String(u || "").trim();
    return !v || v === "#";
  }

  function normTile(t, i) {
    t = t || {};
    const tid = String(t.id || ("tile" + i));
    return {
      id: tid,
      icon: String(t.icon || "🔗").slice(0, 4),
      // ★ 画像アイコン。空なら icon（絵文字）を使う。
      //   読み込みに失敗したときも絵文字に戻るので、消えたままにはならない。
      img: String(t.img || TILE_IMG[tid] || "").slice(0, 300),
      name: String(t.name || "無題").slice(0, 40),
      desc: String(t.desc || "").slice(0, 120),
      url: String(t.url || "#").slice(0, 300),
      external: !!t.external,
      children: Array.isArray(t.children) ? t.children.map(normChild) : [],
      tint: TINTS.includes(t.tint) ? t.tint : (TINT_LEGACY[t.tint] || "gold"),
      enabled: t.enabled !== false,
      soon: !!t.soon,
      roleIds: Array.isArray(t.roleIds) ? t.roleIds.map(String).filter(Boolean) : []
    };
  }
  function normTool(t, i) {
    t = t || {};
    return {
      id: String(t.id || ("tool" + i)),
      icon: String(t.icon || "🔗").slice(0, 4),
      img: String(t.img || "").slice(0, 300),
      name: String(t.name || "無題").slice(0, 40),
      desc: String(t.desc || "").slice(0, 120),
      url: String(t.url || "#").slice(0, 300),
      external: !!t.external,
      roleIds: Array.isArray(t.roleIds) ? t.roleIds.map(String).filter(Boolean) : []
    };
  }
  function normHomeConfig(h) {
    const d = defaultHomeConfig();
    h = h || {};
    return {
      title: typeof h.title === "string" && h.title.trim() ? h.title.trim() : d.title,
      subtitle: typeof h.subtitle === "string" ? h.subtitle : d.subtitle,
      tiles: Array.isArray(h.tiles) && h.tiles.length ? h.tiles.map(normTile) : d.tiles,
      tools: Array.isArray(h.tools) ? h.tools.map(normTool) : d.tools.map(normTool),
      updatedAt: h.updatedAt || 0
    };
  }
  // 表示してよいタイル/ツールか（ロール制限。管理者は常に見える）
  function canSeeEntry(entry, session) {
    const ids = (entry && entry.roleIds) || [];
    if (!ids.length) return true;
    if (isAdmin(session)) return true;
    const s = session || Session.get();
    const roles = (s && s.discord && s.discord.roles) || [];
    return roles.some(r => r && ids.includes(String(r.id)));
  }

  /* 直近に読み込んだHOME設定をブラウザに残しておく。
     初回描画をこれで行うことで、Firestore の応答を待つ間に
     既定の並び順が一瞬見えてしまうのを防ぐ。 */
  const HOME_CACHE_KEY = "mcc-lb2-home-cache";
  function cacheHomeConfig(cfg) {
    try { localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(cfg)); } catch (e) { }
  }
  // 同期的に返る（await 不要）。キャッシュが無ければ null。
  function cachedHomeConfig() {
    try {
      const raw = localStorage.getItem(HOME_CACHE_KEY);
      if (raw) return normHomeConfig(JSON.parse(raw));
    } catch (e) { }
    return null;
  }
  // 描き直しが必要かの判定に使う（updatedAt の差だけでは描き直さない）
  function homeConfigKey(cfg) {
    const c = normHomeConfig(cfg);
    return JSON.stringify({ t: c.title, s: c.subtitle, tiles: c.tiles, tools: c.tools });
  }

  async function loadHomeConfig() {
    const db = openDb();
    try {
      if (db) {
        const snap = await db.collection("lboard_index").doc("home").get();
        if (snap.exists) {
          const cfg = normHomeConfig(snap.data());
          cacheHomeConfig(cfg);
          return cfg;
        }
      } else {
        const raw = localStorage.getItem(HOME_LS_KEY);
        if (raw) {
          const cfg = normHomeConfig(JSON.parse(raw));
          cacheHomeConfig(cfg);
          return cfg;
        }
      }
      // 保存された設定がまだ無い場合も既定値をキャッシュしておく
      const d = defaultHomeConfig();
      cacheHomeConfig(d);
      return d;
    } catch (e) {
      console.warn("HOME設定の読み込みに失敗", e);
      // 通信に失敗したときはキャッシュを優先（既定値に戻さない）
      return cachedHomeConfig() || defaultHomeConfig();
    }
  }
  async function saveHomeConfig(h) {
    if (!isAdmin()) throw new Error("HOMEの編集は管理者のみです");
    const cfg = normHomeConfig(h);
    cfg.updatedAt = Date.now();
    const db = openDb();
    try {
      if (db) await db.collection("lboard_index").doc("home").set(cfg);
      else localStorage.setItem(HOME_LS_KEY, JSON.stringify(cfg));
    } catch (e) {
      throw new Error("HOME設定を保存できませんでした（" + (e.code || e.message) + "）");
    }
    cacheHomeConfig(cfg);
    return cfg;
  }

  /* =============================================================
     LP 履歴
     保存先は lboard_index/lp（既存ルールでそのまま書ける）。

       { members: { "u_123": {name, avatar, riotId, puuid, tier, division, lp, abs, updatedAt} },
         hist:    { "u_123": { "2026-09-14": 2279, ... } },   ← 1日1点。絶対LP
         baseline: "2026-09-13",                              ← 比較の基準日（管理画面で設定）
         updatedAt }

     ★ 絶対LP: ティアをまたいで比較・作図できるよう、1本の数値に畳む。
        IRON IV 0LP = 0 ／ 1ティア = 400 ／ 1ディビジョン = 100
        マスター以上は 2800 + LP（GM/チャレは表示上マスター帯として扱う）
     ============================================================= */
  const TIER_BASE = {
    IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200, PLATINUM: 1600,
    EMERALD: 2000, DIAMOND: 2400, MASTER: 2800, GRANDMASTER: 2800, CHALLENGER: 2800
  };
  const DIV_ADD = { IV: 0, III: 100, II: 200, I: 300 };
  const TIER_ORDER = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER"];

  function absLP(rank) {
    if (!rank || !rank.tier) return null;
    const base = TIER_BASE[rank.tier];
    if (base == null) return null;
    if (base >= 2800) return 2800 + (rank.lp | 0);
    return base + (DIV_ADD[rank.division] || 0) + (rank.lp | 0);
  }
  // 絶対LP → 表示用ラベル（グラフの目盛りなどに使う）
  function absToLabel(v) {
    if (v == null) return "—";
    if (v >= 2800) return "MASTER+ " + Math.round(v - 2800) + "LP";
    const ti = Math.min(TIER_ORDER.length - 2, Math.floor(v / 400));
    const rest = v - ti * 400;
    const di = Math.min(3, Math.floor(rest / 100));
    const div = ["IV", "III", "II", "I"][di];
    return TIER_ORDER[ti] + " " + div + " " + Math.round(rest - di * 100) + "LP";
  }
  /* 短い表記。グラフの線の右はしなど、幅が無いところで使う。
     例: EMERALD II 79LP → "E2 79LP" ／ GRANDMASTER 272LP → "GM 272LP"
     ★ 絶対LP（2279 など）をそのまま出すと何の数字か分からないので、必ずこちらを通すこと。 */
  const TIER_ABBR = {
    IRON: "I", BRONZE: "B", SILVER: "S", GOLD: "G", PLATINUM: "P",
    EMERALD: "E", DIAMOND: "D", MASTER: "M", GRANDMASTER: "GM", CHALLENGER: "C", RATED: "R"
  };
  const DIV_NUM = { IV: "4", III: "3", II: "2", I: "1" };
  const NO_DIV = /^(MASTER|GRANDMASTER|CHALLENGER|RATED)$/;

  // ランク（tier/division/lp）から短い表記
  function rankShort(rank) {
    if (!rank || !rank.tier) return "—";
    const t = TIER_ABBR[rank.tier] || String(rank.tier).slice(0, 1);
    const div = NO_DIV.test(rank.tier) ? "" : (DIV_NUM[rank.division] || "");
    return t + div + " " + (rank.lp | 0) + "LP";
  }
  // 絶対LPから短い表記（過去の点など、ティアが分からないとき用）
  function absToShort(v) {
    if (v == null) return "—";
    if (v >= 2800) return "M " + Math.round(v - 2800) + "LP";
    const ti = Math.min(TIER_ORDER.length - 2, Math.floor(v / 400));
    const rest = v - ti * 400;
    const di = Math.min(3, Math.floor(rest / 100));
    return (TIER_ABBR[TIER_ORDER[ti]] || "?") + ["4", "3", "2", "1"][di] +
      " " + Math.round(rest - di * 100) + "LP";
  }

  // ティアの境目（グラフの補助線用）
  function tierLines(min, max) {
    const out = [];
    TIER_ORDER.forEach((t, i) => {
      const v = i * 400;
      if (v >= min && v <= max) out.push({ v, name: t });
    });
    return out;
  }
  /* ★ 日付キーは「日本時間(JST)」で固定する。
     Cloudflare Worker の集計(23:45 JST)も同じ計算をしているので、
     海外や時差のある端末で見ても、同じ日の点が同じ日として並ぶ。
     以前は端末のローカル時刻だったため、日付がズレて
     ・グラフの線が飛ぶ ・1日に2点できる といった症状が出ていた。 */
  const JST_MS = 9 * 3600 * 1000;
  function dayKey(d) {
    const t = (d instanceof Date) ? d.getTime() : (typeof d === "number" ? d : Date.now());
    const j = new Date(t + JST_MS);
    const p = n => String(n).padStart(2, "0");
    return j.getUTCFullYear() + "-" + p(j.getUTCMonth() + 1) + "-" + p(j.getUTCDate());
  }
  // 日本時間での「今 何時何分か」（集計時刻の案内に使う）
  function jstNow() { return new Date(Date.now() + JST_MS); }
  function shiftDay(key, delta) {
    const [y, m, d] = key.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + (delta | 0)));
    const p = n => String(n).padStart(2, "0");
    return dt.getUTCFullYear() + "-" + p(dt.getUTCMonth() + 1) + "-" + p(dt.getUTCDate());
  }

  const LP_DOC = "lp";
  const LP_LS_KEY = "mcc-lb2-lp";
  const LP_KEEP_DAYS = 120;

  function normLp(raw) {
    raw = raw || {};
    const members = {}, hist = {};
    Object.entries(raw.members || {}).forEach(([id, m]) => {
      if (!id || !m) return;
      members[id] = {
        id,
        name: String(m.name || "—"),
        avatar: String(m.avatar || ""),
        riotId: String(m.riotId || ""),
        puuid: String(m.puuid || ""),
        tier: String(m.tier || ""),
        division: String(m.division || ""),
        lp: m.lp | 0,
        abs: (typeof m.abs === "number") ? m.abs : null,
        // ★ 並び（生徒 → 先生 → 校長…）のためにDiscordロールも持っておく
        roles: Array.isArray(m.roles)
          ? m.roles.filter(r => r && r.id).map(r => ({
              id: String(r.id), name: String(r.name || ""), color: r.color | 0 }))
          : [],
        updatedAt: m.updatedAt || 0
      };
    });
    Object.entries(raw.hist || {}).forEach(([id, series]) => {
      if (!id || !series || typeof series !== "object") return;
      const s = {};
      Object.entries(series).forEach(([d, v]) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof v === "number") s[d] = v;
      });
      hist[id] = s;
    });
    return {
      members, hist,
      baseline: /^\d{4}-\d{2}-\d{2}$/.test(raw.baseline) ? raw.baseline : "",
      // ★ LPランキングの並び順（管理コンソールで並び替えたもの）
      groupOrder: Array.isArray(raw.groupOrder)
        ? raw.groupOrder.filter(g => g && g.roleId).map(g => ({
            roleId: String(g.roleId),
            name: String(g.name || ""),
            color: g.color | 0,
            label: String(g.label || "").trim()
          }))
        : [],
      // ★ 最後に自動集計(23:45)が走った日と時刻。集計が動いているか確認するために表示する
      lastCollect: /^\d{4}-\d{2}-\d{2}$/.test(raw.lastCollect) ? raw.lastCollect : "",
      lastCollectAt: raw.lastCollectAt || 0,
      updatedAt: raw.updatedAt || 0
    };
  }

  async function loadLpData() {
    // ★ openDb() も try の中に入れる。
    //    ここで例外が飛ぶと「読み込み失敗」になり、原因が分からなくなるため。
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection("lboard_index").doc(LP_DOC).get();
        if (snap.exists) return normLp(snap.data());
      } else {
        const raw = localStorage.getItem(LP_LS_KEY);
        if (raw) return normLp(JSON.parse(raw));
      }
    } catch (e) { console.warn("LP履歴の読み込みに失敗", e); }
    return normLp(null);
  }

  /* 1人ぶんのLPを今日の日付で記録する（1日1点・同日は上書き）
     ★ opts.history === false のときは「名前・アイコン・Riot ID・ロール」だけを更新し、
        ランク(tier/lp/abs)と履歴(hist)には一切触らない。
        ログイン時にこれを呼ぶことで、集計対象の名簿だけを最新に保てる。 */
  async function recordLp(player, opts) {
    opts = opts || {};
    const withHistory = opts.history !== false;
    if (!player || !player.id) return null;
    if (player.staff && !player.optIn) return null;   // 運営ロールはLPランキングに出さない
    const rank = player.rank || null;
    const abs = absLP(rank);
    const today = dayKey();
    // 名簿としての情報（いつ書いても安全なもの）
    const entry = {
      name: player.name || "—",
      avatar: (player.discord && player.discord.avatar) || player.avatar || "",
      riotId: player.riotId || "",
      puuid: player.puuid || "",
      roles: rolesOf(player),
      updatedAt: Date.now()
    };
    // ランクと履歴は「集計」のときだけ書く（＝23:45の自動集計と、管理画面の手動集計）
    if (withHistory) {
      entry.tier = (rank && rank.tier) || "";
      entry.division = (rank && rank.division) || "";
      entry.lp = (rank && rank.lp) | 0;
      entry.abs = abs;
      entry.rankAt = Date.now();
    }
    const patch = { members: { [player.id]: entry }, updatedAt: Date.now() };
    if (withHistory && abs != null) patch.hist = { [player.id]: { [today]: abs } };

    const db = openDb();
    try {
      if (db) await db.collection("lboard_index").doc(LP_DOC).set(patch, { merge: true });
      else {
        const cur = normLp(JSON.parse(localStorage.getItem(LP_LS_KEY) || "{}"));
        cur.members[player.id] = Object.assign({}, cur.members[player.id] || {}, entry);
        if (withHistory && abs != null) {
          cur.hist[player.id] = cur.hist[player.id] || {};
          cur.hist[player.id][today] = abs;
        }
        cur.updatedAt = Date.now();
        localStorage.setItem(LP_LS_KEY, JSON.stringify(cur));
      }
    } catch (e) { console.warn("LPの記録に失敗", e); return null; }
    return entry;
  }

  /* 指定した日の記録を全員ぶん消す。
     旧版が「ページを開いた時点のランク」を書いてしまった日の掃除に使う。
     ★ Firestore の merge では項目を消せないので、hist を丸ごと入れ替える。 */
  async function deleteLpDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) throw new Error("日付の形式が正しくありません");
    const cur = await loadLpData();
    const hist = {};
    let removed = 0;
    Object.entries(cur.hist || {}).forEach(([id, series]) => {
      const s = {};
      Object.entries(series).forEach(([d, v]) => { if (d === day) removed++; else s[d] = v; });
      hist[id] = s;
    });
    const db = openDb();
    if (db) {
      // set(merge:true) はマップを「足し算」するので項目を消せない。update で hist ごと置き換える。
      await db.collection("lboard_index").doc(LP_DOC).update({ hist, updatedAt: Date.now() });
    } else {
      const raw = JSON.parse(localStorage.getItem(LP_LS_KEY) || "{}");
      raw.hist = hist; raw.updatedAt = Date.now();
      localStorage.setItem(LP_LS_KEY, JSON.stringify(raw));
    }
    return removed;
  }

  /* 「集計を実行した」印を残す（管理画面から手動で回したとき用）。
     自動集計(23:45)は Worker 側が同じ項目を書いている。 */
  async function markLpCollected() {
    const stamp = { lastCollect: dayKey(), lastCollectAt: Date.now(), updatedAt: Date.now() };
    const db = openDb();
    try {
      if (db) await db.collection("lboard_index").doc(LP_DOC).set(stamp, { merge: true });
      else {
        const cur = JSON.parse(localStorage.getItem(LP_LS_KEY) || "{}");
        Object.assign(cur, stamp);
        localStorage.setItem(LP_LS_KEY, JSON.stringify(cur));
      }
    } catch (e) { console.warn("集計時刻の記録に失敗", e); }
  }

  /* ログインした人を「集計の名簿」に載せる。
     ★ ここでは LP の履歴も、表示中のランクも書き換えない。
        ログイン時のランクは古いことがあり（ログインした日のまま）、
        それを今日の値として書き込むと
        ・数値がおかしくなる ・グラフの線が飛ぶ ・23:45の集計が上書きされる
        という不具合になっていたため。
        実際のLPは毎日23:45の自動集計だけが書き込む。 */
  async function registerLpMember(session) {
    session = session || Session.get();
    const p = Session.toPlayer(session);
    if (!p) return false;
    const flag = "mcc-lb2-lp-roster-" + p.id + "-" + dayKey();
    try { if (localStorage.getItem(flag)) return false; } catch (e) { }
    const r = await recordLp(p, { history: false });
    try { if (r) localStorage.setItem(flag, "1"); } catch (e) { }
    return !!r;
  }
  // 旧名（古いページが読み込まれていても壊れないように残す）
  const recordLpForSelf = registerLpMember;

  /* =============================================================
     LPランキングの並び（グループ）

     config.js:
       roles: { lpGroups: [
         { name: "生徒",         roleIds: ["..."] },
         { name: "先生",         roleIds: ["..."] },
         { name: "校長・副校長", roleIds: ["...", "..."] }
       ] }

     ここに書いた順にグループが上から並びます。
     ★ 複数のグループのロールを持っている人は、
        「リストの下のほう（あとに書いたグループ）」に入ります。
        校長が生徒ロールも持っている、というケースを想定しています。
     どのグループにも当てはまらない人は、いちばん下の「その他」にまとまります。
     lpGroups が未設定なら、グループ分けはせず1つの並びになります。
     ============================================================= */
  function rolesOf(x) {
    const r = (x && Array.isArray(x.roles)) ? x.roles
      : ((x && x.discord && Array.isArray(x.discord.roles)) ? x.discord.roles : []);
    return r.filter(v => v && v.id).map(v => ({
      id: String(v.id), name: String(v.name || ""), color: v.color | 0 }));
  }

  /* 並び順（Firestore の lboard_index/lp → groupOrder）を取り出す。
     1要素 = Discordのロール1つ。
     label が同じ要素が隣り合っていると、1つの見出しにまとまる。
       [{roleId:"A", label:"生徒"}, {roleId:"B", label:"校長・副校長"},
        {roleId:"C", label:"校長・副校長"}]  → 見出しは「生徒」「校長・副校長」の2つ

     まだ保存されていなければ、旧仕様（config.js の roles.lpGroups）を読む。 */
  function lpGroupOrder(lp) {
    const saved = (lp && Array.isArray(lp.groupOrder)) ? lp.groupOrder : [];
    if (saved.length) {
      return saved.filter(g => g && g.roleId).map(g => ({
        roleId: String(g.roleId),
        name: String(g.name || ""),
        color: g.color | 0,
        label: String(g.label || "").trim() || String(g.name || "").trim() || "グループ"
      }));
    }
    // 旧仕様のフォールバック（config.js に書いてあれば読む）
    const out = [];
    (((CFG.roles || {}).lpGroups) || []).forEach(g => {
      const label = String((g && g.name) || "").trim() || "グループ";
      (((g && g.roleIds) || [])).forEach(id => {
        id = String(id).trim();
        if (id) out.push({ roleId: id, name: label, color: 0, label: label });
      });
    });
    return out;
  }
  /* 戻り値: 0..n-1 = その要素 / n = その他（どのロールも持たない） / -1 = 並び順が未設定 */
  function lpGroupIndex(member, order) {
    order = order || [];
    if (!order.length) return -1;
    const ids = rolesOf(member).map(r => r.id);
    if (ids.length) {
      // ★ 下にあるものほど優先。校長が生徒ロールも持っている場合に校長側へ入れるため。
      for (let i = order.length - 1; i >= 0; i--) {
        if (ids.indexOf(order[i].roleId) >= 0) return i;
      }
    }
    return order.length;
  }
  function lpSectionLabel(i, order) {
    order = order || [];
    if (i < 0) return "";
    return i < order.length ? order[i].label : "その他";
  }

  /* 並び順を保存（管理者のみ）。 */
  async function saveLpGroups(order) {
    if (!isAdmin()) throw new Error("並び順の変更は管理者のみです");
    const clean = (order || []).filter(g => g && g.roleId).map(g => ({
      roleId: String(g.roleId),
      name: String(g.name || ""),
      color: g.color | 0,
      label: String(g.label || "").trim() || String(g.name || "").trim() || "グループ"
    }));
    const db = openDb();
    try {
      if (db) {
        await db.collection("lboard_index").doc(LP_DOC)
          .set({ groupOrder: clean, updatedAt: Date.now() }, { merge: true });
      } else {
        const cur = normLp(JSON.parse(localStorage.getItem(LP_LS_KEY) || "{}"));
        cur.groupOrder = clean;
        cur.updatedAt = Date.now();
        localStorage.setItem(LP_LS_KEY, JSON.stringify(cur));
      }
    } catch (e) {
      throw new Error("並び順を保存できませんでした（" + (e.code || e.message) + "）");
    }
    return clean;
  }

  /* ロール情報だけをLPデータに書き戻す（Riot APIを呼ばないので速い）。
     グループ分けは members[].roles を見るので、
     まだロールが入っていない人がいるときに使う。 */
  async function syncLpRoles(players) {
    if (!isAdmin()) throw new Error("この操作は管理者のみです");
    const list = (players || []).filter(p => p && p.id);
    if (!list.length) return 0;
    const patch = { members: {}, updatedAt: Date.now() };
    list.forEach(p => {
      patch.members[p.id] = {
        name: p.name || "—",
        avatar: (p.discord && p.discord.avatar) || p.avatar || "",
        roles: rolesOf(p)
      };
    });
    const db = openDb();
    try {
      if (db) await db.collection("lboard_index").doc(LP_DOC).set(patch, { merge: true });
      else {
        const cur = normLp(JSON.parse(localStorage.getItem(LP_LS_KEY) || "{}"));
        list.forEach(p => {
          cur.members[p.id] = Object.assign({}, cur.members[p.id] || { id: p.id }, patch.members[p.id]);
        });
        cur.updatedAt = Date.now();
        localStorage.setItem(LP_LS_KEY, JSON.stringify(cur));
      }
    } catch (e) {
      throw new Error("ロール情報を保存できませんでした（" + (e.code || e.message) + "）");
    }
    return list.length;
  }

  async function setLpBaseline(date) {
    if (!isAdmin()) throw new Error("基準日の設定は管理者のみです");
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
    const db = openDb();
    try {
      if (db) await db.collection("lboard_index").doc(LP_DOC).set({ baseline: d, updatedAt: Date.now() }, { merge: true });
      else {
        const cur = normLp(JSON.parse(localStorage.getItem(LP_LS_KEY) || "{}"));
        cur.baseline = d;
        localStorage.setItem(LP_LS_KEY, JSON.stringify(cur));
      }
    } catch (e) { throw new Error("基準日を保存できませんでした（" + (e.code || e.message) + "）"); }
    return d;
  }

  /* ---- 集計 ----
     series : [{d, v}] 昇順
     latest : 最新の実測
     prev   : 今日より前で最も新しい実測（＝「前回計測」。毎日ログインしていない人でも比較できる）
     base   : 基準日以前で最も新しい実測。無ければ最古の実測 */
  /* 表示期間を決める。
     ★ mode "base"（既定）… 管理画面で指定した基準日をグラフの左端に固定する。
        基準日が未設定、または未来の日付なら直近30日にフォールバック。
     ★ mode が数値 … 「直近N日」（従来どおり）。 */
  function lpRange(lp, mode) {
    const to = dayKey();
    if (typeof mode === "number" && mode > 0) {
      return { from: shiftDay(to, -(mode - 1)), to, anchored: false };
    }
    const b = lp && lp.baseline;
    if (b && /^\d{4}-\d{2}-\d{2}$/.test(b) && b <= to) {
      return { from: b, to, anchored: true };
    }
    return { from: shiftDay(to, -29), to, anchored: false };
  }
  function daysBetween(from, to) {
    const n = k => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
    return Math.max(0, Math.round(n(to) - n(from)));
  }
  /* opts は
       数値            → 直近N日（従来の呼び方。互換のため残す）
       {from, to}      → その区間
       省略            → 全期間 */
  function lpSeries(lp, id, opts) {
    const h = (lp.hist && lp.hist[id]) || {};
    let keys = Object.keys(h).sort();
    if (typeof opts === "number" && opts > 0) {
      const from = shiftDay(dayKey(), -(opts - 1));
      keys = keys.filter(k => k >= from);
    } else if (opts && typeof opts === "object") {
      if (opts.from) keys = keys.filter(k => k >= opts.from);
      if (opts.to) keys = keys.filter(k => k <= opts.to);
    }
    return keys.map(k => ({ d: k, v: h[k] }));
  }
  function lpStats(lp, id) {
    const h = (lp.hist && lp.hist[id]) || {};
    const today = dayKey();
    // 未来の日付の点は無視する（端末の時計ズレで混ざることがある）
    const keys = Object.keys(h).filter(k => k <= today).sort();
    if (!keys.length) return { latest: null, prev: null, base: null, dayDelta: null, baseDelta: null, prevDate: "", baseDate: "" };
    const latestKey = keys[keys.length - 1];
    /* 「前日の伸び」は、きょうを入れずに、終わった2日ぶんを比べる。
       きょうの値は23:45の集計が済むまで途中経過なので、入れると数字が動いてしまう。
       例: 9/20 に見ているときは 9/19 −  9/18 を出す。 */
    const beforeToday = keys.filter(k => k < today);
    const prevKey  = beforeToday.length     ? beforeToday[beforeToday.length - 1] : null;  // 9/19
    const prev2Key = beforeToday.length > 1 ? beforeToday[beforeToday.length - 2] : null;  // 9/18

    let baseKey = null;
    if (lp.baseline) {
      const le = keys.filter(k => k <= lp.baseline);
      baseKey = le.length ? le[le.length - 1] : keys[0];
    }
    const latest = h[latestKey];
    const prev = prevKey != null ? h[prevKey] : null;
    const prev2 = prev2Key != null ? h[prev2Key] : null;
    const base = baseKey != null ? h[baseKey] : null;
    return {
      latest, prev, prev2, base,
      // 前日の伸び = 前日 − 前々日（きょうは含めない）
      dayDelta: (prev != null && prev2 != null) ? (prev - prev2) : null,
      baseDelta: (base != null) ? (latest - base) : null,
      latestDate: latestKey, prevDate: prevKey || "", prev2Date: prev2Key || "",
      baseDate: baseKey || ""
    };
  }

  /* =============================================================
     予定表（スケジュール）

     保存先: lboard_index/schedule
       { title, events: [{date:"2026-10-25", name:"開校式", star:true, note:""}],
         notify: true, updatedAt }

     ・date は YYYY-MM-DD（日本時間の日付）
     ・star を付けると予定表で強調され、Discord通知でも先頭に出る
     ・notify を false にすると、当日9時のDiscord通知を止められる

     まだ一度も保存していないときは、下の既定（＝もらった予定表の画像の内容）を返す。
     ============================================================= */
  const SCHED_DOC = "schedule";
  const SCHED_LS_KEY = "mcc-lb2-schedule";

  function defaultSchedule() {
    return {
      title: "クラウドハッシュテイル校　スケジュール表",
      notify: true,
      events: [
        { date: "2026-10-25", name: "開校式", star: true, note: "" },
        { date: "2026-10-25", name: "校内イベント 〜謎解き〜", star: false, note: "" },
        { date: "2026-10-28", name: "校内イベント 〜garticphone〜", star: false, note: "" },
        { date: "2026-10-31", name: "校内イベント 〜みんなのおすすめゲーム〜", star: false, note: "" },
        { date: "2026-10-31", name: "先生スナップショット①", star: false, note: "" },
        { date: "2026-11-07", name: "先生スナップショット②", star: false, note: "" },
        { date: "2026-11-08", name: "先生対抗戦", star: true, note: "" },
        { date: "2026-11-14", name: "校内チーム戦練習", star: false, note: "" },
        { date: "2026-11-15", name: "学校対抗戦", star: true, note: "" },
        { date: "2026-11-15", name: "校内後夜祭", star: false, note: "" }
      ],
      updatedAt: 0
    };
  }

  function normSchedule(raw) {
    raw = raw || {};
    const events = (Array.isArray(raw.events) ? raw.events : [])
      .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && String(e.name || "").trim())
      .map(e => ({
        date: String(e.date),
        name: String(e.name).trim(),
        star: !!e.star,
        note: String(e.note || "").trim()
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || (b.star - a.star));
    return {
      title: String(raw.title || "").trim() || "スケジュール表",
      notify: raw.notify !== false,
      events,
      updatedAt: raw.updatedAt || 0
    };
  }

  async function loadSchedule() {
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection("lboard_index").doc(SCHED_DOC).get();
        if (snap.exists) {
          const s = normSchedule(snap.data());
          if (s.events.length) return s;
        }
      } else {
        const raw = localStorage.getItem(SCHED_LS_KEY);
        if (raw) {
          const s = normSchedule(JSON.parse(raw));
          if (s.events.length) return s;
        }
      }
    } catch (e) { console.warn("予定表の読み込みに失敗", e); }
    // まだ保存されていない → 画像からおこした既定の予定表を出す
    const d = normSchedule(defaultSchedule());
    d.isDefault = true;
    return d;
  }

  async function saveSchedule(sch) {
    if (!isAdmin()) throw new Error("予定表の編集は管理者のみです");
    const s = normSchedule(sch);
    s.updatedAt = Date.now();
    const db = openDb();
    try {
      if (db) await db.collection("lboard_index").doc(SCHED_DOC).set(s);
      else localStorage.setItem(SCHED_LS_KEY, JSON.stringify(s));
    } catch (e) {
      throw new Error("予定表を保存できませんでした（" + (e.code || e.message) + "）");
    }
    return s;
  }

  /* ---- 日付まわり ---- */
  const WEEK_JA = ["日", "月", "火", "水", "木", "金", "土"];
  function weekdayOf(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();     // 0=日
  }
  function startOfWeek(key) { return shiftDay(key, -weekdayOf(key)); }
  function endOfWeek(key) { return shiftDay(key, 6 - weekdayOf(key)); }

  function eventsOn(sch, key) {
    return (sch.events || []).filter(e => e.date === key);
  }

  /* カレンダー（日〜土の7列）を組む。
     予定のある最初の日の週の日曜 〜 最後の日の週の土曜 までを並べる。
     期間の外側の日は inRange:false（画像と同じく薄く出す）。 */
  function scheduleWeeks(sch) {
    const ev = sch.events || [];
    if (!ev.length) return { weeks: [], first: "", last: "" };
    const first = ev[0].date, last = ev[ev.length - 1].date;
    const from = startOfWeek(first), to = endOfWeek(last);
    const weeks = [];
    let cur = from;
    let guard = 0;
    while (cur <= to && guard++ < 60) {
      const row = [];
      for (let i = 0; i < 7; i++) {
        const key = shiftDay(cur, i);
        row.push({
          date: key,
          day: Number(key.slice(8)),
          month: Number(key.slice(5, 7)),
          firstOfMonth: key.slice(8) === "01" || key === from,
          dow: i,
          inRange: (key >= first && key <= last),
          today: key === dayKey(),
          events: eventsOn(sch, key)
        });
      }
      weeks.push(row);
      cur = shiftDay(cur, 7);
    }
    return { weeks, first, last };
  }

  /* 今日以降の予定を近い順に（予定表の下に出す一覧用） */
  function upcomingEvents(sch, limit) {
    const today = dayKey();
    const out = (sch.events || []).filter(e => e.date >= today);
    return limit ? out.slice(0, limit) : out;
  }

  /* =============================================================
     先生スナップショット

     保存先: lboard_index/snapshot
       { enabled, label, roleIds:[対象ロール], topN, points:[4,3,2,1],
         dates:["2026-10-31","2026-11-07"], finalTitle:"代表先生", finalN:4,
         results: { "2026-10-31": { at, rows:[{id,name,tier,division,lp,abs,rank,point}] } },
         final: [...], finalAt, updatedAt }

     ・指定日の 23:45（LP一斉集計と同じタイミング）に Worker が実行する
     ・対象ロールを持つ人のうち、そのときのLPが高い順に topN 人へ points を配る
     ・最終日には、全回の合計ポイントの上位 finalN 人を「代表先生」として表彰する
     ============================================================= */
  const SNAP_DOC = "snapshot";
  const SNAP_LS_KEY = "mcc-lb2-snapshot";

  function defaultSnapshot() {
    return {
      enabled: true,
      label: "先生スナップショット",
      roleIds: [],                       // 先生ロール（管理コンソールで選ぶ）
      topN: 4,
      points: [4, 3, 2, 1],              // 1位から順に
      dates: ["2026-10-31", "2026-11-07"],
      finalTitle: "代表先生",
      finalN: 4,
      results: {},
      final: [],
      finalAt: 0,
      updatedAt: 0
    };
  }

  function normSnapshot(raw) {
    raw = raw || {};
    const dates = (Array.isArray(raw.dates) ? raw.dates : [])
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).map(String).sort();
    const points = (Array.isArray(raw.points) ? raw.points : [4, 3, 2, 1])
      .map(x => x | 0);
    const results = {};
    Object.entries(raw.results || {}).forEach(([d, v]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !v) return;
      results[d] = {
        at: v.at || 0,
        rows: (Array.isArray(v.rows) ? v.rows : []).map(r => ({
          id: String(r.id || ""), name: String(r.name || "—"),
          tier: String(r.tier || ""), division: String(r.division || ""),
          lp: r.lp | 0, abs: r.abs | 0, rank: r.rank | 0, point: r.point | 0
        }))
      };
    });
    return {
      enabled: raw.enabled !== false,
      label: String(raw.label || "").trim() || "先生スナップショット",
      roleIds: (Array.isArray(raw.roleIds) ? raw.roleIds : []).map(x => String(x).trim()).filter(Boolean),
      topN: Math.max(1, (raw.topN | 0) || 4),
      points: points.length ? points : [4, 3, 2, 1],
      dates,
      finalTitle: String(raw.finalTitle || "").trim() || "代表先生",
      finalN: Math.max(1, (raw.finalN | 0) || 4),
      results,
      final: Array.isArray(raw.final) ? raw.final : [],
      finalAt: raw.finalAt || 0,
      updatedAt: raw.updatedAt || 0
    };
  }

  async function loadSnapshot() {
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection("lboard_index").doc(SNAP_DOC).get();
        if (snap.exists) return normSnapshot(snap.data());
      } else {
        const raw = localStorage.getItem(SNAP_LS_KEY);
        if (raw) return normSnapshot(JSON.parse(raw));
      }
    } catch (e) { console.warn("スナップショット設定の読み込みに失敗", e); }
    const d = normSnapshot(defaultSnapshot());
    d.isDefault = true;
    return d;
  }

  async function saveSnapshot(cfg) {
    if (!isAdmin()) throw new Error("スナップショットの設定は管理者のみです");
    const s = normSnapshot(cfg);
    s.updatedAt = Date.now();
    const db = openDb();
    try {
      // results は Worker が書くので、設定だけを上書きする
      const patch = {
        enabled: s.enabled, label: s.label, roleIds: s.roleIds, topN: s.topN,
        points: s.points, dates: s.dates, finalTitle: s.finalTitle, finalN: s.finalN,
        updatedAt: s.updatedAt
      };
      if (db) await db.collection("lboard_index").doc(SNAP_DOC).set(patch, { merge: true });
      else {
        const cur = normSnapshot(JSON.parse(localStorage.getItem(SNAP_LS_KEY) || "{}"));
        localStorage.setItem(SNAP_LS_KEY, JSON.stringify(Object.assign(cur, patch)));
      }
    } catch (e) {
      throw new Error("設定を保存できませんでした（" + (e.code || e.message) + "）");
    }
    return s;
  }

  /* 全回の合計ポイント順。同点なら最後に測ったLPが高いほう → 名前順 */
  function snapshotStandings(snap) {
    const tally = {};
    Object.keys(snap.results || {}).sort().forEach(d => {
      (snap.results[d].rows || []).forEach(r => {
        const t = tally[r.id] || (tally[r.id] = { id: r.id, name: r.name, total: 0, per: {}, lastAbs: 0 });
        t.total += r.point | 0;
        t.per[d] = r.point | 0;
        t.name = r.name;
        t.lastAbs = r.abs | 0;
      });
    });
    return Object.values(tally).sort((a, b) =>
      (b.total - a.total) || (b.lastAbs - a.lastAbs) ||
      String(a.name).localeCompare(String(b.name), "ja"));
  }
  // 「第◯回」（実施日の並びの何番目か）
  function snapshotRound(snap, date) {
    const i = (snap.dates || []).indexOf(date);
    return i < 0 ? 0 : i + 1;
  }
  function snapshotDone(snap) {
    return (snap.dates || []).filter(d => (snap.results || {})[d]).length;
  }

  /* =============================================================
     全体メンバー名簿（lboard_index/members）

     ★ 大会ボードごとの名簿とは別に、「ログインした人」を1か所にためる。
        どのページでログインしても登録されるので、
        大会ボードを開いていない人も管理コンソールのメンバー一覧に並ぶ。
     ============================================================= */
  const MEMBERS_DOC = "members";
  const MEMBERS_LS_KEY = "mcc-lb2-members";

  function normMembers(raw) {
    const out = {};
    Object.entries((raw && raw.members) || {}).forEach(([id, m]) => {
      if (!id || !m) return;
      out[id] = {
        id: id,
        name: String(m.name || "—"),
        riotId: String(m.riotId || ""),
        puuid: String(m.puuid || ""),
        rank: (m.rank && m.rank.tier) ? { tier: String(m.rank.tier),
               division: String(m.rank.division || ""), lp: m.rank.lp | 0 } : null,
        discord: m.discord ? {
          id: String(m.discord.id || ""), name: String(m.discord.name || ""),
          username: String(m.discord.username || ""), avatar: String(m.discord.avatar || "")
        } : null,
        roles: rolesOf(m),
        staff: !!m.staff,
        nameLocked: !!m.nameLocked,
        optIn: !!m.optIn,
        joinedAt: m.joinedAt || 0,
        updatedAt: m.updatedAt || 0
      };
    });
    return out;
  }

  async function loadMembers() {
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection("lboard_index").doc(MEMBERS_DOC).get();
        if (snap.exists) return normMembers(snap.data());
      } else {
        const raw = localStorage.getItem(MEMBERS_LS_KEY);
        if (raw) return normMembers(JSON.parse(raw));
      }
    } catch (e) { console.warn("メンバー名簿の読み込みに失敗", e); }
    return {};
  }

  /* ログインした本人を名簿に登録する。1日1回でじゅうぶん。
     home-common.js の boot() から呼ばれるので、どのページを開いても登録される。 */
  async function registerMember(session, force) {
    session = session || Session.get();
    const p = Session.toPlayer(session);
    if (!p) return false;
    const flag = "mcc-lb2-member-done-" + p.id + "-" + dayKey();
    try { if (!force && localStorage.getItem(flag)) return false; } catch (e) { }

    const entry = {
      name: p.name, riotId: p.riotId || "", puuid: p.puuid || "",
      rank: p.rank || null, discord: p.discord || null,
      roles: rolesOf(p), staff: !!p.staff,
      joinedAt: Date.now(), updatedAt: Date.now()
    };
    const db = openDb();
    try {
      if (db) {
        // merge なので、管理者が付けた表示名・大会に参加 は消えない
        await db.collection("lboard_index").doc(MEMBERS_DOC)
          .set({ members: { [p.id]: entry }, updatedAt: Date.now() }, { merge: true });
      } else {
        const cur = { members: normMembers(JSON.parse(localStorage.getItem(MEMBERS_LS_KEY) || "{}")) };
        cur.members[p.id] = Object.assign({}, cur.members[p.id] || {}, entry, { id: p.id });
        localStorage.setItem(MEMBERS_LS_KEY, JSON.stringify(cur));
      }
    } catch (e) { console.warn("メンバー登録に失敗", e); return false; }
    try { localStorage.setItem(flag, "1"); } catch (e) { }
    return true;
  }

  async function updateGlobalMember(id, patch) {
    if (!isAdmin()) throw new Error("メンバーの編集は管理者のみです");
    if (!id) return;
    const body = Object.assign({}, patch, { updatedAt: Date.now() });
    const db = openDb();
    try {
      if (db) {
        await db.collection("lboard_index").doc(MEMBERS_DOC)
          .set({ members: { [id]: body }, updatedAt: Date.now() }, { merge: true });
      } else {
        const cur = { members: normMembers(JSON.parse(localStorage.getItem(MEMBERS_LS_KEY) || "{}")) };
        cur.members[id] = Object.assign({}, cur.members[id] || { id }, body);
        localStorage.setItem(MEMBERS_LS_KEY, JSON.stringify(cur));
      }
    } catch (e) { throw new Error("保存できませんでした（" + (e.code || e.message) + "）"); }
  }

  async function removeGlobalMember(id) {
    if (!isAdmin()) throw new Error("メンバーの削除は管理者のみです");
    if (!id) return;
    const db = openDb();
    try {
      if (db) {
        const ref = db.collection("lboard_index").doc(MEMBERS_DOC);
        const snap = await ref.get();
        const cur = snap.exists ? normMembers(snap.data()) : {};
        delete cur[id];
        await ref.set({ members: cur, updatedAt: Date.now() });
      } else {
        const cur = normMembers(JSON.parse(localStorage.getItem(MEMBERS_LS_KEY) || "{}"));
        delete cur[id];
        localStorage.setItem(MEMBERS_LS_KEY, JSON.stringify({ members: cur }));
      }
    } catch (e) { throw new Error("削除できませんでした（" + (e.code || e.message) + "）"); }
    // その人が「また開いたら復活」しないよう、登録済みフラグも消しておく
    try { localStorage.removeItem("mcc-lb2-member-done-" + id + "-" + dayKey()); } catch (e) { }
  }

  /* =============================================================
     メンバー紹介（プロフィール）

     保存先: Firestore の lboard_profiles コレクション
             1人 = 1ドキュメント（ドキュメントIDは "u_<DiscordのID>"）

     ★ なぜ1人1ドキュメントか
        画像を base64 で持つので、全員を1つのドキュメントに入れると
        Firestore の上限（1ドキュメント約1MB）をすぐ超えてしまうため。
        1人ずつ分けておけば、ほかの人の保存とぶつかることもない。

     ・自分のプロフィールは本人だけが編集できる（管理者は非表示にできる）
     ・画像は「アップロード（縮小してbase64）」と「URL貼り付け」の両対応
     ============================================================= */
  const PROFILE_COL = "lboard_profiles";
  const PROFILE_LS_KEY = "mcc-lb2-profiles";
  /* ★ 一覧用の「軽い版」を別に持つ理由
     プロフィール本体には画像（base64）が入るので、1人あたり数百KBになる。
     一覧を出すたびに全員ぶんを読むと何十MBにもなってしまうため、
     一覧に必要なぶん（名前・ひとこと・色・小さなサムネ）だけを
     lboard_index/profile_cards の1ドキュメントにまとめておく。
     くわしく見るときだけ、その人の本体を読みにいく。 */
  const PROFILE_CARDS_DOC = "profile_cards";
  const PROFILE_CARDS_LS_KEY = "mcc-lb2-profile-cards";

  // カードの色（本人が選ぶ）。ui.css のタイル色に合わせてある
  const PROFILE_THEMES = [
    { id: "gold",   name: "ゴールド", css: "var(--gold)" },
    { id: "sky",    name: "スカイ",   css: "var(--sky)" },
    { id: "leaf",   name: "リーフ",   css: "var(--leaf)" },
    { id: "mint",   name: "ミント",   css: "var(--mint)" },
    { id: "coral",  name: "コーラル", css: "var(--coral)" },
    { id: "navy",   name: "ネイビー", css: "var(--navy)" },
    { id: "grape",  name: "グレープ", css: "#8E6FD6" },
    { id: "rose",   name: "ローズ",   css: "#E06A9C" }
  ];
  // ヘッダー画像がないときの背景もよう
  const PROFILE_PATTERNS = [
    { id: "wave",   name: "なみ" },
    { id: "dots",   name: "みずたま" },
    { id: "grid",   name: "ほうがん" },
    { id: "rays",   name: "ひかり" },
    { id: "plain",  name: "むじ" }
  ];
  const PROFILE_MAX_FREE = 4;      // 自由項目の数（カテゴリごと）
  const PROFILE_MAX_GALLERY = 6;   // ギャラリーの枚数（カテゴリごと）
  // 1人ぶんの保存サイズの上限（Firestoreの1MBに対して余裕をみる）
  const PROFILE_MAX_BYTES = 820 * 1024;

  function strOf(v, max) { return String(v == null ? "" : v).slice(0, max || 400); }
  function listOf(v, max, len) {
    if (!Array.isArray(v)) return [];
    return v.map(x => strOf(x, len || 40)).map(s => s.trim()).filter(Boolean).slice(0, max || 12);
  }

  function defaultProfile(id) {
    return {
      id: id || "",
      theme: { color: "gold", pattern: "wave" },
      header: "",                      // ヘッダー画像（base64 か URL）
      thumb: "",                       // 一覧カード用の小さなヘッダー画像
      /* ===== 基本 =====
         【名前】    … Discordから読み取るので、ここには持たない
         【Riot ID】 … ログイン情報から読み取るので、ここには持たない */
      kana: "",              // 【ふりがな】必須
      nickname: "",          // 【呼び方・ニックネーム】必須

      /* ===== 私について ===== */
      hobbies: [],           // 【趣味】必須
      games: [],             // 【みんなで遊びたいゲーム】必須
      x: "",                 // X のURL（任意）
      noX: false,
      aboutFree: [],         // 自由に足せる項目 [{title, body}]
      aboutGallery: [],      // 画像 [{src, caption}]（1枚ずつコメントが付く）

      /* ===== TFT ===== */
      tactics: "",           // 【Tactics Tool】URL 必須
      noTactics: false,      //   持っていない場合
      goal: "",              // 【合宿での目標】必須
      spirit: "",            // 【意気込み】必須
      tftFree: [],           // 自由に足せる項目
      tftGallery: [],        // 画像

      /* ===== しめ ===== */
      message: "",           // 【みんなに一言】必須

      hidden: false,
      published: false,                // 一度でも保存したか
      updatedAt: 0
    };
  }

  function normProfile(raw, id) {
    const d = defaultProfile(id || (raw && raw.id) || "");
    if (!raw || typeof raw !== "object") return d;
    const th = raw.theme || {};
    d.theme.color = PROFILE_THEMES.some(t => t.id === th.color) ? th.color : "gold";
    d.theme.pattern = PROFILE_PATTERNS.some(p => p.id === th.pattern) ? th.pattern : "wave";
    d.header = strOf(raw.header, 1400000);
    d.thumb = strOf(raw.thumb, 90000);
    // 自由項目とギャラリーは、カテゴリごとに同じ形なのでまとめて整える
    const freeOf = v => (Array.isArray(v) ? v : [])
      .filter(f => f && (f.title || f.body))
      .map(f => ({ title: strOf(f.title, 30), body: strOf(f.body, 1200) }))
      .slice(0, PROFILE_MAX_FREE);
    const galOf = v => (Array.isArray(v) ? v : [])
      .filter(g => g && g.src)
      .map(g => ({ src: strOf(g.src, 1400000), caption: strOf(g.caption, 80) }))
      .slice(0, PROFILE_MAX_GALLERY);

    d.kana = strOf(raw.kana, 40);
    d.nickname = strOf(raw.nickname, 30);

    // 私について
    d.hobbies = listOf(raw.hobbies, 10, 30);
    if (!d.hobbies.length && raw.life) d.hobbies = listOf(raw.life.hobbies, 10, 30);  // 古い版から
    d.games = listOf(raw.games, 10, 30);
    d.x = safeUrl(raw.x);
    d.noX = !!raw.noX;
    d.aboutFree = freeOf(raw.aboutFree);
    d.aboutGallery = galOf(raw.aboutGallery);
    // 古い版は自由項目・ギャラリーが1つずつだったので「私について」に引きつぐ
    if (!d.aboutFree.length) d.aboutFree = freeOf(raw.free);
    if (!d.aboutGallery.length) d.aboutGallery = galOf(raw.gallery);

    // TFT
    d.tactics = safeUrl(raw.tactics);
    d.noTactics = !!raw.noTactics;
    d.goal = strOf(raw.goal, 120);
    d.spirit = strOf(raw.spirit, 300);
    d.tftFree = freeOf(raw.tftFree);
    d.tftGallery = galOf(raw.tftGallery);

    // しめ（古い版の「軽く自己紹介！」= intro を引きつぐ）
    d.message = strOf(raw.message, 1200) || strOf(raw.intro, 1200);

    // 任意
    d.hidden = !!raw.hidden;
    d.published = !!raw.published;
    d.updatedAt = raw.updatedAt || 0;
    return d;
  }

  // 危ないURL（javascript: など）を弾く。画像は data:image/… も通す
  function safeUrl(u) {
    const s = String(u || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s.slice(0, 600);
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s.slice(0, 1400000);
    return "";
  }
  // 画像として表示してよいか（<img src> に入れる直前の最終チェック）
  function safeImg(u) {
    const s = String(u || "").trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s;
    return "";
  }

  /* 必須項目。
     【名前】はDiscord、【Riot ID】はログイン情報から自動で入るので、
     ここに並ぶのは「本人が入力するぶん」だけ。 */
  const PROFILE_REQUIRED = [
    { cat: "base",  key: "kana",     label: "ふりがな" },
    { cat: "base",  key: "nickname", label: "呼び方・ニックネーム" },
    { cat: "about", key: "hobbies",  label: "趣味",                   list: true },
    { cat: "about", key: "games",    label: "みんなで遊びたいゲーム", list: true },
    { cat: "about", key: "x",        label: "X",            url: true, none: "noX" },
    { cat: "tft",   key: "tactics",  label: "Tactics Tool", url: true, none: "noTactics" },
    { cat: "tft",   key: "goal",     label: "合宿での目標" },
    { cat: "tft",   key: "spirit",   label: "意気込み" },
    { cat: "last",  key: "message",  label: "みんなに一言" }
  ];
  // カテゴリの見出し（画面の順番もこの順）
  const PROFILE_CATS = [
    { id: "about", name: "私について", icon: "🌱" },
    { id: "tft",   name: "TFT",        icon: "🏆" }
  ];
  /* Riot ID から Tactics Tool のURLを組み立てる。
     入力の手間をへらすため、編集画面の「Riot IDから作る」で使う。
     例: Mo10C#819 → https://tactics.tools/player/jp/Mo10C/819 */
  function tacticsUrlFor(riotId, region) {
    const s = String(riotId || "").trim();
    const i = s.lastIndexOf("#");
    if (i <= 0 || i === s.length - 1) return "";
    return "https://tactics.tools/player/" + (region || "jp") + "/" +
      encodeURIComponent(s.slice(0, i)) + "/" + encodeURIComponent(s.slice(i + 1));
  }

  // まだ埋まっていない必須項目の名前を返す（空なら全部そろっている）
  function missingRequired(p) {
    if (!p) return PROFILE_REQUIRED.map(f => f.label);
    return PROFILE_REQUIRED.filter(f => {
      if (f.none && p[f.none]) return false;          // 「持っていない」ならOK
      const v = p[f.key];
      return f.list ? !(Array.isArray(v) && v.length) : !String(v || "").trim();
    }).map(f => f.label);
  }

  // 保存したときのおよそのバイト数（容量メーターに使う）
  function profileBytes(p) {
    try { return new Blob([JSON.stringify(p)]).size; }
    catch (e) { return JSON.stringify(p).length; }
  }

  // 一覧カード1件ぶん（本体から作る。画像は小さなサムネだけ）
  function cardOf(p) {
    return {
      id: p.id,
      kana: p.kana,
      nickname: p.nickname,
      theme: { color: p.theme.color, pattern: p.theme.pattern },
      thumb: p.thumb || "",
      hobbies: p.hobbies.slice(0, 2),
      games: p.games.slice(0, 2),
      nTag: p.hobbies.length + p.games.length,
      nGallery: p.aboutGallery.length + p.tftGallery.length,
      score: profileScore(p),
      hidden: !!p.hidden,
      published: !!p.published,
      updatedAt: p.updatedAt || Date.now()
    };
  }
  function normCard(raw, id) {
    const c = cardOf(defaultProfile(id));
    if (!raw) return c;
    c.kana = strOf(raw.kana, 40);
    c.nickname = strOf(raw.nickname, 30);
    const th = raw.theme || {};
    c.theme.color = PROFILE_THEMES.some(t => t.id === th.color) ? th.color : "gold";
    c.theme.pattern = PROFILE_PATTERNS.some(p => p.id === th.pattern) ? th.pattern : "wave";
    c.thumb = strOf(raw.thumb, 90000);
    c.hobbies = listOf(raw.hobbies, 2, 30);
    c.games = listOf(raw.games, 2, 30);
    c.nTag = raw.nTag | 0;
    c.nGallery = raw.nGallery | 0;
    c.score = Math.max(0, Math.min(100, raw.score | 0));
    c.hidden = !!raw.hidden;
    c.published = !!raw.published;
    c.updatedAt = raw.updatedAt || 0;
    return c;
  }

  /* 一覧用（軽い）。メンバー紹介ページはこれだけ読む。 */
  async function loadProfileCards() {
    const out = {};
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection("lboard_index").doc(PROFILE_CARDS_DOC).get();
        const cards = (snap.exists && snap.data() && snap.data().cards) || {};
        Object.entries(cards).forEach(([id, v]) => { if (v) out[id] = normCard(v, id); });
      } else {
        const raw = JSON.parse(localStorage.getItem(PROFILE_CARDS_LS_KEY) || "{}");
        Object.entries(raw).forEach(([id, v]) => { out[id] = normCard(v, id); });
      }
    } catch (e) { console.warn("プロフィール一覧の読み込みに失敗", e); throw e; }
    return out;
  }

  // 一覧カードを1件だけ書きかえる
  async function writeCard(id, card) {
    const db = openDb();
    if (db) {
      await db.collection("lboard_index").doc(PROFILE_CARDS_DOC)
        .set({ cards: { [id]: card }, updatedAt: Date.now() }, { merge: true });
    } else {
      const raw = JSON.parse(localStorage.getItem(PROFILE_CARDS_LS_KEY) || "{}");
      raw[id] = card;
      localStorage.setItem(PROFILE_CARDS_LS_KEY, JSON.stringify(raw));
    }
  }
  async function removeCard(id) {
    const db = openDb();
    if (db) {
      const ref = db.collection("lboard_index").doc(PROFILE_CARDS_DOC);
      try {
        await ref.update({ ["cards." + id]: firebase.firestore.FieldValue.delete(), updatedAt: Date.now() });
      } catch (e) {
        // ドキュメントがまだ無い場合など。読み直して書きもどす。
        const snap = await ref.get();
        const cards = (snap.exists && snap.data() && snap.data().cards) || {};
        delete cards[id];
        await ref.set({ cards, updatedAt: Date.now() });
      }
    } else {
      const raw = JSON.parse(localStorage.getItem(PROFILE_CARDS_LS_KEY) || "{}");
      delete raw[id];
      localStorage.setItem(PROFILE_CARDS_LS_KEY, JSON.stringify(raw));
    }
  }

  /* 本体を全員ぶん読む（管理や書き出し用。ふだんの一覧では使わないこと） */
  async function loadProfiles() {
    const out = {};
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection(PROFILE_COL).get();
        snap.forEach(doc => { out[doc.id] = normProfile(doc.data(), doc.id); });
      } else {
        const raw = JSON.parse(localStorage.getItem(PROFILE_LS_KEY) || "{}");
        Object.entries(raw).forEach(([id, v]) => { out[id] = normProfile(v, id); });
      }
    } catch (e) { console.warn("プロフィールの読み込みに失敗", e); throw e; }
    return out;
  }

  async function loadProfile(id) {
    if (!id) return defaultProfile("");
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection(PROFILE_COL).doc(id).get();
        return normProfile(snap.exists ? snap.data() : null, id);
      }
      const raw = JSON.parse(localStorage.getItem(PROFILE_LS_KEY) || "{}");
      return normProfile(raw[id] || null, id);
    } catch (e) { console.warn("プロフィールの読み込みに失敗", e); return defaultProfile(id); }
  }

  /* 自分のプロフィールを保存する。
     ★ 本人だけ。ほかの人のIDを指定しても弾く（管理者も中身は書き換えない）。 */
  async function saveProfile(id, data, session) {
    const p = Session.toPlayer(session || Session.get());
    if (!p) throw new Error("ログインしてください");
    if (id && id !== p.id) throw new Error("ほかの人のプロフィールは編集できません");
    const body = normProfile(data, p.id);
    body.id = p.id;
    body.published = true;
    body.updatedAt = Date.now();
    const miss = missingRequired(body);
    if (miss.length) {
      throw new Error("まだ入っていない必須項目があります: " + miss.join(" / "));
    }
    const size = profileBytes(body);
    if (size > PROFILE_MAX_BYTES) {
      throw new Error("画像が大きすぎます（" + Math.round(size / 1024) + "KB / 上限 " +
        Math.round(PROFILE_MAX_BYTES / 1024) + "KB）。枚数を減らすか、URL貼り付けに切り替えてください");
    }
    const db = openDb();
    try {
      if (db) await db.collection(PROFILE_COL).doc(p.id).set(body);
      else {
        const raw = JSON.parse(localStorage.getItem(PROFILE_LS_KEY) || "{}");
        raw[p.id] = body;
        localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(raw));
      }
      await writeCard(p.id, cardOf(body));   // 一覧用の軽い版も同時に更新
    } catch (e) { throw new Error("保存できませんでした（" + (e.code || e.message) + "）"); }
    return body;
  }

  /* 管理者だけ: 不適切なプロフィールを一覧から隠す（中身は消さない） */
  async function setProfileHidden(id, hidden) {
    if (!isAdmin()) throw new Error("非表示にできるのは管理者だけです");
    if (!id) return;
    const db = openDb();
    try {
      if (db) await db.collection(PROFILE_COL).doc(id).set({ hidden: !!hidden, updatedAt: Date.now() }, { merge: true });
      else {
        const raw = JSON.parse(localStorage.getItem(PROFILE_LS_KEY) || "{}");
        raw[id] = Object.assign({}, raw[id] || { id }, { hidden: !!hidden, updatedAt: Date.now() });
        localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(raw));
      }
      // 一覧のほうにも反映する
      const cards = await loadProfileCards();
      const c = cards[id] || normCard(null, id);
      c.hidden = !!hidden;
      await writeCard(id, c);
    } catch (e) { throw new Error("変更できませんでした（" + (e.code || e.message) + "）"); }
  }

  // 自分のプロフィールを消す（本人 or 管理者）
  async function deleteProfile(id) {
    const p = Session.toPlayer(Session.get());
    const mine = p && id === p.id;
    if (!mine && !isAdmin()) throw new Error("消せるのは本人と管理者だけです");
    const db = openDb();
    try {
      if (db) await db.collection(PROFILE_COL).doc(id).delete();
      else {
        const raw = JSON.parse(localStorage.getItem(PROFILE_LS_KEY) || "{}");
        delete raw[id];
        localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(raw));
      }
      await removeCard(id);
    } catch (e) { throw new Error("削除できませんでした（" + (e.code || e.message) + "）"); }
  }

  function profileThemeCss(p) {
    const t = PROFILE_THEMES.find(x => x.id === ((p && p.theme && p.theme.color) || "gold"));
    return (t || PROFILE_THEMES[0]).css;
  }
  // プロフィールが「ちゃんと書かれているか」を0〜100で返す（書くはげみ用）
  function profileScore(p) {
    if (!p) return 0;
    // 必須がぜんぶ埋まって 80%、任意（ひとこと・ヘッダー・自由欄・ギャラリー）で 100%
    const need = PROFILE_REQUIRED.length;
    const done = need - missingRequired(p).length;
    const extra = [!!p.header,
      p.aboutFree.length > 0 || p.tftFree.length > 0,
      p.aboutGallery.length > 0 || p.tftGallery.length > 0];
    return Math.round(done / need * 80 + extra.filter(Boolean).length / extra.length * 20);
  }

  /* =============================================================
     VC稼働時間（vc.html で使う）

     記録しているのは Discord Bot（vc-tracker.js）。
     Bot が Firestore の lboard_index/vc_YYYY-MM に
       days: { "2026-09-20": { <VCのID>: { n:VC名, up:稼働秒, sec:延べ秒, u:{ <ユーザーID>:秒 } } } }
       names: { <ユーザーID>: 表示名 }
     の形で日ごとに書き込み、ここではそれを読んで期間ぶん足すだけ。

     ・up（稼働時間）= そのVCに誰か1人でもいた実時間（重なりは1回と数える）
     ・sec（延べ滞在）= 全員の滞在時間の合計
     ・日をまたぐ滞在は Bot 側で 0:00(JST) で切ってあるので、単純に足せる
     ============================================================= */
  const VC_META_DOC = "vc";

  function vcMonthsBetween(fromKey, toKey) {
    const out = [];
    let y = Number(fromKey.slice(0, 4)), m = Number(fromKey.slice(5, 7));
    const ey = Number(toKey.slice(0, 4)), em = Number(toKey.slice(5, 7));
    while (y < ey || (y === ey && m <= em)) {
      out.push(y + "-" + String(m).padStart(2, "0"));
      m++; if (m > 12) { m = 1; y++; }
      if (out.length > 120) break;   // 念のための上限（10年）
    }
    return out;
  }

  // 記録開始日など
  async function loadVcMeta() {
    const db = openDb();
    if (!db) return { startedAt: 0 };
    try {
      const snap = await db.collection("lboard_index").doc(VC_META_DOC).get();
      return snap.exists ? (snap.data() || {}) : { startedAt: 0 };
    } catch (e) { console.warn("VCの控えを読めませんでした", e); return { startedAt: 0 }; }
  }

  /* 期間（YYYY-MM-DD 〜 YYYY-MM-DD、両端を含む）の集計を返す */
  async function loadVcRange(fromKey, toKey) {
    const db = openDb();
    const empty = { from: fromKey, to: toKey, channels: [], users: [], daily: [],
                    totals: { uptime: 0, seconds: 0, users: 0, channels: 0, days: 0 } };
    if (!db) return empty;

    const months = vcMonthsBetween(fromKey, toKey);
    const docs = await Promise.all(months.map(m =>
      db.collection("lboard_index").doc("vc_" + m).get()
        .then(s => (s.exists ? s.data() : null))
        .catch(() => null)));

    const chan = new Map();   // VCごと
    const user = new Map();   // ユーザーごと
    const daily = [];
    let names = {};

    docs.forEach(d => {
      if (!d) return;
      names = Object.assign(names, d.names || {});
      Object.entries(d.days || {}).forEach(([day, chs]) => {
        if (day < fromKey || day > toKey) return;
        let dayUp = 0, daySec = 0;
        Object.entries(chs || {}).forEach(([cid, c]) => {
          const up = Number(c.up) || 0, sec = Number(c.sec) || 0;
          dayUp += up; daySec += sec;
          if (!chan.has(cid)) chan.set(cid, { id: cid, name: c.n || cid, uptime: 0, seconds: 0, perUser: {} });
          const ch = chan.get(cid);
          if (c.n) ch.name = c.n;          // 名前が変わっていたら新しいほうを使う
          ch.uptime += up;
          ch.seconds += sec;
          Object.entries(c.u || {}).forEach(([uid, s]) => {
            const v = Number(s) || 0;
            ch.perUser[uid] = (ch.perUser[uid] || 0) + v;
            if (!user.has(uid)) user.set(uid, { id: uid, name: uid, seconds: 0, byChannel: {} });
            const us = user.get(uid);
            us.seconds += v;
            us.byChannel[cid] = (us.byChannel[cid] || 0) + v;
          });
        });
        daily.push({ day: day, uptime: dayUp, seconds: daySec });
      });
    });

    const chName = id => (chan.get(id) ? chan.get(id).name : id);
    const channels = [...chan.values()].map(c => {
      let top = null;
      Object.entries(c.perUser).forEach(([uid, s]) => {
        if (!top || s > top.seconds) top = { id: uid, name: names[uid] || uid, seconds: s };
      });
      return { id: c.id, name: c.name, uptime: c.uptime, seconds: c.seconds,
               users: Object.keys(c.perUser).length, top: top };
    }).sort((a, b) => b.uptime - a.uptime);

    const users = [...user.values()].map(u => ({
      id: u.id,
      name: names[u.id] || u.id,
      seconds: u.seconds,
      byChannel: Object.entries(u.byChannel)
        .map(([cid, s]) => ({ id: cid, name: chName(cid), seconds: s }))
        .sort((a, b) => b.seconds - a.seconds)
    })).sort((a, b) => b.seconds - a.seconds);

    daily.sort((a, b) => a.day < b.day ? -1 : 1);

    return {
      from: fromKey, to: toKey, channels, users, daily,
      totals: {
        uptime: channels.reduce((n, c) => n + c.uptime, 0),
        seconds: users.reduce((n, u) => n + u.seconds, 0),
        users: users.length,
        channels: channels.length,
        days: daily.length
      }
    };
  }
  // 「◯時間◯分」の表示に使う
  function vcHm(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
    if (h) return h + "時間" + (m ? String(m).padStart(2, "0") + "分" : "");
    if (m) return m + "分";
    return sec + "秒";
  }

  /* =============================================================
     Discord へ投げるメッセージの文面

     保存先: lboard_index/messages
       { promote:{head,line,foot}, schedule:{...}, snapshot:{...}, final:{...} }

     組み立て方はどれも同じ:
        head
        line × 件数
        （空行）foot
     head / foot は空にすればその行ごと出ません。

     {◯◯} は差し込み。使える名前は MSG_VARS を見てください。
     Worker 側にも同じ差し込み処理が入っています（fillW）。
     ★ 新しくDiscordへ投げるものを作るときは、必ずここに文面を足して
        管理コンソールから編集できるようにすること。
     ============================================================= */
  const MSG_KEYS = ["promote", "schedule", "snapshot", "final"];

  const MSG_META = {
    promote: {
      name: "ランクアップのお祝い",
      where: "連絡事項",
      when: "毎日23:45の集計でティアが上がった人がいたとき",
      vars: {
        head: [["count", "人数"]],
        line: [["emoji", "新ティアの絵文字"], ["name", "名前"], ["from", "前のティア"],
               ["to", "新しいティア"], ["rankLabel", "🛡 MASTER 135LP"],
               ["division", "ディビジョン"], ["lp", "LP"]],
        foot: [["count", "人数"]]
      }
    },
    schedule: {
      name: "きょうの予定",
      where: "連絡事項",
      when: "毎朝9:00（予定がある日だけ）",
      vars: {
        head: [["md", "10/25"], ["wd", "曜日"], ["date", "2026-10-25"],
               ["title", "予定表のタイトル"], ["count", "件数"]],
        line: [["mark", "⭐ または ・"], ["name", "予定の名前"], ["note", "メモ（あれば頭に空白つき）"]],
        foot: [["count", "件数"]]
      }
    },
    snapshot: {
      name: "先生スナップショットの結果",
      where: "連絡事項",
      when: "実施日の23:45",
      vars: {
        head: [["label", "呼び名"], ["maru", "①②…"], ["round", "回数"],
               ["md", "10/31"], ["date", "2026-10-31"],
               ["time", "実行した時刻 23:45"]],
        line: [["medal", "🥇🥈🥉"], ["rank", "順位"], ["name", "名前"],
               ["rankLabel", "🛡 MASTER 120LP（アイコンつき）"], ["point", "ポイント"]],
        foot: [["label", "呼び名"], ["maru", "①②…"]]
      }
    },
    final: {
      name: "代表先生の表彰",
      where: "連絡事項",
      when: "最終回の23:45（結果のすぐあと）",
      vars: {
        head: [["title", "表彰の名前"], ["label", "呼び名"], ["rounds", "全体の回数"], ["n", "選ばれる人数"],
               ["md", "10/31"], ["time", "実行した時刻 23:45"]],
        line: [["medal", "🥇🥈🥉"], ["rank", "順位"], ["name", "名前"],
               ["total", "合計ポイント"], ["detail", "（①4pt + ②3pt）"]],
        foot: [["title", "表彰の名前"], ["n", "人数"]]
      }
    }
  };

  function defaultMessages() {
    return {
      promote: {
        head: "🎊 **ランクアップのお知らせ** 🎊",
        line: "{emoji} **{name}** さんが **{to}** に昇格しました！（{from} → {to}）",
        foot: "おめでとうございます！"
      },
      schedule: {
        head: "🗓 **きょう {md}（{wd}）の予定**　― {title}",
        line: "{mark} **{name}**{note}",
        foot: "みなさん参加おまちしています！"
      },
      snapshot: {
        head: "📸 **{label}{maru}**　{md} {time} 時点",
        line: "{medal} **{rank}位　{name}**　{rankLabel}　**+{point}pt**",
        foot: "おつかれさまでした！"
      },
      final: {
        head: "🏆 **{title} 決定！** 🏆\n{rounds}回の{label}の合計ポイントで、{title}{n}名が決まりました。",
        line: "{medal} **{name}**　**{total}pt**{detail}",
        foot: "おめでとうございます！ 代表としてよろしくお願いします 🎉"
      },
      updatedAt: 0
    };
  }

  function normMessages(raw) {
    raw = raw || {};
    const d = defaultMessages();
    /* ★ 投稿先は「連絡事項」の1つだけ。談話室への投稿は廃止しました。
       古い設定に channels.○○ = "chat" が残っていても、すべて連絡事項に揃えます。 */
    const out = { updatedAt: raw.updatedAt || 0, channels: {} };
    MSG_KEYS.forEach(k => {
      const a = raw[k] || {};
      out[k] = {
        head: typeof a.head === "string" ? a.head : d[k].head,
        line: (typeof a.line === "string" && a.line.trim()) ? a.line : d[k].line,
        foot: typeof a.foot === "string" ? a.foot : d[k].foot
      };
      out.channels[k] = "notice";
    });
    return out;
  }
  /* 投稿先は連絡事項のみ（管理画面の表示用） */
  const MSG_CHANNELS = [
    { id: "notice", name: "連絡事項", note: "DISCORD_SCHEDULE_CHANNEL_ID" }
  ];
  function channelName() { return "連絡事項"; }

  async function loadMessages() {
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection("lboard_index").doc("messages").get();
        if (snap.exists) return normMessages(snap.data());
      } else {
        const raw = localStorage.getItem("mcc-lb2-messages");
        if (raw) return normMessages(JSON.parse(raw));
      }
    } catch (e) { console.warn("メッセージ文面の読み込みに失敗", e); }
    const d = normMessages(defaultMessages());
    d.isDefault = true;
    return d;
  }

  async function saveMessages(msgs) {
    if (!isAdmin()) throw new Error("文面の編集は管理者のみです");
    const m = normMessages(msgs);
    m.updatedAt = Date.now();
    const db = openDb();
    try {
      if (db) await db.collection("lboard_index").doc("messages").set(m);
      else localStorage.setItem("mcc-lb2-messages", JSON.stringify(m));
    } catch (e) {
      throw new Error("文面を保存できませんでした（" + (e.code || e.message) + "）");
    }
    return m;
  }

  /* {name} を差し替える。Worker 側の fillW と同じ動き。 */
  function fillTemplate(tpl, vars) {
    return String(tpl == null ? "" : tpl).replace(/\{(\w+)\}/g, (m, k) =>
      (vars && vars[k] != null) ? String(vars[k]) : "");
  }
  /* head + 明細 + foot を1通にまとめる */
  function buildMessage(tpl, headVars, rows) {
    const head = fillTemplate(tpl.head, headVars).trim();
    const body = (rows || []).map(v => fillTemplate(tpl.line, v)).join("\n");
    const foot = fillTemplate(tpl.foot, headVars).trim();
    let out = "";
    if (head) out += head + "\n";
    out += body;
    if (foot) out += "\n\n" + foot;
    return out.trim();
  }

  /* 管理画面のプレビュー用のサンプル */
  function sampleMessageVars(key) {
    if (key === "promote") return {
      head: { count: 2 },
      rows: [
        { emoji: "💠", name: "もと先生", from: "EMERALD", to: "DIAMOND", division: "IV", lp: 12,
          rankLabel: "DIAMOND IV 12LP" },
        { emoji: "👑", name: "すいちゃん", from: "DIAMOND", to: "MASTER", division: "", lp: 5,
          rankLabel: "MASTER 5LP" }
      ]
    };
    if (key === "schedule") return {
      head: { md: "10/25", wd: "日", date: "2026-10-25", title: "クラウドハッシュテイル校　スケジュール表", count: 2 },
      rows: [
        { mark: "⭐", name: "開校式", note: "　21:00集合" },
        { mark: "・", name: "校内イベント 〜謎解き〜", note: "" }
      ]
    };
    if (key === "snapshot") return {
      head: { label: "先生スナップショット", maru: "①", round: 1, md: "10/31", date: "2026-10-31", time: "23:45" },
      rows: [
        { medal: "🥇", rank: 1, name: "あ先生", rankLabel: "MASTER 120LP", point: 4 },
        { medal: "🥈", rank: 2, name: "い先生", rankLabel: "DIAMOND I 40LP", point: 3 },
        { medal: "🥉", rank: 3, name: "う先生", rankLabel: "DIAMOND III 10LP", point: 2 },
        { medal: "4️⃣", rank: 4, name: "え先生", rankLabel: "EMERALD I 80LP", point: 1 }
      ]
    };
    return {
      head: { title: "代表先生", label: "先生スナップショット", rounds: 2, n: 4, md: "10/31", time: "23:45" },
      rows: [
        { medal: "🥇", rank: 1, name: "い先生", total: 7, detail: "（①3pt + ②4pt）" },
        { medal: "🥈", rank: 2, name: "あ先生", total: 7, detail: "（①4pt + ②3pt）" },
        { medal: "🥉", rank: 3, name: "う先生", total: 3, detail: "（①2pt + ②1pt）" },
        { medal: "4️⃣", rank: 4, name: "お先生", total: 2, detail: "（②2pt）" }
      ]
    };
  }

  /* =============================================================
     集計・ヘルパー
     ============================================================= */
  function playerById(state, id) { return state.roster.find(p => p.id === id) || null; }
  function nameOf(state, id) { const p = playerById(state, id); return p ? p.name : "—"; }
  function avatarOf(state, id) { const p = playerById(state, id); return (p && p.discord && p.discord.avatar) || ""; }
  function hasRole(p, roleId) { return !!(p && Array.isArray(p.roles) && p.roles.some(r => r && r.id === roleId)); }

  // ボード上の全ロール一覧（pinnedOrder → position順）
  function rosterRoles(state) {
    const map = new Map();
    participants(state).forEach(p => (p.roles || []).forEach(r => {
      if (r && r.id && !map.has(r.id)) map.set(r.id, { id: r.id, name: r.name || r.id, color: r.color || 0, count: 0 });
    }));
    participants(state).forEach(p => (p.roles || []).forEach(r => {
      if (r && r.id && map.has(r.id)) map.get(r.id).count++;
    }));
    const pinned = ((CFG.roles || {}).pinnedOrder) || [];
    return [...map.values()].sort((a, b) => {
      const pa = pinned.indexOf(a.id), pb = pinned.indexOf(b.id);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
      return a.name.localeCompare(b.name, "ja");
    });
  }
  /* Worker からロール一覧が取れないときの代替カタログ。
     ログイン中の本人が持つロール（名前つき）＋ すでに選択済みのID ＋ roster にいる人のロール
     を寄せ集める。Bot 未設定でも公開範囲の設定だけは進められるようにするための逃げ道。 */
  function fallbackRoleCatalog(session, extraIds, state) {
    const map = new Map();
    const put = r => {
      if (!r || !r.id) return;
      const id = String(r.id);
      const prev = map.get(id);
      // 名前が分かっているものを優先して残す
      if (!prev || (prev.name === id && r.name)) {
        map.set(id, { id, name: r.name || id, color: r.color || 0 });
      }
    };
    const s = session || Session.get();
    ((s && s.discord && s.discord.roles) || []).forEach(put);
    if (state && Array.isArray(state.roster)) {
      state.roster.forEach(p => (p.roles || []).forEach(put));
    }
    (extraIds || []).forEach(id => put({ id: String(id), name: null, color: 0 }));
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }

  function roleColorCss(color) {
    if (!color) return "var(--muted)";
    return "#" + Number(color).toString(16).padStart(6, "0");
  }

  function isPresent(state, matchIdx, pid) {
    const p = playerById(state, pid);
    if (!isParticipant(p)) return false;          // 運営ロールの人は参加扱いにしない
    const mt = state.matches[matchIdx];
    if (!mt) return true;
    const uid = isDouble(state) ? (teamOfPlayer(state, pid) || {}).id : pid;
    if (!uid) return false;                       // ダブルアップでペアが未設定
    return !Array.isArray(mt.present) ? true : mt.present.includes(uid);
  }
  // この試合に出る選手のID（ダブルアップでは参加チームの2人ぶん）
  function presentList(state, matchIdx) {
    const mt = state.matches[matchIdx];
    if (!mt) return [];
    if (isDouble(state)) {
      const ids = presentUnits(state, matchIdx);
      const out = [];
      ids.forEach(uid => teamMembers(state, uid).forEach(p => out.push(p.id)));
      return out;
    }
    const pool = participants(state);
    const set = new Set(!Array.isArray(mt.present) ? pool.map(p => p.id) : mt.present);
    return pool.filter(p => set.has(p.id)).map(p => p.id);
  }
  /* ★ この試合に出るユニットのID（ソロ=選手ID / ダブルアップ=チームID）。
     席に並べるのはこちら。 */
  function presentUnits(state, matchIdx) {
    const mt = state.matches[matchIdx];
    if (!mt) return [];
    const pool = unitsOf(state);
    const set = new Set(!Array.isArray(mt.present) ? pool : mt.present);
    return pool.filter(id => set.has(id));
  }

  /* 卓の順位。pid はユニットID（ソロ=選手 / ダブルアップ=チーム）。
     ダブルアップのときは members に2人ぶんの選手が入ります。 */
  function tableStandings(state, matchIdx, tableIdx) {
    const tb = state.matches[matchIdx].tables[tableIdx];
    const rows = [];
    tb.seats.forEach(uid => {
      if (!uid) return;
      const rank = tb.placements[uid] || null;
      rows.push({
        pid: uid, id: uid,
        name: unitName(state, uid),
        members: isDouble(state) ? teamMembers(state, uid) : [],
        rank, points: pointsFor(state.mode, rank)
      });
    });
    rows.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    return { mode: state.mode, rows };
  }

  /* 全体順位。ダブルアップでは「チームの累計pt」になります
     （ポイントは人ではなくチームに付く、という決めごとのため）。 */
  function overallStandings(state) {
    const totals = {};
    const dbl = isDouble(state);
    unitsOf(state).forEach(uid => {
      totals[uid] = {
        pid: uid, id: uid, name: unitName(state, uid),
        members: dbl ? teamMembers(state, uid) : [],
        points: 0, games: 0
      };
    });
    state.matches.forEach(mt => mt.tables.forEach(tb => {
      tb.seats.forEach(uid => {
        if (!uid || !totals[uid]) return;
        const rank = tb.placements[uid];
        if (rank) { totals[uid].points += pointsFor(state.mode, rank); totals[uid].games += 1; }
      });
    }));
    const rows = Object.values(totals).filter(r => r.games > 0 || r.points > 0);
    const list = rows.length ? rows : Object.values(totals);
    list.sort((a, b) => b.points - a.points || b.games - a.games || a.name.localeCompare(b.name, "ja"));
    return list;
  }

  /* =============================================================
     Riot / Discord API（Worker 経由）
     ============================================================= */
  async function workerGet(path, params) {
    const cfg = effCfg();
    if (!cfg.workerUrl) throw new Error("Worker URL が未設定です（config.js または管理コンソール）");
    const u = new URL(cfg.workerUrl.replace(/\/$/, "") + path);
    Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u.toString());
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("API " + res.status + " " + t.slice(0, 160));
    }
    return res.json();
  }

  const Riot = {
    enabled() { return !!effCfg().workerUrl; },

    parseRiotId(riotId) {
      const m = (riotId || "").split("#");
      if (m.length !== 2 || !m[0].trim() || !m[1].trim()) throw new Error("Riot IDは Name#TAG 形式で入力してください");
      return { gameName: m[0].trim(), tagLine: m[1].trim() };
    },
    async account(gameName, tagLine) {
      return workerGet("/account", { gameName, tagLine, region: effCfg().region });
    },
    // TFTランク（RANKED_TFTを優先。無ければ他キューか null）
    async rank(puuid) {
      const entries = await workerGet("/rank", { puuid, platform: effCfg().platform });
      if (!Array.isArray(entries) || !entries.length) return null;
      const pickQ = q => entries.find(e => e.queueType === q);
      const e = pickQ("RANKED_TFT") || pickQ("RANKED_TFT_DOUBLE_UP") || entries[0];
      if (!e) return null;
      return {
        queue: e.queueType || "",
        tier: e.tier || (e.ratedTier ? "RATED" : ""),   // ハイパーロール等はratedTier
        division: e.rank || "",
        lp: e.leaguePoints != null ? e.leaguePoints : (e.ratedRating != null ? e.ratedRating : 0),
        wins: e.wins || 0, losses: e.losses || 0
      };
    },
    // Riot ID → { gameName, tagLine, puuid, rank }
    async lookup(riotId) {
      const { gameName, tagLine } = this.parseRiotId(riotId);
      const acc = await this.account(gameName, tagLine);
      let rank = null;
      try { rank = await this.rank(acc.puuid); } catch (e) { console.warn("rank fetch failed", e); }
      return { gameName: acc.gameName || gameName, tagLine: acc.tagLine || tagLine, puuid: acc.puuid, rank };
    },
    async recentMatches(puuid, count) {
      return workerGet("/matches", { puuid, count: count || 20, region: effCfg().region });
    },
    async match(matchId) {
      return workerGet("/match", { matchId, region: effCfg().region });
    },

    /* 卓のメンバーを含む直近マッチを探して順位を返す。
       ★ 8人が全員このコミュニティの人とは限らないので、「全員揃ったマッチ」ではなく
         「最も多く一致したマッチ」を採用する。最低 min 人（既定2人）一致すればよい。

       players: [{pid, puuid}]（puuid未登録の人は最初から除外）
       opts: { min: 最低一致人数, count: 1人あたり見る試合数, budget: 詳細取得の上限 }
       戻り値: { matchId, placements:{pid:rank}, matched, total, missingPids } or null */
    /* 卓の順位を Riot の履歴から拾う。

       players = [{ pid, puuid }]                     … 個人戦
                 [{ pid, puuids:[puuid, puuid] }]     … ダブルアップ（pid はチームID）

       opts.mode === "doubleup" のときは、
         ・ダブルアップの試合（tft_game_type === "pairs"）だけを見る
         ・順位が 1〜8 で返ってきたら 1〜4 に直す（ceil(placement/2)）
         ・partner_group_id があれば、2人が同じ組かどうかも確かめる
       ※ Riot 側が 1〜4 と 1〜8 のどちらで返すかは試合によって変わりうるので、
         その場の最大値を見て決めています。 */
    async autoDetectTable(players, onProgress, opts) {
      opts = opts || {};
      const dbl = opts.mode === "doubleup";
      const min = Math.max(2, opts.min || 2);
      const count = opts.count || 20;
      const budget = opts.budget || 30;      // マッチ詳細の取得回数上限（レート制限対策）

      // 1件につき puuid が1個（個人戦）か2個（ダブルアップ）
      const puOf = p => (Array.isArray(p.puuids) && p.puuids.length)
        ? p.puuids.filter(Boolean)
        : (p.puuid ? [p.puuid] : []);

      const valid = players.filter(p => puOf(p).length);
      if (valid.length < min) {
        throw new Error(dbl
          ? ("ログイン済み（puuid登録済み）のチームが" + min + "組以上必要です。現在" + valid.length + "組")
          : ("ログイン済み（puuid登録済み）の選手が" + min + "人以上必要です。現在" + valid.length + "人"));
      }

      // 履歴を見る起点。先頭が未プレイでも拾えるよう複数人ぶん辿る
      const bases = [];
      valid.forEach(p => puOf(p).forEach(u => {
        if (bases.length < 3) bases.push({ pid: p.pid, puuid: u });
      }));
      const seen = new Set();
      let fetched = 0;
      let best = null;

      const isPairs = detail => {
        const info = detail.info || {};
        const q = String(info.queue_id == null ? "" : info.queue_id);
        return info.tft_game_type === "pairs" || q === "1150" || q === "1160";
      };

      for (const base of bases) {
        let ids = [];
        onProgress && onProgress(base.pid + " の履歴を取得中…");
        try { ids = await Riot.recentMatches(base.puuid, count); } catch (e) { continue; }

        for (const matchId of ids) {
          if (seen.has(matchId)) continue;
          seen.add(matchId);
          if (fetched >= budget) break;
          fetched++;
          onProgress && onProgress("照合中 " + fetched + "件目…");

          let detail;
          try { detail = await Riot.match(matchId); } catch (e) { continue; }
          // ダブルアップのときは、ダブルアップの試合だけを見る
          if (dbl && !isPairs(detail)) continue;
          const parts = (detail.info && detail.info.participants) || [];
          const partPuuids = new Set(parts.map(x => x.puuid));
          const hit = valid.filter(p => puOf(p).some(u => partPuuids.has(u)));
          if (hit.length < min) continue;

          const when = (detail.info && detail.info.game_datetime) || 0;
          if (!best || hit.length > best.hit.length || (hit.length === best.hit.length && when > best.when)) {
            best = { matchId, hit, parts, when, pairs: isPairs(detail) };
          }
          if (best.hit.length === valid.length) break;   // 全員揃ったら即決
        }
        if (best && best.hit.length === valid.length) break;
        if (fetched >= budget) break;
      }

      if (!best) return null;

      // ダブルアップ：1〜8で返ってきていたら1〜4に直す
      let scale = 1;
      if (dbl) {
        const mx = best.parts.reduce((a, x) => Math.max(a, x.placement | 0), 0);
        if (mx > 4) scale = 2;
      }
      const placements = {};
      const splitTeams = [];          // 2人が別チーム扱いになっていた（＝ペアが違う）
      best.hit.forEach(p => {
        const mine = best.parts.filter(x => puOf(p).includes(x.puuid));
        if (!mine.length) return;
        const raw = mine[0].placement | 0;
        placements[p.pid] = (scale === 2) ? Math.max(1, Math.ceil(raw / 2)) : raw;
        // partner_group_id が取れていて、2人の組が違うなら教える
        if (dbl && mine.length === 2) {
          const g0 = mine[0].partner_group_id, g1 = mine[1].partner_group_id;
          if (g0 != null && g1 != null && g0 !== g1) splitTeams.push(p.pid);
        }
      });
      const hitPids = new Set(best.hit.map(p => p.pid));
      return {
        matchId: best.matchId,
        placements,
        matched: best.hit.length,
        total: valid.length,
        missingPids: valid.filter(p => !hitPids.has(p.pid)).map(p => p.pid),
        // ダブルアップのときの追加情報
        doubleup: !!dbl,
        pairsMatch: !!best.pairs,
        scaled: scale === 2,          // 1〜8 → 1〜4 に直した
        splitTeams: splitTeams
      };
    }
  };

  const DiscordAuth = {
    enabled() { return !!effCfg().workerUrl; },
    // Discordログインへ移動（戻り先=現在のページ）
    login(returnUrl) {
      const cfg = effCfg();
      if (!cfg.workerUrl) throw new Error("Worker URL が未設定です（config.js）");
      const ret = returnUrl || (location.origin + location.pathname + location.search);
      location.href = cfg.workerUrl.replace(/\/$/, "") + "/auth/login?return=" + encodeURIComponent(ret);
    },
    // URLフラグメント #dc=... を読んで結果を返す（読んだら消す）
    consumeCallback() {
      const m = (location.hash || "").match(/#dc=([^&]+)/);
      if (!m) return null;
      history.replaceState(null, "", location.pathname + location.search);
      try {
        const s = m[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = s + "===".slice((s.length + 3) % 4);
        return JSON.parse(decodeURIComponent(escape(atob(pad))));
      } catch (e) { return { ok: false, error: "コールバックの解析に失敗しました" }; }
    },
    async guildRoles() {
      return workerGet("/roles", {});
    },
    // Botトークンでギルドメンバーを引く（本人の再ログインを待たずにロールを最新化できる）
    // → { inGuild, nick, roles:[{id,name,color}] }
    async guildMember(userId) {
      return workerGet("/member", { userId });
    },
    // ロール一覧のキャッシュ（名前・色の表示用。30分）
    async rolesCached(force) {
      const K = "mcc-lb2-roles-cache";
      try {
        const raw = localStorage.getItem(K);
        if (raw && !force) {
          const c = JSON.parse(raw);
          if (c && Array.isArray(c.roles) && Date.now() - (c.at || 0) < 30 * 60 * 1000) return c.roles;
        }
      } catch (e) { }
      const res = await this.guildRoles();
      const roles = (res && res.roles) || [];
      try { localStorage.setItem(K, JSON.stringify({ at: Date.now(), roles })); } catch (e) { }
      return roles;
    }
  };

  /* ---- ランク表示ヘルパー ---- */
  const TIER_COLORS = {
    IRON: "#8a8a8a", BRONZE: "#a86a3d", SILVER: "#9fb4c7", GOLD: "#e0a52e",
    PLATINUM: "#3fbaa5", EMERALD: "#2fae62", DIAMOND: "#5aa3e8",
    MASTER: "#b04ee0", GRANDMASTER: "#e04e4e", CHALLENGER: "#38c8e8", RATED: "#d94e97"
  };
  function rankLabel(rank) {
    if (!rank || !rank.tier) return "ランクなし";
    const div = /^(MASTER|GRANDMASTER|CHALLENGER|RATED)$/.test(rank.tier) ? "" : (" " + (rank.division || ""));
    return rank.tier + div + " " + (rank.lp | 0) + "LP";
  }
  function rankColor(rank) { return (rank && TIER_COLORS[rank.tier]) || "var(--muted)"; }

  /* =============================================================
     ランクアイコン（IRON 〜 CHALLENGER）

     ★ Riot の公式エンブレムは使っていません。自前で描いた紋章です。
       盾のかたち＋中の記号でティアを表します。

         IRON        …　横棒
         BRONZE      …　山 ×1
         SILVER      …　山 ×2
         GOLD        …　山 ×3
         PLATINUM    …　ひし形
         EMERALD     …　六角形
         DIAMOND     …　二重のひし形
         MASTER      …　王冠（3つ山）＋翼
         GRANDMASTER …　王冠＋台座＋翼
         CHALLENGER  …　王冠（5つ山）＋台座＋翼

     ・<defs> も グラデーションも使っていないので、
       同じページに何個置いてもIDがぶつかりません。
     ・色は自分で持っているのでライト／ダークどちらでもそのまま出せます。
     ・使い方:  el.innerHTML = C.rankIcon(player.rank) + C.rankLabel(player.rank);
       大きさは CSS の .rkico（ui.css）で文字に合わせています。
     ============================================================= */
  const SHIELD = "M12 2.4 L20.6 6.3 V12.9 C20.6 17.3 16.9 20.5 12 21.8 " +
                 "C7.1 20.5 3.4 17.3 3.4 12.9 V6.3 Z";
  const WING_L = "M3.1 8.6 L0.7 10.5 L3.1 12.4 Z";
  const WING_R = "M20.9 8.6 L23.3 10.5 L20.9 12.4 Z";
  const CROWN3 = "M7.5 16.6 L6.4 9.6 L9.5 11.9 L12 8.1 L14.5 11.9 L17.6 9.6 L16.5 16.6 Z";
  const CROWN5 = "M7.3 16.6 L6.2 9.4 L8.7 11.6 L10.3 8.6 L12 11.2 L13.7 8.6 " +
                 "L15.3 11.6 L17.8 9.4 L16.7 16.6 Z";
  const BASE   = "M7.6 18.1 H16.4";

  function chev(y) { return "M8.5 " + y + " L12 " + (y - 2.3) + " L15.5 " + y; }

  // ティアごとの中身。glyph = 白で描く部分
  const TIER_ART = {
    IRON:        { wings: false, strokes: ["M8.8 14 H15.2"], fills: [] },
    BRONZE:      { wings: false, strokes: [chev(15.2)], fills: [] },
    SILVER:      { wings: false, strokes: [chev(13.8), chev(16.6)], fills: [] },
    GOLD:        { wings: false, strokes: [chev(12.4), chev(15.2), chev(18)], fills: [] },
    PLATINUM:    { wings: false, strokes: [], fills: ["M12 9 L15.6 13 L12 17 L8.4 13 Z"] },
    EMERALD:     { wings: false, strokes: [],
                   fills: ["M12 8.8 L15.7 11 V15.4 L12 17.6 L8.3 15.4 V11 Z"] },
    DIAMOND:     { wings: false, strokes: ["M12 8.5 L16.1 13 L12 17.5 L7.9 13 Z"],
                   fills: ["M12 11.2 L14 13 L12 14.8 L10 13 Z"] },
    MASTER:      { wings: true,  strokes: [], fills: [CROWN3] },
    GRANDMASTER: { wings: true,  strokes: [BASE], fills: [CROWN3] },
    CHALLENGER:  { wings: true,  strokes: [BASE], fills: [CROWN5] },
    RATED:       { wings: true,  strokes: [], fills: ["M12 8.4 L13.9 12.3 L18.2 12.9 " +
                                                      "L15.1 15.9 L15.8 20.1 L12 18.1 " +
                                                      "L8.2 20.1 L8.9 15.9 L5.8 12.9 " +
                                                      "L10.1 12.3 Z"] }
  };

  function tierOf(rank) {
    const t = (rank && rank.tier) ? String(rank.tier).toUpperCase() : "";
    return TIER_ART[t] ? t : "";
  }

  /* =============================================================
     ★ ランクアイコンの差し替え

     Firestore の lboard_index/rankicons に、ティアごとの設定を持ちます。

       { tiers: {
           MASTER: { img: "data:image/png;base64,…",   // サイト用の画像（任意）
                     emoji: "<:master:123456789>" }    // Discord用の絵文字（任意）
         }, updatedAt }

     ・img を入れると、サイトのアイコンがその画像に置きかわります。
       空にすると自作の紋章（下のSVG）に戻ります。
     ・emoji は Discord の投稿でティア名の前に入ります。
       Discordは画像をテキストに埋め込めないため、絵文字コードを使います。
         ふつうの絵文字      👑
         サーバー絵文字      <:master:123456789012345678>
     ・画面はすぐ描きたいので localStorage にも控えを持ち、
       読み込みが終わったら差し替えます（loadRankIcons）。
     ============================================================= */
  const RKICON_LS = "mcc-lb2-rankicons";
  let RKICONS = { tiers: {}, updatedAt: 0 };
  try {
    const raw = localStorage.getItem(RKICON_LS);
    if (raw) RKICONS = normRankIcons(JSON.parse(raw));
  } catch (e) { }

  function normRankIcons(raw) {
    raw = raw || {};
    const src = raw.tiers || {};
    const out = { tiers: {}, updatedAt: raw.updatedAt || 0 };
    Object.keys(TIER_ART).forEach(t => {
      const a = src[t] || {};
      const img = typeof a.img === "string" ? a.img.trim() : "";
      const emoji = typeof a.emoji === "string" ? a.emoji.trim().slice(0, 60) : "";
      // javascript: などを弾く。使えるのは画像のデータURLと http(s) だけ。
      const okImg = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(img) ||
                    /^https?:\/\//i.test(img);
      if (okImg || emoji) out.tiers[t] = { img: okImg ? img : "", emoji: emoji };
    });
    return out;
  }
  function rankIconSet() { return JSON.parse(JSON.stringify(RKICONS)); }
  function rankIconOf(tier) { return (RKICONS.tiers || {})[tier] || { img: "", emoji: "" }; }
  function tierEmoji(tier) { return rankIconOf(tier).emoji || ""; }

  async function loadRankIcons() {
    try {
      const db = openDb();
      if (db) {
        const snap = await db.collection("lboard_index").doc("rankicons").get();
        if (snap.exists) {
          RKICONS = normRankIcons(snap.data());
          try { localStorage.setItem(RKICON_LS, JSON.stringify(RKICONS)); } catch (e) { }
        }
      }
    } catch (e) { console.warn("ランクアイコンの読み込みに失敗", e); }
    return rankIconSet();
  }
  /* ページを開いたら一度だけ最新を取りに行く。
     変わっていたら "lb-rankicons" を飛ばすので、各ページはそれで描き直す。 */
  function autoLoadRankIcons() {
    const before = JSON.stringify(RKICONS.tiers || {});
    loadRankIcons().then(() => {
      if (JSON.stringify(RKICONS.tiers || {}) === before) return;
      try { window.dispatchEvent(new CustomEvent("lb-rankicons", { detail: rankIconSet() })); }
      catch (e) { }
    }).catch(() => { });
  }
  if (typeof window !== "undefined") setTimeout(autoLoadRankIcons, 0);

  async function saveRankIcons(set) {
    if (!isAdmin()) throw new Error("ランクアイコンの編集は管理者のみです");
    const m = normRankIcons(set);
    m.updatedAt = Date.now();
    const db = openDb();
    try {
      if (db) await db.collection("lboard_index").doc("rankicons").set(m);
    } catch (e) {
      throw new Error("ランクアイコンを保存できませんでした（" + (e.code || e.message) + "）");
    }
    RKICONS = m;
    try { localStorage.setItem(RKICON_LS, JSON.stringify(m)); } catch (e) { }
    return m;
  }

  /* ランクアイコンのSVG文字列を返す。
     rankIcon(rank)              → <svg class="rkico">…</svg>
     rankIcon(rank, { cls:"…" }) → class を足したいとき
     ランクが無い人は薄いグレーの空の盾になります（レイアウトが崩れないように）。 */
  function rankIcon(rank, opts) {
    opts = opts || {};
    const tier = tierOf(rank);
    const cls0 = "rkico" + (opts.cls ? " " + opts.cls : "");
    // ★ 管理コンソールで画像を登録していたら、そちらを使う
    const ov = tier ? rankIconOf(tier) : null;
    if (ov && ov.img && !opts.noOverride) {
      const t0 = rankLabel(rank);
      return '<img class="' + cls0 + ' custom" src="' + esc0(ov.img) + '"' +
             (opts.aria ? ' alt="' + esc0(t0) + '"' : ' alt="" aria-hidden="true"') +
             ' loading="lazy">';
    }
    const col = tier ? TIER_COLORS[tier] : "#9aa7b2";
    const art = tier ? TIER_ART[tier] : { wings: false, strokes: [], fills: [] };
    const cls = "rkico" + (opts.cls ? " " + opts.cls : "");
    const title = tier ? rankLabel(rank) : "ランクなし";
    const ink = "#fff";
    let p = "";
    if (art.wings) {
      p += '<path d="' + WING_L + '" fill="' + col + '" opacity=".75"/>';
      p += '<path d="' + WING_R + '" fill="' + col + '" opacity=".75"/>';
    }
    // 盾（本体）＋ 上半分の明るいハイライト
    p += '<path d="' + SHIELD + '" fill="' + col + (tier ? '"' : '" opacity=".45"') + '/>';
    p += '<path d="M12 2.4 L20.6 6.3 V11 H3.4 V6.3 Z" fill="#fff" opacity=".18"/>';
    art.fills.forEach(d => { p += '<path d="' + d + '" fill="' + ink + '" opacity=".95"/>'; });
    art.strokes.forEach(d => {
      p += '<path d="' + d + '" fill="none" stroke="' + ink + '" stroke-width="1.9" ' +
           'stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>';
    });
    /* すぐ横にランク名の文字が出るので、読み上げは文字のほうに任せて
       アイコンは aria-hidden にする（同じことを2回読まれないように）。
       単独で置きたいときは { aria: true } を渡す。 */
    const a11y = opts.aria
      ? ' role="img" aria-label="' + esc0(title) + '"'
      : ' aria-hidden="true" focusable="false"';
    return '<svg class="' + cls + '" viewBox="0 0 24 24"' + a11y + '>' + p + '</svg>';
  }
  // 属性に入れる用の最小限のエスケープ
  function esc0(t) {
    return String(t == null ? "" : t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  /* アイコン＋ラベルをまとめて返す。中身は innerHTML で入れてください。 */
  function rankIconLabel(rank, opts) {
    return rankIcon(rank, opts) + esc0(rankLabel(rank));
  }
  /* 一覧表示用（管理画面のプレビューなど） */
  function rankTiers() { return Object.keys(TIER_ART); }

  /* ---- 公開 ---- */
  window.LBCore = {
    VERSION: "5.3",           // 各ページはこれを見て core.js が古くないか判定する
    SEATS_PER_TABLE,
    pointsFor, makeStore,
    playerById, nameOf, avatarOf,
    hasRole, rosterRoles, roleColorCss, fallbackRoleCatalog,
    isStaff, isParticipant, participants, staffRoleIds,
    isAdmin, isAdminConfigured, adminConfig,
    normVisibility, canViewBoard, visibilityLabel,
    listAllBoards, createBoard, deleteBoard, slugify,
    defaultHomeConfig, normHomeConfig, loadHomeConfig, saveHomeConfig, canSeeEntry, TINTS,
    normChild, noLink,
    cachedHomeConfig, homeConfigKey,
    absLP, absToLabel, absToShort, rankShort, tierLines, dayKey, shiftDay, jstNow,
    loadLpData, recordLp, recordLpForSelf, registerLpMember, markLpCollected, deleteLpDay, setLpBaseline, lpSeries, lpStats,
    lpRange, daysBetween, syncLpRoles,
    lpGroupOrder, lpGroupIndex, lpSectionLabel, saveLpGroups,
    loadMembers, registerMember, updateGlobalMember, removeGlobalMember,
    PROFILE_THEMES, PROFILE_PATTERNS,
    PROFILE_MAX_FREE, PROFILE_MAX_GALLERY, PROFILE_MAX_BYTES,
    PROFILE_REQUIRED, PROFILE_CATS, missingRequired, tacticsUrlFor,
    defaultProfile, normProfile, loadProfiles, loadProfile, saveProfile,
    loadProfileCards, cardOf, normCard,
    setProfileHidden, deleteProfile, profileBytes, profileThemeCss, profileScore,
    safeUrl, safeImg,
    defaultSchedule, normSchedule, loadSchedule, saveSchedule,
    scheduleWeeks, eventsOn, upcomingEvents, weekdayOf, startOfWeek, endOfWeek, WEEK_JA,
    loadVcMeta, loadVcRange, vcMonthsBetween, vcHm,
    defaultSnapshot, normSnapshot, loadSnapshot, saveSnapshot,
    snapshotStandings, snapshotRound, snapshotDone,
    MSG_KEYS, MSG_META, defaultMessages, normMessages, loadMessages, saveMessages,
    fillTemplate, buildMessage, sampleMessageVars, MSG_CHANNELS, channelName,
    isPresent, presentList, presentUnits,
    isDouble, slotCount, SEATS_PER_TABLE_SOLO: 8, TEAMS_PER_TABLE, TEAM_SIZE,
    teamsOf, teamById, teamOfPlayer, teamMembers, teamLabel, unpairedPlayers,
    unitsOf, unitName, unitPlayers, unitOfPlayer,
    tableStandings, overallStandings,
    Riot, DiscordAuth, RiotConfig, Session,
    rankLabel, rankColor, rankIcon, rankIconLabel, rankTiers,
    loadRankIcons, saveRankIcons, rankIconSet, rankIconOf, tierEmoji, normRankIcons
  };
})();
