/**
 * VIN Tracker backend — Google Apps Script bound to the fleet Google Sheet.
 *
 * Web app: Execute as = Me (owner), Who has access = Anyone with the link.
 * Protected by a shared secret kept in Script Properties ('API_KEY'). Never hard-code it.
 *
 *   GET  ?action=list&key=...                       -> all VINs with class, reservation, status
 *   POST {key,name,digits,action,clientId} (JSON)   -> set one VIN's status + append to 'Log'
 *
 * Sheet menu (added by onOpen):  Fleet Tracker > Set up | Set API key
 */

var SHEET_NAME = 'Reservation Sort';
var LOG_SHEET_NAME = 'Log';
var TZ = 'America/Chicago';
var FIRST_DATA_ROW = 4;
var NUM_COLS = 7;
var STATUSES = ['Picked Up', 'Shop', 'Charger', 'SP'];
var GROUPS = [
  { klass: 'Prod', vinCol: 2, statusCol: 3 },
  { klass: 'CC',   vinCol: 4, statusCol: 5 },
  { klass: 'Dev',  vinCol: 6, statusCol: 7 }
];
var LOG_HEADERS = ['Timestamp CT', 'Name', 'Digits', 'Full VIN', 'Class', 'Action', 'Reservation time', 'ClientId'];
var DEDUPE_SECONDS = 20;
var LOG_SCAN_ROWS = 500;
var SUMMARY_TITLE = 'Status Summary';
var NOTE_PREFIX = 'Use each Status';
var NOTE_TEXT = 'Use each Status dropdown to mark Picked Up, Shop, Charger or SP. Blank = not yet updated.';

/* ------------------------------------------------------------------ *
 * Menu + setup helpers (run from the sheet)
 * ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fleet Tracker')
    .addItem('Set up', 'setupSheet')
    .addItem('Set API key', 'Setup')
    .addToUi();
}

/** Prompts for the shared secret and stores it in Script Properties. Never logs or echoes it. */
function Setup() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Fleet Tracker — API key',
    'Enter the shared secret (at least 12 characters). It is stored in Script Properties only.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var key = String(res.getResponseText() || '').trim();
  if (key.length < 12) {
    ui.alert('Key too short — use at least 12 characters. Nothing was saved.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('API_KEY', key);
  ui.alert('API key saved. (It is not shown anywhere; keep your own copy for the share link.)');
}

/**
 * Menu: Fleet Tracker > Set up
 *  1. Status columns (C, E, G): data validation = Picked Up / Shop / Charger / SP (blank allowed),
 *     applied to every row that has a VIN in the matching VIN column.
 *  2. Rewrites the Status Summary block (see README for layout).
 *  3. Creates the 'Log' tab if missing and refreshes the footer note.
 * Existing cell values are never changed (old "Dropped Off" values stay but are flagged invalid).
 */
function setupSheet() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { SpreadsheetApp.getUi().alert('Tab "' + SHEET_NAME + '" not found.'); return; }
  var values = readDisplay_(sheet);
  var layout = findLayout_(values);
  var firstRow = FIRST_DATA_ROW;
  var lastRow = layout.lastDataRow;

  // 1. validation
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true)
    .setAllowInvalid(false)
    .setHelpText('Picked Up, Shop, Charger or SP (blank = not yet updated)')
    .build();
  var legacy = 0;
  GROUPS.forEach(function (g) {
    var full = sheet.getRange(firstRow, g.statusCol, lastRow - firstRow + 1, 1);
    full.clearDataValidations();
    var ranges = [];
    for (var r = firstRow; r <= lastRow; r++) {
      var vin = values[r - firstRow] ? values[r - firstRow][g.vinCol - 1] : '';
      if (isVin_(vin)) {
        ranges.push(sheet.getRange(r, g.statusCol).getA1Notation());
        var s = String(values[r - firstRow][g.statusCol - 1] || '').trim();
        if (s && STATUSES.indexOf(s) < 0) legacy++;
      }
    }
    if (ranges.length) sheet.getRangeList(ranges).setDataValidation(rule);
  });

  // 2. summary
  var s = buildSummary_(layout.summaryRow, firstRow, layout.summaryDataEnd);
  var clearRows = Math.max(1, Math.min(12, sheet.getMaxRows() - layout.summaryRow + 1));
  if (sheet.getMaxRows() < layout.summaryRow + s.rows.length - 1) sheet.insertRowsAfter(sheet.getMaxRows(), layout.summaryRow + s.rows.length - 1 - sheet.getMaxRows());
  sheet.getRange(layout.summaryRow, 1, clearRows, 8).clearContent().clearFormat();
  sheet.getRange(s.row, 1, s.rows.length, s.rows[0].length).setFormulas(s.rows);
  sheet.getRange(s.row, 1, 1, s.rows[0].length).setFontWeight('bold').setBackground('#d9e2f3');
  sheet.getRange(s.row + s.rows.length - 1, 1, 1, s.rows[0].length).setFontWeight('bold');
  sheet.getRange(s.row, 1, s.rows.length, 1).setFontWeight('bold');
  if (layout.noteRow) sheet.getRange(layout.noteRow, 1).setValue(NOTE_TEXT);

  // 3. log tab
  getLogSheet_(ss);

  var msg = 'Set up complete.\n\n• Status dropdowns: ' + STATUSES.join(' / ') + ' (rows ' + firstRow + '–' + lastRow + ')\n' +
    '• Status Summary rewritten at row ' + layout.summaryRow + '\n• "' + LOG_SHEET_NAME + '" tab ready';
  if (legacy) msg += '\n\nNote: ' + legacy + ' cell(s) still hold an old value (e.g. "Dropped Off"). They were left as-is; change them to a new status.';
  SpreadsheetApp.getUi().alert(msg);
}

