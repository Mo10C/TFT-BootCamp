/* =============================================================
   core.js — ログイン式リーダーボード 共通コアロジック
   セッション / データ模型 / 得点計算 / Firestore同期 / Riot API / ロール

   login.html / index.html / editor.html が読み込みます。

   ★ 選手（roster の1件）はログインしたユーザーそのもの:
     { id: "u_<discordId>",
       name, riotId, puuid,
       rank: { tier, division, lp, queue },
       discord: { id, name, username, avatar },
       roles: [{id, name, color}],   // ログイン時点のギルドロール
       joinedAt, updatedAt }

   ★ ボード状態（v2互換の縮小版・個人戦）:
     { mode:"solo", title, matchCount, tableCount,
       roster:[player], matches:[{ tables:[{seats[8], placements{}}], present }],
       updatedAt }
     present: pid配列（null=全員参加）
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
    }
  };

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
    return { mode: "solo", title: "", matchCount: mc, tableCount: tc, roster: [], matches: buildMatches(mc, tc), updatedAt: Date.now() };
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
    const INDEX_LS_KEY = "mcc-lb2-board-index";
    const idxKey = id => encodeURIComponent(id);
    const lsKey = () => "mcclb2:" + boardId;

    function getBoardId() {
      const p = new URLSearchParams(location.search);
      return p.get("board") || "default";
    }
    function emit() { listeners.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }
    function onChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; }

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
      if (!Array.isArray(s.roster)) s.roster = [];
      s.roster = s.roster.filter(p => p && p.id).map(p => ({
        id: p.id, name: p.name || "—", riotId: p.riotId || "", puuid: p.puuid || "",
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
      return { title: state.title || "", matchCount: state.matchCount, tableCount: state.tableCount, players: state.roster.length, updatedAt: state.updatedAt || Date.now() };
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
        players: (v && v.players) || 0, updatedAt: (v && v.updatedAt) || 0
      })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    function setBoardTitle(name) { state.title = (name || "").trim(); save(); }

    /* ---- 設定 ---- */
    function setSettings(patch) {
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
       同じ discord.id なら情報を最新化（ランク・ロール・アバター）。 */
    function upsertSelf(session) {
      const p = Session.toPlayer(session);
      if (!p) return null;
      const i = state.roster.findIndex(x => x.id === p.id);
      if (i >= 0) {
        const prev = state.roster[i];
        state.roster[i] = Object.assign({}, prev, p, { joinedAt: prev.joinedAt || Date.now() });
      } else {
        p.joinedAt = Date.now();
        state.roster.push(p);
      }
      save();
      return p.id;
    }
    function updatePlayer(pid, patch) {
      const p = state.roster.find(x => x.id === pid);
      if (!p) return;
      Object.assign(p, patch, { updatedAt: Date.now() });
      save();
    }
    function removePlayer(pid) {
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
      const tb = state.matches[matchIdx].tables[tableIdx];
      const pid = tb.seats[seatIdx];
      tb.seats[seatIdx] = null;
      if (pid) delete tb.placements[pid];
      save();
    }
    function setPlacement(matchIdx, tableIdx, pid, rank) {
      const tb = state.matches[matchIdx].tables[tableIdx];
      if (rank) tb.placements[pid] = rank | 0;
      else delete tb.placements[pid];
      save();
    }
    function clearMatchSeats(matchIdx) {
      const mt = state.matches[matchIdx];
      if (!mt) return;
      mt.tables.forEach(tb => { tb.seats = new Array(SEATS_PER_TABLE).fill(null); tb.placements = {}; });
      save();
    }
    function clearAllResults() {
      state.matches.forEach(mt => mt.tables.forEach(tb => { tb.placements = {}; }));
      save();
    }
    function resetBoard() {
      const roster = state.roster; // ログイン済みメンバーは残す
      state = blankState();
      state.roster = roster;
      save();
    }
    function importState(obj) { state = normalize(obj); save(); }
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
    function setPresent(matchIdx, pid, on) {
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
      setSettings, upsertSelf, updatePlayer, removePlayer,
      assignSeat, clearSeat, setPlacement,
      clearMatchSeats, clearAllResults, resetBoard, importState, loadBoardState,
      setPresent, setAllPresent, setPresentByRole, autoAssign,
      listBoards, setBoardTitle,
      _persistNow: persist
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
  function roleColorCss(color) {
    if (!color) return "var(--muted)";
    return "#" + Number(color).toString(16).padStart(6, "0");
  }
  function isAdmin(session) {
    const ids = ((CFG.roles || {}).adminRoleIds) || [];
    if (!ids.length) return true; // 未設定なら全員OK（たたき台）
    const roles = (session && session.discord && session.discord.roles) || [];
    return roles.some(r => ids.includes(r.id));
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
    SEATS_PER_TABLE,
    pointsFor, makeStore,
    playerById, nameOf, avatarOf,
    hasRole, rosterRoles, roleColorCss, isAdmin,
    isPresent, presentList,
    tableStandings, overallStandings,
    Riot, DiscordAuth, RiotConfig, Session,
    rankLabel, rankColor
  };
})();
