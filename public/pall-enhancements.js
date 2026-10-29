/* PALL 8BP UI utilities: command palette, live table filtering, and CSV export. */
(function () {
  if (window.__pallEnhancementsLoaded) return;
  window.__pallEnhancementsLoaded = true;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  // CSRF token (meta tag from the first full page load, or any hidden field on the page).
  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) return meta.content;
    const field = document.querySelector('input[name="_csrf"]');
    return field ? field.value : '';
  }
  window.__pallCsrf = csrfToken;

  // Logging out is a POST: turn every /logout link into a small CSRF-protected form submit.
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link) return;
    let url; try { url = new URL(link.href, location.href); } catch (_) { return; }
    if (url.origin !== location.origin || url.pathname !== '/logout') return;
    event.preventDefault(); event.stopImmediatePropagation();
    const form = document.createElement('form');
    form.method = 'POST'; form.action = '/logout'; form.style.display = 'none';
    const field = document.createElement('input');
    field.type = 'hidden'; field.name = '_csrf'; field.value = csrfToken();
    form.appendChild(field); document.body.appendChild(form); form.submit();
  }, true);

  // Highlight the current section in the navigation without changing page markup.
  function markActiveNav() {
    const path = location.pathname.replace(/\/$/, '') || '/';
    $$(' .topbar nav a[href]').forEach((link) => {
      try {
        const url = new URL(link.href, location.origin);
        if (url.origin === location.origin && url.pathname.replace(/\/$/, '') === path) {
          if (!link.classList.contains('pall-nav-active')) link.classList.add('pall-nav-active');
          if (link.getAttribute('aria-current') !== 'page') link.setAttribute('aria-current', 'page');
        } else {
          if (link.classList.contains('pall-nav-active')) link.classList.remove('pall-nav-active');
          if (link.hasAttribute('aria-current')) link.removeAttribute('aria-current');
        }
      } catch (_) {}
    });
  }

  function toast(message) {
    let region = $('#pall-toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'pall-toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    const item = document.createElement('div');
    item.className = 'pall-toast';
    item.textContent = message;
    region.appendChild(item);
    requestAnimationFrame(() => item.classList.add('is-visible'));
    window.setTimeout(() => {
      item.classList.remove('is-visible');
      window.setTimeout(() => item.remove(), 220);
    }, 2300);
  }

  function setupCommandPalette() {
    // Recreate the launcher whenever PJAX replaces the topbar. The dialog itself is persistent.
    const existingDialog = $('#pall-command-palette');
    if (existingDialog) { ensureSearchTrigger(existingDialog); return; }
    const dialog = document.createElement('div');
    dialog.id = 'pall-command-palette';
    dialog.className = 'pall-palette-backdrop';
    dialog.hidden = true;
    dialog.innerHTML = `
      <section class="pall-palette" role="dialog" aria-modal="true" aria-labelledby="pall-palette-title">
        <div class="pall-palette-heading"><div><span class="pall-mini-label">PALL NAVIGATION</span><h2 id="pall-palette-title">Cari halaman</h2></div><button type="button" class="pall-palette-close" aria-label="Tutup pencarian" title="Tutup">×</button></div>
        <label class="pall-palette-search"><span class="pall-search-icon" aria-hidden="true"></span><input id="pall-palette-input" type="search" placeholder="Cari dashboard, lisensi, perangkat…" autocomplete="off"></label>
        <div id="pall-palette-results" class="pall-palette-results"></div>
        <p class="pall-palette-hint">Pilih halaman untuk membuka</p>
      </section>`;
    document.body.appendChild(dialog);
    const input = $('#pall-palette-input', dialog);
    const results = $('#pall-palette-results', dialog);
    let selected = 0;
    let links = [];

    function collectLinks(query = '') {
      const q = query.trim().toLowerCase();
      links = $$(' .topbar nav a[href]').filter(a => {
        const href = a.getAttribute('href') || '';
        return href.startsWith('/') && !['/logout', '/login'].includes(href.split('?')[0]);
      }).map(a => ({ href: a.href, label: a.textContent.trim().replace(/\s+/g, ' '), path: new URL(a.href, location.origin).pathname }))
        .filter((item, i, arr) => arr.findIndex(x => x.href === item.href) === i)
        .filter(item => !q || (item.label + ' ' + item.path).toLowerCase().includes(q));
      selected = 0;
      results.replaceChildren();
      if (!links.length) {
        const empty = document.createElement('div'); empty.className = 'pall-palette-empty'; empty.textContent = 'Tidak ada halaman yang cocok.'; results.appendChild(empty); return;
      }
      links.forEach((item, index) => {
        const a = document.createElement('a'); a.href = item.href; a.className = 'pall-palette-item';
        a.innerHTML = `<span class="pall-palette-item-icon" aria-hidden="true">↗</span><span class="pall-palette-item-copy"><strong></strong><small></small></span><span class="pall-palette-enter">Enter</span>`;
        $('strong', a).textContent = item.label;
        $('small', a).textContent = item.path;
        a.addEventListener('mouseenter', () => setSelected(index));
        a.addEventListener('click', () => closePalette());
        results.appendChild(a);
      });
      setSelected(0);
    }
    function setSelected(index) {
      const items = $$('.pall-palette-item', results);
      if (!items.length) return;
      selected = (index + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('is-selected', i === selected));
      items[selected].scrollIntoView({ block: 'nearest' });
    }
    function openPalette() { collectLinks(input.value); dialog.hidden = false; document.body.classList.add('pall-palette-open'); input.focus(); }
    function closePalette() { dialog.hidden = true; document.body.classList.remove('pall-palette-open'); }
    $('.pall-palette-close', dialog).addEventListener('click', closePalette);
    input.addEventListener('input', () => collectLinks(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(selected + 1); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(selected - 1); }
      if (event.key === 'Enter' && links[selected]) { event.preventDefault(); location.href = links[selected].href; }
      if (event.key === 'Escape') closePalette();
    });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closePalette(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !dialog.hidden) closePalette();
    });
    dialog.__openPalette = openPalette;
    ensureSearchTrigger(dialog);
  }

  function ensureSearchTrigger(dialog) {
    const topbar = $('.topbar');
    if (!topbar || $('.pall-search-trigger', topbar)) return;
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'pall-search-trigger';
    trigger.setAttribute('aria-label', 'Cari halaman');
    trigger.innerHTML = '<span class="pall-search-icon" aria-hidden="true"></span><span>Cari halaman</span>';
    trigger.addEventListener('click', () => {
      if (dialog.__openPalette) dialog.__openPalette();
      else { dialog.hidden = false; document.body.classList.add('pall-palette-open'); const input = $('#pall-palette-input'); if (input) input.focus(); }
    });
    topbar.appendChild(trigger);
  }

  function csvCell(value) {
    let text = String(value ?? '').replace(/\s+/g, ' ').trim();
    // Prevent spreadsheet formula injection when opening exported CSV files.
    if (/^[=+@\-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function setupTableTools() {
    $$('table').forEach((table, index) => {
      if (table.dataset.pallTools === '1') return;
      const rows = $$('tr', table);
      if (rows.length < 3) return;
      table.dataset.pallTools = '1';
      const toolbar = document.createElement('div'); toolbar.className = 'pall-table-tools';
      const searchWrap = document.createElement('label'); searchWrap.className = 'pall-table-search';
      searchWrap.innerHTML = '<span aria-hidden="true">⌕</span><input type="search" placeholder="Cari di tabel ini…" aria-label="Cari di tabel">';
      const count = document.createElement('span'); count.className = 'pall-table-count';
      const exportBtn = document.createElement('button'); exportBtn.type = 'button'; exportBtn.className = 'pall-export-btn'; exportBtn.textContent = 'Export CSV';
      toolbar.append(searchWrap, count, exportBtn);
      table.parentNode.insertBefore(toolbar, table);
      const input = $('input', searchWrap);
      const dataRows = rows.filter(row => !row.querySelector('th'));
      function applyFilter() {
        const query = input.value.trim().toLowerCase(); let visible = 0;
        dataRows.forEach(row => { const match = row.innerText.toLowerCase().includes(query); row.hidden = !match; if (match) visible++; });
        count.textContent = `${visible} dari ${dataRows.length} baris`;
      }
      input.addEventListener('input', applyFilter);
      applyFilter();
      exportBtn.addEventListener('click', () => {
        const headerRow = rows.find(row => row.querySelector('th'));
        const exportRows = [headerRow, ...dataRows.filter(row => !row.hidden)].filter(Boolean);
        const csv = '\ufeff' + exportRows.map(row => Array.from(row.children).map(cell => csvCell(cell.innerText)).join(',')).join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob); const link = document.createElement('a');
        link.href = url; link.download = `pall-${location.pathname.replace(/\W+/g, '-') || 'data'}-${new Date().toISOString().slice(0,10)}-${index + 1}.csv`;
        document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
        toast('CSV berhasil disiapkan.');
      });
    });
  }

  function setupNotifications() {
    if (!$('.pall-global-sidebar') || $('#pall-notification-launcher')) return;
    const launcher = document.createElement('button');
    launcher.id = 'pall-notification-launcher'; launcher.type = 'button';
    launcher.className = 'pall-notification-launcher'; launcher.setAttribute('aria-label', 'Buka notifikasi');
    launcher.innerHTML = '<span aria-hidden="true">♧</span><i class="pall-notification-count" hidden></i>';
    const popover = document.createElement('section');
    popover.id = 'pall-notification-popover'; popover.className = 'pall-notification-popover'; popover.hidden = true;
    popover.innerHTML = '<header><div><small>PALL 8BP</small><h2>Notifikasi</h2></div><button type="button" class="pall-notification-readall">Tandai semua dibaca</button></header><div class="pall-notification-list"><div class="pall-notification-loading">Memuat notifikasi…</div></div><footer>Notifikasi aktivitas panel yang tercatat di database</footer>';
    document.body.append(launcher, popover);
    const badge = $('.pall-notification-count', launcher);
    const list = $('.pall-notification-list', popover);
    const readAll = $('.pall-notification-readall', popover);
    let loading = false;

    function setUnread(count) {
      const n = Math.max(0, Number(count) || 0);
      badge.hidden = n === 0; badge.textContent = n > 99 ? '99+' : String(n);
      launcher.setAttribute('aria-label', n ? `Notifikasi, ${n} belum dibaca` : 'Buka notifikasi');
    }
    function render(items) {
      list.replaceChildren();
      if (!items.length) {
        const empty = document.createElement('div'); empty.className = 'pall-notification-empty';
        empty.textContent = 'Belum ada notifikasi. Aktivitas penting akan muncul di sini.'; list.appendChild(empty); return;
      }
      items.forEach(item => {
        const row = document.createElement('article'); row.className = 'pall-notification-item' + (item.read_at ? '' : ' is-unread');
        const dot = document.createElement('span'); dot.className = 'pall-notification-dot ' + (item.type || 'info');
        const copy = document.createElement('div'); copy.className = 'pall-notification-copy';
        const title = document.createElement('strong'); title.textContent = item.title || 'Aktivitas panel';
        const message = document.createElement('p'); message.textContent = item.message || '';
        const time = document.createElement('time');
        const date = new Date(item.created_at); time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('id-ID', {dateStyle:'medium',timeStyle:'short'});
        copy.append(title, message, time); row.append(dot, copy);
        if (!item.read_at) {
          const mark = document.createElement('button'); mark.type = 'button'; mark.className = 'pall-notification-mark'; mark.textContent = 'Tandai dibaca'; mark.setAttribute('aria-label','Tandai notifikasi dibaca');
          mark.addEventListener('click', async () => {
            mark.disabled = true;
            try { const r = await fetch(`/notifications/${encodeURIComponent(item.id)}/read`, {method:'POST', headers:{'Accept':'application/json','X-CSRF-Token':csrfToken()}}); if (!r.ok) throw new Error(); await loadFeed(); }
            catch (_) { toast('Notifikasi gagal diperbarui.'); mark.disabled = false; }
          }); row.appendChild(mark);
        }
        list.appendChild(row);
      });
    }
    async function loadFeed() {
      if (loading) return; loading = true;
      try {
        const response = await fetch('/notifications/feed', {headers:{'Accept':'application/json'}, cache:'no-store'});
        if (!response.ok) throw new Error();
        const data = await response.json(); if (!data.ok) throw new Error();
        setUnread(data.unread); render(data.notifications || []);
      } catch (_) {
        list.replaceChildren(); const msg = document.createElement('div'); msg.className = 'pall-notification-empty';
        msg.textContent = 'Notifikasi belum tersedia. Pastikan migrasi database terbaru sudah dijalankan.'; list.appendChild(msg);
      } finally { loading = false; }
    }
    launcher.addEventListener('click', () => { popover.hidden = !popover.hidden; if (!popover.hidden) loadFeed(); });
    readAll.addEventListener('click', async () => {
      readAll.disabled = true;
      try { const r = await fetch('/notifications/read-all', {method:'POST', headers:{'Accept':'application/json','X-CSRF-Token':csrfToken()}}); if (!r.ok) throw new Error(); await loadFeed(); }
      catch (_) { toast('Gagal menandai notifikasi.'); }
      finally { readAll.disabled = false; }
    });
    document.addEventListener('click', event => {
      if (!popover.hidden && !popover.contains(event.target) && !launcher.contains(event.target)) popover.hidden = true;
    });
    loadFeed();
    window.setInterval(() => { if (document.visibilityState === 'visible') loadFeed(); }, 60000);
  }

  function init() {
    markActiveNav(); setupCommandPalette(); setupTableTools(); setupNotifications();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  // PJAX swaps replace page content without a full page load; reapply tools afterward.
  const observer = new MutationObserver(() => { markActiveNav(); setupCommandPalette(); setupTableTools(); setupNotifications(); });
  observer.observe(document.body, { childList: true, subtree: true });
})();
