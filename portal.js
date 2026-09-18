/* UI only. Permissions and data handling stay in LBCore. */
(function () {
  "use strict";

  // Keep configured images; upgrade only the existing emoji fallback.
  const iconPaths = {"boards": "<path d=\"M8 4h8v7a4 4 0 0 1-8 0V4ZM8 6H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4M12 15v5m-4 0h8\"/>", "schedule": "<rect x=\"4\" y=\"5\" width=\"16\" height=\"15\" rx=\"2\"/><path d=\"M8 3v4m8-4v4M4 10h16m-12 4h3m2 3h3\"/>", "members": "<circle cx=\"9\" cy=\"8\" r=\"3\"/><path d=\"M3 20v-3a6 6 0 0 1 12 0v3m0-15a3 3 0 0 1 0 6m3 3a5 5 0 0 1 3 6\"/>", "lp": "<path d=\"M4 4v16h16M7 15l4-5 4 2 5-7m-5 0h5v5\"/>"};
  const tiles = document.getElementById('pops');
  function polishIcons() {
    if (!tiles || !document.body.classList.contains('page-home')) return;
    const sideCount = String(Math.max(1, tiles.querySelectorAll('a.pop').length - 1));
    if (tiles.style.getPropertyValue('--side-count') !== sideCount) tiles.style.setProperty('--side-count', sideCount);
    tiles.querySelectorAll('a.pop').forEach(a => {
      const key = (a.getAttribute('href') || '').split('.')[0];
      const el = a.querySelector('.ico:not(.img)');
      if (!el || el.querySelector('svg') || !iconPaths[key]) return;
      el.innerHTML = '<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + iconPaths[key] + '</svg>';
    });
  }
  if (tiles) { polishIcons(); new MutationObserver(polishIcons).observe(tiles,{childList:true,subtree:true,attributes:true,attributeFilter:['class']}); }

  const nav = document.querySelector('.camp-nav');
  const C = window.LBCore;
  const page = location.pathname.split('/').pop() || 'index.html';
  const theme = document.getElementById('themeBtn');
  if (theme) theme.setAttribute('aria-label', 'ライト・ダークテーマを切り替える');
  if (!nav || !C || page === 'login.html' || !C.Session.isComplete()) return;
  function render(home) {
    nav.replaceChildren();
    const entries = [{name:'HOME',url:'home.html'}, ...(home.tiles || []).filter(t => t.enabled && !t.soon && C.canSeeEntry(t, C.Session.get()))];
    const seen = new Set();
    entries.forEach(t => {
      let u; try { u = new URL(t.url, location.href); } catch (_) { return; }
      if (u.origin !== location.origin || seen.has(u.href)) return;
      seen.add(u.href);
      const a = document.createElement('a'); a.href = u.href; a.textContent = t.name;
      if (u.pathname.split('/').pop() === page || (page === 'index.html' && u.pathname.endsWith('/boards.html'))) a.setAttribute('aria-current','page');
      nav.appendChild(a);
    });
    nav.hidden = false;
  }
  render(C.cachedHomeConfig() || C.defaultHomeConfig());
  C.loadHomeConfig().then(render).catch(() => {});
})();
