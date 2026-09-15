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

  function emptyTable() { return { seats: new Array(SEATS_PER_TABLE).fill(null), placements: {} }; }
  function buildMatches(matchCount, tableCount) {
    const out = [];
    for (let m = 0; m < matchCount; m++) {
      const tables = [];
      for (let t = 0; t < tableCount; t++) tables.push(emptyTable());
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
      roster: [], matches: buildMatches(mc, tc), updatedAt: Date.now()
    };
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
      s.mode = "solo"; // たたき台は個人戦のみ
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
      if (!Array.isArray(s.matches)) s.matches = buildMatches(s.matchCount, s.tableCount);
      for (let m = 0; m < s.matchCount; m++) {
        if (!s.matches[m]) s.matches[m] = { tables: [], present: null };
        if (!Array.isArray(s.matches[m].tables)) s.matches[m].tables = [];
        for (let t = 0; t < s.tableCount; t++) {
          let tb = s.matches[m].tables[t];
          if (!tb) { tb = emptyTable(); s.matches[m].tables[t] = tb; }
          if (!Array.isArray(tb.seats)) tb.seats = new Array(SEATS_PER_TABLE).fill(null);
          while (tb.seats.length < SEATS_PER_TABLE) tb.seats.push(null);
          tb.seats.length = SEATS_PER_TABLE;
          if (!tb.placements || typeof tb.placements !== "object") tb.placements = {};
        }
        const pr = s.matches[m].present;
        s.matches[m].present = Array.isArray(pr) ? pr.filter(id => s.roster.some(p => p.id === id)) : null;
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
      mt.tables.forEach(tb => { tb.seats = new Array(SEATS_PER_TABLE).fill(null); tb.placements = {}; });
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

    /* ---- 参加者（出席）管理 ---- */
    function materializePresent(matchIdx) {
      const mt = state.matches[matchIdx];
      if (!mt) return [];
      if (!Array.isArray(mt.present)) mt.present = participants(state).map(p => p.id);
      return mt.present;
    }
    // 一般プレイヤーは「自分の出欠」だけ切り替えられる
    function setPresent(matchIdx, pid, on) {
      if (!actor.isAdmin && pid !== actor.pid) return deny("他の選手の出欠変更");
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const arr = materializePresent(matchIdx);
      const i = arr.indexOf(pid);
      if (on) { if (i < 0) arr.push(pid); }
      else {
        if (i >= 0) arr.splice(i, 1);
        mt.tables.forEach(tb => {
          const si = tb.seats.indexOf(pid);
          if (si >= 0) tb.seats[si] = null;
          delete tb.placements[pid];
        });
      }
      save();
    }
    function setAllPresent(matchIdx, on, pids) {
      if (!guard("出欠の一括変更")) return;
      // pids を渡すとその集合だけを対象にする（ロールフィルタ用）
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const target = Array.isArray(pids) ? pids : participants(state).map(p => p.id);
      const arr = materializePresent(matchIdx);
      if (on) {
        target.forEach(id => { if (!arr.includes(id)) arr.push(id); });
      } else {
        mt.present = arr.filter(id => !target.includes(id));
        mt.tables.forEach(tb => {
          tb.seats = tb.seats.map(pid => (pid && target.includes(pid)) ? null : pid);
          target.forEach(pid => delete tb.placements[pid]);
        });
      }
      save();
    }
    // 指定ロール保持者だけを参加にする
    function setPresentByRole(matchIdx, roleId) {
      if (!guard("ロールによる出欠の一括変更")) return;
      const mt = state.matches[matchIdx];
      if (!mt) return;
      const withRole = participants(state).filter(p => hasRole(p, roleId)).map(p => p.id);
      mt.present = withRole;
      mt.tables.forEach(tb => {
        tb.seats = tb.seats.map(pid => (pid && !withRole.includes(pid)) ? null : pid);
        Object.keys(tb.placements).forEach(pid => { if (!withRole.includes(pid)) delete tb.placements[pid]; });
      });
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
      const cap = tableCount * SEATS_PER_TABLE;

      let ids = presentList(state, matchIdx).slice();
      if (opts.limitRoleId) ids = ids.filter(pid => hasRole(playerById(state, pid), opts.limitRoleId));
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
          pm.tables.forEach(tb => tb.seats.forEach(pid => {
            if (pid && pts[pid] != null) {
              const r = tb.placements[pid];
              if (r) pts[pid] += pointsFor(state.mode, r);
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
      mt.tables.forEach(tb => { tb.seats = new Array(SEATS_PER_TABLE).fill(null); tb.placements = {}; });
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
        const withRole = shuffle(ids.filter(pid => hasRole(playerById(state, pid), opts.roleId)));
        const rest = shuffle(ids.filter(pid => !hasRole(playerById(state, pid), opts.roleId)));
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
        const keyOf = pid => {
          const p = playerById(state, pid);
          if (opts.roleId) return hasRole(p, opts.roleId) ? "in" : "out";
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
      tiles: [
        { id: "boards",   icon: "🏆", img: "assets/tile-boards.png",   name: "大会",         desc: "リーダーボード。組卓・順位入力・全体順位。", url: "boards.html",   tint: "leaf", enabled: true, soon: false, roleIds: [] },
        { id: "schedule", icon: "🗓", img: "assets/tile-schedule.png", name: "予定表",       desc: "校内イベント・対抗戦の日程をカレンダーで確認。", url: "schedule.html", tint: "leaf", enabled: true, soon: false, roleIds: [] },
        { id: "members",  icon: "👥", img: "assets/tile-members.png",  name: "メンバー紹介", desc: "校のメンバーのプロフィールとロール。",       url: "members.html",  tint: "leaf", enabled: true, soon: true,  roleIds: [] },
        { id: "lp",       icon: "📈", img: "assets/tile-lp.png",       name: "LPランキング", desc: "メンバーのランクとLPを一覧で比較。",         url: "lp.html",       tint: "leaf", enabled: true, soon: false, roleIds: [] }
      ],
      tools: (((CFG.home || {}).tools) || []).slice(),
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

  function normTile(t, i) {
    t = t || {};
    return {
      id: String(t.id || ("tile" + i)),
      icon: String(t.icon || "🔗").slice(0, 4),
      // ★ 画像アイコン。空なら icon（絵文字）を使う。
      //   読み込みに失敗したときも絵文字に戻るので、消えたままにはならない。
      img: String(t.img || TILE_IMG[String(t.id || "")] || "").slice(0, 300),
      name: String(t.name || "無題").slice(0, 40),
      desc: String(t.desc || "").slice(0, 120),
      url: String(t.url || "#").slice(0, 300),
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
    const beforeToday = keys.filter(k => k < today);
    const prevKey = beforeToday.length ? beforeToday[beforeToday.length - 1] : null;

    let baseKey = null;
    if (lp.baseline) {
      const le = keys.filter(k => k <= lp.baseline);
      baseKey = le.length ? le[le.length - 1] : keys[0];
    }
    const latest = h[latestKey];
    const prev = prevKey != null ? h[prevKey] : null;
    const base = baseKey != null ? h[baseKey] : null;
    return {
      latest, prev, base,
      dayDelta: (prev != null) ? (latest - prev) : null,
      baseDelta: (base != null) ? (latest - base) : null,
      latestDate: latestKey, prevDate: prevKey || "", baseDate: baseKey || ""
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
      where: "談話室",
      when: "毎日23:45の集計でティアが上がった人がいたとき",
      vars: {
        head: [["count", "人数"]],
        line: [["emoji", "ティアの絵文字"], ["name", "名前"], ["from", "前のティア"],
               ["to", "新しいティア"], ["division", "ディビジョン"], ["lp", "LP"]],
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
      where: "談話室",
      when: "実施日の23:45",
      vars: {
        head: [["label", "呼び名"], ["maru", "①②…"], ["round", "回数"],
               ["md", "10/31"], ["date", "2026-10-31"]],
        line: [["medal", "🥇🥈🥉"], ["rank", "順位"], ["name", "名前"],
               ["rankLabel", "MASTER 120LP"], ["point", "ポイント"]],
        foot: [["label", "呼び名"], ["maru", "①②…"]]
      }
    },
    final: {
      name: "代表先生の表彰",
      where: "談話室",
      when: "最終回の23:45（結果のすぐあと）",
      vars: {
        head: [["title", "表彰の名前"], ["label", "呼び名"], ["rounds", "全体の回数"], ["n", "選ばれる人数"]],
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
        head: "📸 **{label}{maru}**　{md} 23:45 時点",
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
    const out = { updatedAt: raw.updatedAt || 0 };
    MSG_KEYS.forEach(k => {
      const a = raw[k] || {};
      out[k] = {
        head: typeof a.head === "string" ? a.head : d[k].head,
        line: (typeof a.line === "string" && a.line.trim()) ? a.line : d[k].line,
        foot: typeof a.foot === "string" ? a.foot : d[k].foot
      };
    });
    return out;
  }

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
        { emoji: "💠", name: "もと先生", from: "EMERALD", to: "DIAMOND", division: "IV", lp: 12 },
        { emoji: "👑", name: "すいちゃん", from: "DIAMOND", to: "MASTER", division: "", lp: 5 }
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
      head: { label: "先生スナップショット", maru: "①", round: 1, md: "10/31", date: "2026-10-31" },
      rows: [
        { medal: "🥇", rank: 1, name: "あ先生", rankLabel: "MASTER 120LP", point: 4 },
        { medal: "🥈", rank: 2, name: "い先生", rankLabel: "DIAMOND I 40LP", point: 3 },
        { medal: "🥉", rank: 3, name: "う先生", rankLabel: "DIAMOND III 10LP", point: 2 },
        { medal: "4️⃣", rank: 4, name: "え先生", rankLabel: "EMERALD I 80LP", point: 1 }
      ]
    };
    return {
      head: { title: "代表先生", label: "先生スナップショット", rounds: 2, n: 4 },
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
    return !Array.isArray(mt.present) ? true : mt.present.includes(pid);
  }
  function presentList(state, matchIdx) {
    const mt = state.matches[matchIdx];
    if (!mt) return [];
    const pool = participants(state);
    const set = new Set(!Array.isArray(mt.present) ? pool.map(p => p.id) : mt.present);
    return pool.filter(p => set.has(p.id)).map(p => p.id);
  }

  function tableStandings(state, matchIdx, tableIdx) {
    const tb = state.matches[matchIdx].tables[tableIdx];
    const rows = [];
    tb.seats.forEach(pid => {
      if (!pid) return;
      const rank = tb.placements[pid] || null;
      rows.push({ pid, name: nameOf(state, pid), rank, points: pointsFor(state.mode, rank) });
    });
    rows.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    return { mode: state.mode, rows };
  }

  function overallStandings(state) {
    const totals = {};
    participants(state).forEach(p => { totals[p.id] = { pid: p.id, name: p.name, points: 0, games: 0 }; });
    state.matches.forEach(mt => mt.tables.forEach(tb => {
      tb.seats.forEach(pid => {
        if (!pid || !totals[pid]) return;
        const rank = tb.placements[pid];
        if (rank) { totals[pid].points += pointsFor(state.mode, rank); totals[pid].games += 1; }
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
    async autoDetectTable(players, onProgress, opts) {
      opts = opts || {};
      const min = Math.max(2, opts.min || 2);
      const count = opts.count || 20;
      const budget = opts.budget || 30;      // マッチ詳細の取得回数上限（レート制限対策）

      const valid = players.filter(p => p.puuid);
      if (valid.length < min) {
        throw new Error("ログイン済み（puuid登録済み）の選手が" + min + "人以上必要です。現在" + valid.length + "人");
      }

      // 履歴を見る起点。先頭の人が校外だったり未プレイでも拾えるよう複数人ぶん辿る
      const bases = valid.slice(0, Math.min(3, valid.length));
      const seen = new Set();
      let fetched = 0;
      let best = null;

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
          const parts = (detail.info && detail.info.participants) || [];
          const partPuuids = new Set(parts.map(x => x.puuid));
          const hit = valid.filter(p => partPuuids.has(p.puuid));
          if (hit.length < min) continue;

          const when = (detail.info && detail.info.game_datetime) || 0;
          if (!best || hit.length > best.hit.length || (hit.length === best.hit.length && when > best.when)) {
            best = { matchId, hit, parts, when };
          }
          if (best.hit.length === valid.length) break;   // 全員揃ったら即決
        }
        if (best && best.hit.length === valid.length) break;
        if (fetched >= budget) break;
      }

      if (!best) return null;
      const placements = {};
      best.hit.forEach(p => {
        const part = best.parts.find(x => x.puuid === p.puuid);
        if (part) placements[p.pid] = part.placement;
      });
      const hitPids = new Set(best.hit.map(p => p.pid));
      return {
        matchId: best.matchId,
        placements,
        matched: best.hit.length,
        total: valid.length,
        missingPids: valid.filter(p => !hitPids.has(p.pid)).map(p => p.pid)
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

  /* ---- 公開 ---- */
  window.LBCore = {
    VERSION: "4.6",           // 各ページはこれを見て core.js が古くないか判定する
    SEATS_PER_TABLE,
    pointsFor, makeStore,
    playerById, nameOf, avatarOf,
    hasRole, rosterRoles, roleColorCss, fallbackRoleCatalog,
    isStaff, isParticipant, participants, staffRoleIds,
    isAdmin, isAdminConfigured, adminConfig,
    normVisibility, canViewBoard, visibilityLabel,
    listAllBoards, createBoard, deleteBoard, slugify,
    defaultHomeConfig, normHomeConfig, loadHomeConfig, saveHomeConfig, canSeeEntry, TINTS,
    cachedHomeConfig, homeConfigKey,
    absLP, absToLabel, absToShort, rankShort, tierLines, dayKey, shiftDay, jstNow,
    loadLpData, recordLp, recordLpForSelf, registerLpMember, markLpCollected, deleteLpDay, setLpBaseline, lpSeries, lpStats,
    lpRange, daysBetween, syncLpRoles,
    lpGroupOrder, lpGroupIndex, lpSectionLabel, saveLpGroups,
    loadMembers, registerMember, updateGlobalMember, removeGlobalMember,
    defaultSchedule, normSchedule, loadSchedule, saveSchedule,
    scheduleWeeks, eventsOn, upcomingEvents, weekdayOf, startOfWeek, endOfWeek, WEEK_JA,
    defaultSnapshot, normSnapshot, loadSnapshot, saveSnapshot,
    snapshotStandings, snapshotRound, snapshotDone,
    MSG_KEYS, MSG_META, defaultMessages, normMessages, loadMessages, saveMessages,
    fillTemplate, buildMessage, sampleMessageVars,
    isPresent, presentList,
    tableStandings, overallStandings,
    Riot, DiscordAuth, RiotConfig, Session,
    rankLabel, rankColor
  };
})();
