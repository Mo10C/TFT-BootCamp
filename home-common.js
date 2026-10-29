/* =============================================================
   home-common.js — HOME 系ページの共通処理
   テーマ切替 / トースト / 自分のプロフィール描画 / 権限バッジ / ログアウト

   使い方:
     const ctx = MCCHome.boot(session);
     // ctx = { isAdmin, adminSet, roles, toast }
   ページ側に必要な要素（あるものだけ使われます）:
     #themeBtn #logoutBtn #roleBadge #editorLink
     #meAvatar #meName #meRiot #meRank #meRoles
     #toast
   ============================================================= */
(function () {
  "use strict";
  const C = window.LBCore;
  const $ = id => document.getElementById(id);
  const THEME_KEY = "mcc-portal-theme";

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    const b = $("themeBtn");
    if (b) b.textContent = (t === "dark") ? "☀️" : "🌙";
  }
  // ちらつき防止のため、DOM構築前でも属性だけは当てる
  try { document.documentElement.setAttribute("data-theme", localStorage.getItem(THEME_KEY) || "light"); } catch (e) { }

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    if (!el) { console.log(msg); return; }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function boot(session) {
    session = session || C.Session.get();
    // ★ どのページを開いても、ログイン済みなら全体名簿に登録する（1日1回）。
    //   これで大会ボードを開いていない人も、管理コンソールのメンバー一覧に並ぶ。
    //   ついでに、毎晩23:45の集計（先生スナップショットと同じタイミング）で更新された
    //   自分のランクを取り込む（core.js の syncMyRank）。
    if (session && typeof C.registerMember === "function") {
      C.registerMember(session).catch(() => { });
    } else if (session && typeof C.syncMyRank === "function") {
      C.syncMyRank(session).catch(() => { });
    }
    const isAdmin = C.isAdmin(session);
    const adminSet = C.isAdminConfigured();
    const roles = (session && session.discord && session.discord.roles) || [];

    /* テーマ */
    let cur = "light";
    try { cur = localStorage.getItem(THEME_KEY) || "light"; } catch (e) { }
    applyTheme(cur);
    if ($("themeBtn")) {
      $("themeBtn").onclick = () => {
        const t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
        applyTheme(t);
      };
    }

    /* ログアウト */
    if ($("logoutBtn")) {
      $("logoutBtn").onclick = () => {
        if (!confirm("ログアウトしますか？")) return;
        C.Session.clear();
        location.href = "login.html";
      };
    }

    /* プロフィール */
    if ($("meAvatar")) {
      $("meAvatar").src = (session.discord && session.discord.avatar) || "";
      $("meAvatar").onerror = function () { this.style.visibility = "hidden"; };
    }
    if ($("meName")) $("meName").textContent = (session.discord && (session.discord.name || session.discord.username)) || "—";
    if ($("meRiot")) {
      const rid = C.Session.riotIdOf(session);
      $("meRiot").textContent = rid;
      // ★ 自分の Riot ID をワンタップでコピー
      if (rid && rid !== "#") {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = "📋"; b.title = "Riot ID をコピー";
        b.style.cssText = "margin-left:6px;border:1.5px solid var(--border);background:var(--surface);color:var(--muted);border-radius:8px;" +
          "font-size:11px;font-weight:900;padding:0 6px;cursor:pointer;font-family:inherit;line-height:1.6;vertical-align:middle";
        b.onclick = async e => {
          e.preventDefault(); e.stopPropagation();
          let ok = false;
          try { await navigator.clipboard.writeText(rid); ok = true; }
          catch (x) { const ta = document.createElement("textarea"); ta.value = rid; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select(); try { ok = document.execCommand("copy"); } catch (y) { } ta.remove(); }
          toast(ok ? "📋 Riot ID「" + rid + "」をコピーしました" : "コピーできませんでした：" + rid);
        };
        $("meRiot").appendChild(b);
      }
    }
    if ($("meRank")) {
      const rk = $("meRank");
      let rank = session.riot && session.riot.rank;
      const draw = () => {
        try { rk.innerHTML = C.rankIconLabel(rank, { cls: "sm" }); } catch (e) { }
        rk.style.color = C.rankColor(rank);
        rk.style.borderColor = C.rankColor(rank);
      };
      draw();
      // 管理コンソールでアイコンを差し替えたら描き直す
      window.addEventListener("lb-rankicons", draw);
      // ★ 毎晩の集計で新しいランクが取れたら、ページを開いたまま描き直す
      window.addEventListener("lb-rank-sync", e => { if (e && e.detail && e.detail.tier) { rank = e.detail; draw(); } });
    }
    if ($("meRoles")) {
      const box = $("meRoles");
      box.innerHTML = "";
      roles.forEach(r => {
        const chip = document.createElement("span");
        chip.className = "role-chip";
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = C.roleColorCss(r.color);
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(r.name || r.id));
        box.appendChild(chip);
      });
      if (!roles.length) {
        const chip = document.createElement("span");
        chip.className = "role-chip";
        chip.textContent = "ロールなし";
        box.appendChild(chip);
      }
    }

    /* 権限バッジ */
    if ($("roleBadge")) {
      const b = $("roleBadge");
      if (isAdmin) {
        b.textContent = adminSet ? "🛠 管理者" : "⚠️ 管理者未設定";
        b.className = "badge " + (adminSet ? "admin" : "warn");
      } else {
        b.textContent = "👤 プレイヤー";
        b.className = "badge";
      }
    }
    if ($("editorLink")) $("editorLink").style.display = isAdmin ? "" : "none";

    return { isAdmin, adminSet, roles, toast };
  }

  window.MCCHome = { boot, toast, applyTheme };
})();