/* ------------------------------------------------------------------ *
 * Pure functions (unit-tested in test/code.test.js via a vm sandbox)
 * ------------------------------------------------------------------ */

function isVin_(v) {
  return /^[A-Za-z0-9]{11,17}$/.test(String(v || '').trim());
}

function normalizeSpaces_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** Where the data block ends and where the note / summary live (values = display values from row FIRST_DATA_ROW down). */
function findLayout_(values) {
  var noteRow = 0, summaryRow = 0, stop = values.length;
  for (var i = 0; i < values.length; i++) {
    var a = normalizeSpaces_(values[i][0]);
    if (!noteRow && a.indexOf(NOTE_PREFIX) === 0) noteRow = FIRST_DATA_ROW + i;
    if (!summaryRow && a === SUMMARY_TITLE) summaryRow = FIRST_DATA_ROW + i;
  }
  var firstStop = [noteRow, summaryRow].filter(function (n) { return n > 0; });
  if (firstStop.length) stop = Math.min.apply(null, firstStop) - FIRST_DATA_ROW;
  var lastVin = 0;
  for (var j = 0; j < stop; j++) {
    for (var g = 0; g < GROUPS.length; g++) {
      if (isVin_(values[j][GROUPS[g].vinCol - 1])) lastVin = j + 1;
    }
  }
  var lastDataRow = FIRST_DATA_ROW + Math.max(lastVin, 1) - 1;
  // formulas cover the data block incl. the blank spacer rows before the note (as the old sheet did)
  var summaryDataEnd = noteRow ? Math.max(lastDataRow, noteRow - 2) : lastDataRow;
  if (!summaryRow) summaryRow = noteRow ? noteRow + 2 : lastDataRow + 3;
  return { lastDataRow: lastDataRow, noteRow: noteRow, summaryRow: summaryRow, summaryDataEnd: summaryDataEnd };
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Summary layout (columns A..E):
 *   Status Summary | Prod | CC | Dev | Total
 *   Picked Up / Shop / Charger / SP   -> COUNTIF per status column
 *   Blank (not updated)               -> VINs whose status cell is empty
 *   Total VINs                        -> COUNTA of VIN column
 * Returns { row, rows: [[formula/text,...],...] } ready for setFormulas.
 */
function buildSummary_(summaryRow, firstRow, endRow) {
  var rows = [];
  rows.push([SUMMARY_TITLE, 'Prod', 'CC', 'Dev', 'Total']);
  var first = summaryRow + 1;
  STATUSES.forEach(function (st, idx) {
    var r = summaryRow + 1 + idx;
    var row = [st];
    GROUPS.forEach(function (g) {
      var c = colLetter_(g.statusCol);
      row.push('=COUNTIF(' + c + firstRow + ':' + c + endRow + ',"' + st + '")');
    });
    row.push('=SUM(B' + r + ':D' + r + ')');
    rows.push(row);
  });
  var blankRow = summaryRow + 1 + STATUSES.length;
  var blank = ['Blank (not updated)'];
  GROUPS.forEach(function (g) {
    var v = colLetter_(g.vinCol), c = colLetter_(g.statusCol);
    blank.push('=SUMPRODUCT((' + v + firstRow + ':' + v + endRow + '<>"")*(' + c + firstRow + ':' + c + endRow + '=""))');
  });
  blank.push('=SUM(B' + blankRow + ':D' + blankRow + ')');
  rows.push(blank);
  var total = ['Total VINs'];
  GROUPS.forEach(function (g) {
    var v = colLetter_(g.vinCol);
    total.push('=COUNTA(' + v + firstRow + ':' + v + endRow + ')');
  });
  total.push('=SUM(B' + (blankRow + 1) + ':D' + (blankRow + 1) + ')');
  rows.push(total);
  return { row: summaryRow, rows: rows };
}

/** values: 2D display values starting at FIRST_DATA_ROW. Returns [{row, col, vin, klass, reservation, status}] */
function parseSheet_(values) {
  var out = [];
  var reservation = '';
  for (var i = 0; i < values.length; i++) {
    var rowVals = values[i];
    var a = normalizeSpaces_(rowVals[0]);
    if (a.indexOf(NOTE_PREFIX) === 0 || a === SUMMARY_TITLE) break;
    if (a) reservation = a;
    for (var g = 0; g < GROUPS.length; g++) {
      var vin = String(rowVals[GROUPS[g].vinCol - 1] || '').trim();
      if (!isVin_(vin)) continue;
      out.push({
        row: FIRST_DATA_ROW + i,
        col: GROUPS[g].statusCol,
        vin: vin.toUpperCase(),
        klass: GROUPS[g].klass,
        reservation: reservation,
        status: normalizeSpaces_(rowVals[GROUPS[g].statusCol - 1])
      });
    }
  }
  return out;
}

function findMatches_(entries, digits) {
  var d = String(digits || '').toUpperCase();
  return entries.filter(function (e) { return d.length > 0 && e.vin.slice(-d.length) === d; });
}

function validateRequest_(body) {
  if (!body || typeof body !== 'object') return 'Bad request';
  var name = normalizeSpaces_(body.name);
  if (!name || name.length > 40) return 'Name required (max 40 chars)';
  if (!/^[A-Za-z0-9]{4,6}$/.test(String(body.digits == null ? '' : body.digits))) return 'Digits must be 4-6 letters/numbers';
  if (STATUSES.indexOf(body.action) < 0) return 'Unknown action';
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(body.clientId || ''))) return 'clientId required';
  return '';
}

