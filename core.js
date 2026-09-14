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
          docRef.onSnapshot(s => {
            if (!s.exists) return;
            applyingRemote = true;
            state = normalize(s.data());
            applyingRemote = false;
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
        players: state.roster.length, visibility: normVisibility(state.visibility),
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
    function upsertSelf(session) {
      const p = Session.toPlayer(session);
      if (!p) return null;
      const i = state.roster.findIndex(x => x.id === p.id);
      if (i >= 0) {
        const prev = state.roster[i];
        const merged = Object.assign({}, prev, p, { joinedAt: prev.joinedAt || Date.now() });
        if (prev.nameLocked) { merged.name = prev.name; merged.nameLocked = true; }
        state.roster[i] = merged;
      } else {
        p.joinedAt = Date.now();
        state.roster.push(p);
      }
      save();
      return p.id;
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
      // 同じ試合で既に座っていたら外す
      state.matches[matchIdx].tables.forEach(x => {
        const i = x.seats.indexOf(pid);
        if (i >= 0) x.seats[i] = null;
      });
      tb.seats[seatIdx] = pid;
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
      if (!Array.isArray(mt.present)) mt.present = state.roster.map(p => p.id);
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
      const target = Array.isArray(pids) ? pids : state.roster.map(p => p.id);
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
      const withRole = state.roster.filter(p => hasRole(p, roleId)).map(p => p.id);
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
      setSettings, upsertSelf, updatePlayer, setPlayerName, removePlayer,
      assignSeat, clearSeat, setPlacement,
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
  const TINTS = ["pink", "cyan", "violet", "gold", "ok", "danger"];

  function defaultHomeConfig() {
    return {
      title: "クラウドハッシュテイル校 TOOLS",
      subtitle: "Discordログイン式ホーム",
      tiles: [
        { id: "boards",   icon: "🏆", name: "大会",         desc: "リーダーボード。組卓・順位入力・全体順位。", url: "boards.html",   tint: "pink",   enabled: true, soon: false, roleIds: [] },
        { id: "schedule", icon: "🗓", name: "予定表",       desc: "大会・合宿・コーチングの日程をまとめて確認。", url: "schedule.html", tint: "cyan",   enabled: true, soon: true,  roleIds: [] },
        { id: "members",  icon: "👥", name: "メンバー紹介", desc: "校のメンバーのプロフィールとロール。",       url: "members.html",  tint: "violet", enabled: true, soon: true,  roleIds: [] },
        { id: "lp",       icon: "📈", name: "LPランキング", desc: "メンバーのランクとLPを一覧で比較。",         url: "lp.html",       tint: "gold",   enabled: true, soon: true,  roleIds: [] }
      ],
      tools: (((CFG.home || {}).tools) || []).slice(),
      updatedAt: 0
    };
  }
  function normTile(t, i) {
    t = t || {};
    return {
      id: String(t.id || ("tile" + i)),
      icon: String(t.icon || "🔗").slice(0, 4),
      name: String(t.name || "無題").slice(0, 40),
      desc: String(t.desc || "").slice(0, 120),
      url: String(t.url || "#").slice(0, 300),
      tint: TINTS.includes(t.tint) ? t.tint : "pink",
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
     集計・ヘルパー
     ============================================================= */
  function playerById(state, id) { return state.roster.find(p => p.id === id) || null; }
  function nameOf(state, id) { const p = playerById(state, id); return p ? p.name : "—"; }
  function avatarOf(state, id) { const p = playerById(state, id); return (p && p.discord && p.discord.avatar) || ""; }
  function hasRole(p, roleId) { return !!(p && Array.isArray(p.roles) && p.roles.some(r => r && r.id === roleId)); }

  // ボード上の全ロール一覧（pinnedOrder → position順）
  function rosterRoles(state) {
    const map = new Map();
    (state.roster || []).forEach(p => (p.roles || []).forEach(r => {
      if (r && r.id && !map.has(r.id)) map.set(r.id, { id: r.id, name: r.name || r.id, color: r.color || 0, count: 0 });
    }));
    (state.roster || []).forEach(p => (p.roles || []).forEach(r => {
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
    const mt = state.matches[matchIdx];
    if (!mt) return true;
    return !Array.isArray(mt.present) ? true : mt.present.includes(pid);
  }
  function presentList(state, matchIdx) {
    const mt = state.matches[matchIdx];
    if (!mt) return [];
    const set = new Set(!Array.isArray(mt.present) ? state.roster.map(p => p.id) : mt.present);
    return state.roster.filter(p => set.has(p.id)).map(p => p.id);
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
    state.roster.forEach(p => { totals[p.id] = { pid: p.id, name: p.name, points: 0, games: 0 }; });
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

    /* 卓の全員を含む直近マッチを自動検出して順位を返す
       players: [{pid, puuid}]（puuid登録済み前提。無い人は無視）
       戻り値: { matchId, placements: {pid: rank} } or null */
    async autoDetectTable(players, onProgress) {
      const valid = players.filter(p => p.puuid);
      if (valid.length < 2) throw new Error("puuid登録済み（ログイン済み）の選手が2人以上必要です");
      const base = valid[0];
      onProgress && onProgress("マッチ履歴を取得中…");
      const baseIds = await Riot.recentMatches(base.puuid, 20);
      const targetPuuids = new Set(valid.map(p => p.puuid));
      for (const matchId of baseIds) {
        onProgress && onProgress("照合中: " + matchId);
        let detail;
        try { detail = await Riot.match(matchId); } catch (e) { continue; }
        const parts = (detail.info && detail.info.participants) || [];
        const partPuuids = new Set(parts.map(x => x.puuid));
        if (![...targetPuuids].every(pu => partPuuids.has(pu))) continue;
        const placements = {};
        for (const p of valid) {
          const part = parts.find(x => x.puuid === p.puuid);
          if (part) placements[p.pid] = part.placement;
        }
        return { matchId, placements };
      }
      return null;
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
    VERSION: "2.9",           // 各ページはこれを見て core.js が古くないか判定する
    SEATS_PER_TABLE,
    pointsFor, makeStore,
    playerById, nameOf, avatarOf,
    hasRole, rosterRoles, roleColorCss, fallbackRoleCatalog,
    isAdmin, isAdminConfigured, adminConfig,
    normVisibility, canViewBoard, visibilityLabel,
    listAllBoards, createBoard, deleteBoard, slugify,
    defaultHomeConfig, normHomeConfig, loadHomeConfig, saveHomeConfig, canSeeEntry, TINTS,
    cachedHomeConfig, homeConfigKey,
    isPresent, presentList,
    tableStandings, overallStandings,
    Riot, DiscordAuth, RiotConfig, Session,
    rankLabel, rankColor
  };
})();
