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
    if (session && typeof C.registerMember === "function") {
      C.registerMember(session).catch(() => { });
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
    if ($("meRiot")) $("meRiot").textContent = C.Session.riotIdOf(session);
    if ($("meRank")) {
      const rk = $("meRank");
      const rank = session.riot && session.riot.rank;
      rk.textContent = C.rankLabel(rank);
      rk.style.color = C.rankColor(rank);
      rk.style.borderColor = C.rankColor(rank);
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