/** Stop spreadsheet formula injection in free-text fields. */
function safeText_(s) {
  var t = normalizeSpaces_(s);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}

function publicEntry_(e) {
  return { vin: e.vin, klass: e.klass, reservation: e.reservation, status: e.status };
}

/**
 * Core write logic with injected I/O so it can be tested with a mock.
 * io: { now():ms, nowText():string, getValues():2D, setStatus(row,col,val), appendLog(arr),
 *       cacheGet(k), cachePut(k,v,ttlSec), findLoggedClient(id):{...}|null }
 */
function processAction_(body, io) {
  var err = validateRequest_(body);
  if (err) return { ok: false, error: err, matches: [] };
  var digits = String(body.digits).toUpperCase();
  var name = safeText_(body.name);

  // dedupe 1: clientId (cache, then log)
  var cached = io.cacheGet('cid:' + body.clientId);
  if (cached) { var c = JSON.parse(cached); c.duplicate = true; return c; }
  var logged = io.findLoggedClient(body.clientId);
  if (logged) return { ok: true, duplicate: true, vin: logged.vin, klass: logged.klass, action: logged.action, reservation: logged.reservation, status: logged.action };

  var entries = parseSheet_(io.getValues());
  var matches = findMatches_(entries, digits);
  if (matches.length === 0) return { ok: false, error: 'No VIN ends with ' + digits, matches: [] };
  if (matches.length > 1) return { ok: false, error: matches.length + ' VINs end with ' + digits + ' — enter more digits', matches: matches.map(publicEntry_) };
  var m = matches[0];

  // dedupe 2: same vin + action within 20 s (any client)
  var vaKey = 'va:' + m.vin + '|' + body.action;
  var prev = io.cacheGet(vaKey);
  if (prev && io.now() - Number(prev) < DEDUPE_SECONDS * 1000) {
    return { ok: true, duplicate: true, vin: m.vin, klass: m.klass, action: body.action, reservation: m.reservation, status: body.action };
  }

  io.setStatus(m.row, m.col, body.action);
  io.appendLog([io.nowText(), name, digits, m.vin, m.klass, body.action, m.reservation, body.clientId]);
  var result = { ok: true, vin: m.vin, klass: m.klass, action: body.action, reservation: m.reservation, status: body.action };
  io.cachePut(vaKey, String(io.now()), 60);
  io.cachePut('cid:' + body.clientId, JSON.stringify(result), 21600);
  return result;
}

