(function () {
  'use strict';
  var L = window.VTLogic;
  var LS = window.localStorage;
  var K = { name: 'vt.name', cfg: 'vt.cfg', list: 'vt.list', queue: 'vt.queue', recent: 'vt.recent' };
  var REFRESH_MS = 60000, RETRY_MS = 15000, TICK_MS = 20000, FETCH_TIMEOUT = 20000, STALE_MS = 10 * 60000;
  var $ = function (id) { return document.getElementById(id); };

  function load(k, d) { try { var v = LS.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var state = {
    name: load(K.name, ''), cfg: load(K.cfg, null),
    list: load(K.list, { at: 0, vins: [] }), queue: load(K.queue, []), recent: load(K.recent, []),
    matches: [], flushing: false, fetching: false
  };

  /* ---------- toast ---------- */
  var toastTimer;
  function toast(msg, kind, ms) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind || 'ok'); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
    if (kind === 'ok' && navigator.vibrate) navigator.vibrate(40);
  }

  /* ---------- config ---------- */
  function applyHashCfg() {
    if (!/cfg=/.test(location.hash)) return false;
    var c = L.decodeCfg(location.hash);
    history.replaceState(null, '', location.pathname + location.search); // keep key out of URL bar / history
    if (!c) { toast('Setup link is invalid', 'err', 5000); return false; }
    state.cfg = c; save(K.cfg, c);
    state.list = { at: 0, vins: [] }; save(K.list, state.list);
    toast('Setup saved ✓', 'ok');
    return true;
  }

  /* ---------- network ---------- */
  function withTimeout(p, ms, ctl) { var t = setTimeout(function () { ctl.abort(); }, ms); return p.then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; }); }

  function apiGet() {
    var ctl = new AbortController();
    var url = state.cfg.url + (state.cfg.url.indexOf('?') < 0 ? '?' : '&') + 'action=list&key=' + encodeURIComponent(state.cfg.key);
    return withTimeout(fetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctl.signal }), FETCH_TIMEOUT, ctl)
      .then(function (r) { return r.json(); });
  }
  function csvGet() {
    var ctl = new AbortController();
    var u = state.cfg.csv + (state.cfg.csv.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now();
    return withTimeout(fetch(u, { method: 'GET', redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctl.signal }), FETCH_TIMEOUT, ctl)
      .then(function (r) { if (!r.ok) throw new Error('csv'); return r.text(); })
      .then(function (t) { var v = L.parseSheetCsv(t); if (!v.length) throw new Error('csv-empty'); return v; });
  }
  function apiPost(item) {
    var ctl = new AbortController();
    // text/plain avoids a CORS preflight (Apps Script can't answer OPTIONS)
    var body = JSON.stringify({ key: state.cfg.key, name: item.name, digits: item.digits, action: item.action, clientId: item.clientId });
    return withTimeout(fetch(state.cfg.url, { method: 'POST', redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, signal: ctl.signal }), FETCH_TIMEOUT, ctl)
      .then(function (r) { return r.json(); });
  }

  function refreshList(force) {
    if (!state.cfg || state.fetching) return Promise.resolve();
    if (!force && Date.now() - state.list.at < REFRESH_MS - 2000) return Promise.resolve();
    state.fetching = true;
    var scriptErr = '';
    // Prefer the Apps Script list (live). Fall back to the published CSV (read-only, can lag a few minutes).
    return apiGet().then(function (res) {
      if (res && res.ok && Array.isArray(res.vins)) { state.list = { at: Date.now(), vins: res.vins, src: 'script' }; save(K.list, state.list); return true; }
      scriptErr = (res && res.error) || 'Could not load list';
      return false;
    }).catch(function () { scriptErr = 'unreachable'; return false; }).then(function (okScript) {
      if (okScript) return;
      if (!state.cfg.csv) { if (scriptErr && scriptErr !== 'unreachable') toast(scriptErr, 'err', 5000); return; }
      return csvGet().then(function (v) {
        state.list = { at: Date.now(), vins: v, src: 'csv' }; save(K.list, state.list);
      }).catch(function () { if (scriptErr && scriptErr !== 'unreachable') toast(scriptErr, 'err', 5000); });
    }).then(function () { state.fetching = false; render(); });
  }

  /* ---------- queue ---------- */
  function persistQueue() { save(K.queue, state.queue); updatePills(); }
  function setRecent(clientId, patch) {
    state.recent.forEach(function (r) { if (r.clientId === clientId) Object.keys(patch).forEach(function (k) { r[k] = patch[k]; }); });
    save(K.recent, state.recent); renderRecent();
  }
  function patchCachedStatus(vin, status) {
    state.list.vins.forEach(function (e) { if (e.vin === vin) e.status = status; });
    save(K.list, state.list);
  }

  function flush() {
    if (state.flushing || !state.cfg || !state.queue.length) return Promise.resolve();
    state.flushing = true;
    var item = state.queue[0];
    return apiPost(item).then(function (res) {
      if (res && res.ok) {
        state.queue.shift(); persistQueue();
        if (res.vin) patchCachedStatus(res.vin, res.action);
        setRecent(item.clientId, { st: 'ok', vin: res.vin || item.vin, klass: res.klass, dup: !!res.duplicate });
        toast(res.duplicate ? 'Already recorded: ' + (res.vin ? '…' + res.vin.slice(-6) : '') + ' → ' + item.action
          : '✓ ' + item.action + ' — …' + (res.vin || '').slice(-6) + ' (' + (res.klass || '') + ')', res.duplicate ? 'warn' : 'ok');
      } else {
        var err = (res && res.error) || 'Failed';
        if (/busy/i.test(err)) throw new Error('retry');
        state.queue.shift(); persistQueue();
        var many = res && res.matches && res.matches.length > 1;
        setRecent(item.clientId, { st: 'fail', err: err });
        toast('✗ ' + err + (many ? ' (' + res.matches.map(function (m) { return m.vin.slice(-6); }).join(', ') + ')' : ''), 'err', 6000);
      }
    }).catch(function () { /* network error -> stay queued */ })
      .then(function () { state.flushing = false; if (state.queue.length && navigator.onLine !== false && !state._stop) { return flushNextSoon(); } })
      .then(function () { render(); });
  }
  var flushTimer;
  function flushNextSoon() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 400); return Promise.resolve(); }

  /* ---------- submit ---------- */
  function submit(action) {
    if (!state.name) { askName(); return; }
    if (!state.cfg) { openCfg(); return; }
    var digits = L.cleanDigits($('digits').value);
    if (digits.length < 4) return;
    var m = L.matchVins(state.list.vins, digits);
    var lenient = state.list.src === 'csv' && m.length === 0; // backup list may lag: let the server decide
    if (state.list.vins.length && m.length !== 1 && !lenient) { toast(m.length ? m.length + ' cars match — add more digits' : 'No VIN ends with ' + digits, 'err', 4000); return; }
    var item = { clientId: L.uuid(), name: state.name, digits: digits, action: action, ts: Date.now(), vin: m[0] && m[0].vin };
    state.queue.push(item); persistQueue();
    state.recent.unshift({ clientId: item.clientId, digits: digits, vin: item.vin, action: action, ts: item.ts, st: 'pending' });
    state.recent = state.recent.slice(0, 5); save(K.recent, state.recent);
    $('digits').value = ''; onInput(); renderRecent();
    if (navigator.onLine === false) toast('Offline — queued, will send automatically', 'warn');
    flush();
  }

  /* ---------- render ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function render() {
    var d = L.cleanDigits($('digits').value);
    state.matches = L.matchVins(state.list.vins, d);
    var box = $('results'), hint = $('hint');
    var haveList = state.list.vins.length > 0;
    var html = '';
    if (!state.cfg) hint.textContent = 'Setup needed — open the share link or tap ⚙.';
    else if (d.length < 4) hint.textContent = 'Type at least 4 characters.';
    else if (!haveList) hint.textContent = 'List not loaded yet — you can still send; the server will check.';
    else if (!state.matches.length) hint.textContent = 'No VIN ends with ' + d + (state.list.src === 'csv' ? ' in the backup list — you can still send; the server will check.' : '.');
    else if (state.matches.length > 1) hint.textContent = state.matches.length + ' cars match — add more digits.';
    else hint.textContent = state.list.src === 'csv' ? 'Backup list (published sheet) — status may be a few minutes behind.' : '';
    state.matches.slice(0, 6).forEach(function (e) {
      var cd = L.countdown(e.reservation);
      var v = esc(e.vin), n = d.length;
      html += '<div class="card' + (state.matches.length === 1 ? ' sel' : '') + '"><div class="vin">' + v.slice(0, v.length - n) + '<b>' + v.slice(v.length - n) + '</b></div>' +
        '<div class="meta"><span class="tag ' + esc(e.klass) + '">' + esc(e.klass) + '</span><span>' + esc(e.reservation || '—') + '</span>' +
        '<span class="cd ' + cd.state + '">' + esc(cd.text) + '</span></div>' +
        '<div class="status">Status: <b>' + esc(e.status || 'not updated') + '</b></div></div>';
    });
    box.innerHTML = html;
    var canSend = d.length >= 4 && !!state.cfg && (haveList ? (state.matches.length === 1 || (state.list.src === 'csv' && !state.matches.length)) : true);
    Array.prototype.forEach.call(document.querySelectorAll('.act'), function (b) { b.disabled = !canSend; });
    $('nameBtn').textContent = state.name || 'set name';
    var age = state.list.at ? Math.max(0, Math.round((Date.now() - state.list.at) / 1000)) : null;
    $('listAge').textContent = age == null ? 'List: not loaded' : 'List updated ' + (age < 90 ? age + 's' : Math.round(age / 60) + 'm') + ' ago · ' + state.list.vins.length + ' VINs' + (state.list.src === 'csv' ? ' · BACKUP LIST (may lag a few min)' : '');
    updatePills();
  }

  function renderRecent() {
    var ul = $('recent');
    if (!state.recent.length) { ul.innerHTML = '<li class="muted">Nothing yet.</li>'; return; }
    ul.innerHTML = state.recent.map(function (r) {
      var label = r.vin ? '…' + esc(r.vin.slice(-6)) : esc(r.digits);
      var st = r.st === 'ok' ? '<span class="st-ok">✓ sent' + (r.dup ? ' (dup)' : '') + '</span>' : r.st === 'fail' ? '<span class="st-fail">✗ ' + esc(r.err || 'failed') + '</span>' : '<span class="st-pending">⏳ queued</span>';
      var tm = new Date(r.ts).toLocaleTimeString('en-US', { timeZone: L.TZ, hour: 'numeric', minute: '2-digit' });
      return '<li><span><span class="v">' + label + '</span> · <b>' + esc(r.action) + '</b> <span class="muted">' + tm + '</span></span>' + st + '</li>';
    }).join('');
  }

  function updatePills() {
    var q = $('queuePill'), n = $('netPill');
    q.hidden = !state.queue.length; q.textContent = state.queue.length + ' queued';
    var off = navigator.onLine === false;
    n.hidden = !off; n.textContent = 'offline'; n.className = 'pill bad';
  }

  /* ---------- dialogs ---------- */
  function showDlg(d) { if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); } }
  function closeDlg(d) { if (d.open) { if (d.close) d.close(); else d.removeAttribute('open'); } }
  function askName() { $('nameInput').value = state.name || ''; showDlg($('nameDlg')); setTimeout(function () { $('nameInput').focus(); }, 50); }
  function openCfg() { $('cfgErr').hidden = true; $('cfgLink').value = ''; $('cfgUrl').value = state.cfg ? state.cfg.url : ''; $('cfgKey').value = ''; showDlg($('cfgDlg')); }

  $('nameForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('nameInput').value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!v) return;
    state.name = v; save(K.name, v); closeDlg($('nameDlg')); render();
    if (!state.cfg) openCfg(); else $('digits').focus();
  });
  $('cfgForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('cfgErr'), c = null;
    var link = $('cfgLink').value.trim(), url = $('cfgUrl').value.trim(), key = $('cfgKey').value.trim();
    if (link) c = L.decodeCfg(link);
    else if (url && (key || state.cfg)) {
      if (/^https:\/\//.test(url)) c = { url: url, key: key || state.cfg.key, csv: (state.cfg && state.cfg.csv) || '' };
    }
    if (!c) { err.textContent = 'Could not read that. Paste the full share link, or an https:// URL plus key.'; err.hidden = false; return; }
    state.cfg = c; save(K.cfg, c); state.list = { at: 0, vins: [] }; save(K.list, state.list);
    closeDlg($('cfgDlg')); render(); refreshList(true); flush(); toast('Setup saved ✓', 'ok');
  });
  $('cfgCancel').addEventListener('click', function () { closeDlg($('cfgDlg')); });
  $('nameBtn').addEventListener('click', askName);
  $('menuBtn').addEventListener('click', function () { showDlg($('menuDlg')); });
  $('menuClose').addEventListener('click', function () { closeDlg($('menuDlg')); });
  $('chgName').addEventListener('click', function () { closeDlg($('menuDlg')); askName(); });
  $('chgCfg').addEventListener('click', function () { closeDlg($('menuDlg')); openCfg(); });
  $('clearHist').addEventListener('click', function () { state.recent = []; save(K.recent, []); renderRecent(); closeDlg($('menuDlg')); });
  $('refreshBtn').addEventListener('click', function () { refreshList(true).then(function () { toast('List refreshed', 'ok', 1500); }); });
  $('kbBtn').addEventListener('click', function () {
    var i = $('digits'), num = i.inputMode === 'numeric';
    i.inputMode = num ? 'text' : 'numeric'; $('kbBtn').textContent = num ? '123' : 'ABC'; i.focus();
  });

  function onInput() {
    var i = $('digits'), c = L.cleanDigits(i.value);
    if (i.value !== c) i.value = c;
    render();
  }
  $('digits').addEventListener('input', onInput);
  $('digits').addEventListener('keydown', function (e) { if (e.key === 'Enter') e.target.blur(); });
  $('actions').addEventListener('click', function (e) {
    var b = e.target.closest('.act'); if (b && !b.disabled) submit(b.getAttribute('data-action'));
  });

  window.addEventListener('online', function () { updatePills(); refreshList(true); flush(); });
  window.addEventListener('offline', updatePills);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { refreshList(false); flush(); render(); } });

  /* ---------- boot ---------- */
  applyHashCfg();
  window.addEventListener('hashchange', function () { if (applyHashCfg()) { refreshList(true); render(); } });
  $('ver').textContent = 'Times shown in America/Chicago. Config stays on this device.';
  renderRecent(); render();
  if (!state.name) askName(); else if (!state.cfg) openCfg();
  refreshList(true); flush();
  setInterval(function () { refreshList(true); }, REFRESH_MS);
  setInterval(function () { flush(); }, RETRY_MS);
  setInterval(render, TICK_MS);

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
