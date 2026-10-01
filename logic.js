/* Pure logic (no DOM) — shared by the app and the node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VTLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var TZ = 'America/Chicago';
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /** Keep only letters/digits, uppercase, max 6. */
  function cleanDigits(s) {
    return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
  }

  /** Entries whose VIN ends with `digits` (case-insensitive). Needs 4-6 chars. */
  function matchVins(list, digits) {
    var d = cleanDigits(digits);
    if (d.length < 4) return [];
    return (list || []).filter(function (e) {
      return String(e.vin || '').toUpperCase().slice(-d.length) === d;
    });
  }

  var dtfCache = {};
  function dtf() {
    return dtfCache.f || (dtfCache.f = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'
    }));
  }

  /** Wall-clock parts in America/Chicago for a UTC ms timestamp. */
  function chicagoParts(ms) {
    var o = {};
    dtf().formatToParts(new Date(ms)).forEach(function (p) { if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10); });
    if (o.hour === 24) o.hour = 0;
    return o;
  }

  /** Offset (ms) of Chicago vs UTC at a given instant (negative, -5h CDT / -6h CST). */
  function chicagoOffset(ms) {
    var p = chicagoParts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }

  /** Convert a Chicago wall-clock time to a UTC ms timestamp (handles DST). */
  function chicagoWallToUtc(y, mo, d, h, mi) {
    var guess = Date.UTC(y, mo - 1, d, h, mi);
    var utc = guess - chicagoOffset(guess);
    utc = guess - chicagoOffset(utc); // second pass settles DST edges
    return utc;
  }

  /**
   * Parse 'Thu 10/01 4:00 AM' (any spacing) as America/Chicago. Year is inferred from `nowMs`:
   * candidates last/this/next year; prefer the one whose weekday matches, then nearest to now.
   * Returns UTC ms, or null for 'No Reservation' / unparseable text.
   */
  function parseReservation(str, nowMs) {
    var m = /^\s*(?:([A-Za-z]{3})[a-z]*\.?,?\s+)?(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?\s*$/.exec(String(str || ''));
    if (!m) return null;
    var wd = m[1] ? DOW.indexOf(m[1].charAt(0).toUpperCase() + m[1].slice(1, 3).toLowerCase()) : -1;
    var mo = +m[2], d = +m[3], h = +m[4] % 12, mi = +m[5];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || +m[4] < 1 || +m[4] > 12 || mi > 59) return null;
    if (m[6].toLowerCase() === 'p') h += 12;
    var now = nowMs == null ? Date.now() : nowMs;
    var cy = chicagoParts(now).year;
    var best = null;
    [cy - 1, cy, cy + 1].forEach(function (y) {
      var probe = new Date(Date.UTC(y, mo - 1, d));
      if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return; // e.g. 2/29 in a non-leap year
      var ok = wd < 0 || probe.getUTCDay() === wd;
      var t = chicagoWallToUtc(y, mo, d, h, mi);
      var score = (ok ? 0 : 1e15) + Math.abs(t - now);
      if (!best || score < best.score) best = { t: t, score: score };
    });
    return best ? best.t : null;
  }

  function fmtDur(ms) {
    var mins = Math.round(Math.abs(ms) / 60000);
    var d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  /** {text, state:'none'|'upcoming'|'soon'|'overdue'} */
  function countdown(reservationStr, nowMs) {
    var t = parseReservation(reservationStr, nowMs);
    if (t == null) return { text: /no reservation/i.test(reservationStr || '') ? 'No reservation' : '', state: 'none' };
    var diff = t - (nowMs == null ? Date.now() : nowMs);
    if (diff <= -30000) return { text: 'overdue ' + fmtDur(diff), state: 'overdue' };
    if (diff < 60000) return { text: 'due now', state: 'soon' };
    return { text: 'due in ' + fmtDur(diff), state: diff < 3600000 ? 'soon' : 'upcoming' };
  }

  /** Accepts a full share link, '#cfg=...', 'cfg=...' or raw base64url. Returns {url,key} or null. */
  function decodeCfg(input) {
    var s = String(input || '').trim();
    var i = s.indexOf('cfg=');
    if (i >= 0) s = s.slice(i + 4);
    s = s.replace(/^#/, '').replace(/&.*$/, '');
    if (!s) return null;
    try {
      s = s.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      var bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
      var json = decodeURIComponent(Array.prototype.map.call(bin, function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
      var o = JSON.parse(json);
      var url = o.u || o.url, key = o.k || o.key, csv = o.c || o.csv || '';
      if (typeof url !== 'string' || typeof key !== 'string' || !/^https:\/\//.test(url) || !key) return null;
      if (typeof csv !== 'string' || (csv && !/^https:\/\//.test(csv))) csv = '';
      return { url: url, key: key, csv: csv };
    } catch (e) { return null; }
  }

  /** Minimal RFC-4180 CSV parser -> array of rows. */
  function parseCsv(text) {
    var rows = [], row = [], f = '', q = false, s = String(text || '').replace(/^\uFEFF/, '');
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  /**
   * Published-CSV fallback: same layout as the sheet (header row 'Reservation Time (CT)', then
   * Prod VIN/Status, CC VIN/Status, Dev VIN/Status). Carries the reservation time down; stops at the
   * footer note / Status Summary. Returns [{vin, klass, reservation, status}].
   */
  function parseSheetCsv(text) {
    var rows = parseCsv(text), out = [], res = '', started = false;
    var groups = [['Prod', 1, 2], ['CC', 3, 4], ['Dev', 5, 6]];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], a = String(r[0] || '').replace(/\s+/g, ' ').trim();
      if (!started) { if (/^reservation time/i.test(a)) started = true; continue; }
      if (/^use each status/i.test(a) || /^status summary$/i.test(a)) break;
      if (a) res = a;
      groups.forEach(function (g) {
        var vin = String(r[g[1]] || '').trim().toUpperCase();
        if (/^[A-Z0-9]{11,17}$/.test(vin)) out.push({ vin: vin, klass: g[0], reservation: res, status: String(r[g[2]] || '').replace(/\s+/g, ' ').trim() });
      });
    }
    return out;
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); (typeof crypto !== 'undefined' ? crypto : require('crypto').webcrypto).getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  return { TZ: TZ, cleanDigits: cleanDigits, matchVins: matchVins, chicagoParts: chicagoParts, chicagoWallToUtc: chicagoWallToUtc,
    parseReservation: parseReservation, countdown: countdown, fmtDur: fmtDur, decodeCfg: decodeCfg, parseCsv: parseCsv, parseSheetCsv: parseSheetCsv, uuid: uuid };
});