/** Constant-time string compare. */
function safeEqual_(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function checkKey_(provided, stored) {
  if (!stored) return 'Server not configured (run Fleet Tracker > Set API key)';
  if (!safeEqual_(provided, stored)) return 'Unauthorized';
  return '';
}

/* ------------------------------------------------------------------ *
 * Sheet access
 * ------------------------------------------------------------------ */

function readDisplay_(sheet) {
  var n = Math.max(sheet.getLastRow() - FIRST_DATA_ROW + 1, 1);
  return sheet.getRange(FIRST_DATA_ROW, 1, n, NUM_COLS).getDisplayValues();
}

function getLogSheet_(ss) {
  var sh = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET_NAME);
    sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@'); // keep leading zeros in Digits
  }
  return sh;
}

function realIo_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAME);
  var cache = CacheService.getScriptCache();
  return {
    now: function () { return Date.now(); },
    nowText: function () { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); },
    getValues: function () { return readDisplay_(sheet); },
    setStatus: function (row, col, val) { sheet.getRange(row, col).setValue(val); },
    appendLog: function (arr) {
      var log = getLogSheet_(ss);
      var r = log.getLastRow() + 1;
      log.getRange(r, 3).setNumberFormat('@');
      log.getRange(r, 1, 1, arr.length).setValues([arr.map(String)]);
    },
    cacheGet: function (k) { return cache.get(k); },
    cachePut: function (k, v, ttl) { cache.put(k, v, ttl); },
    findLoggedClient: function (id) {
      var log = ss.getSheetByName(LOG_SHEET_NAME);
      if (!log) return null;
      var last = log.getLastRow();
      if (last < 2) return null;
      var start = Math.max(2, last - LOG_SCAN_ROWS + 1);
      var rows = log.getRange(start, 1, last - start + 1, LOG_HEADERS.length).getValues();
      for (var i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][7]) === id) return { vin: rows[i][3], klass: rows[i][4], action: rows[i][5], reservation: rows[i][6] };
      }
      return null;
    }
  };
}

/* ------------------------------------------------------------------ *
 * Web app
 * ------------------------------------------------------------------ */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var bad = checkKey_(p.key, PropertiesService.getScriptProperties().getProperty('API_KEY'));
    if (bad) return json_({ ok: false, error: bad });
    if (p.action !== 'list') return json_({ ok: false, error: 'Unknown action' });
    var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    var entries = parseSheet_(readDisplay_(sheet)).map(publicEntry_);
    return json_({ ok: true, generatedAt: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"), vins: entries });
  } catch (err) {
    return json_({ ok: false, error: 'Server error' });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body;
    try { body = JSON.parse((e && e.postData && e.postData.contents) || ''); }
    catch (x) { return json_({ ok: false, error: 'Bad JSON', matches: [] }); }
    var bad = checkKey_(body && body.key, PropertiesService.getScriptProperties().getProperty('API_KEY'));
    if (bad) return json_({ ok: false, error: bad, matches: [] });
    lock.waitLock(20000);
    var result = processAction_(body, realIo_(SpreadsheetApp.getActive()));
    SpreadsheetApp.flush();
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: 'Server busy or error — try again', matches: [] });
  } finally {
    try { lock.releaseLock(); } catch (y) {}
  }
}
