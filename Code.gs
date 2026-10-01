/**
 * VIN Tracker backend — Google Apps Script bound to the fleet Google Sheet.
 *
 * Web app: Execute as = Me (owner), Who has access = Anyone with the link.
 * Protected by a shared secret kept in Script Properties ('API_KEY'). Never hard-code it.
 *
 *   GET  ?action=list&key=...                       -> all VINs with class, reservation, status
 *   POST {key,name,digits,action,clientId} (JSON)   -> set one VIN's status + append to 'Log'
 *
 * Sheet menu (added by onOpen):  Fleet Tracker > Set up | New shift | Set API key
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
// 'Shift' is column 9, appended AFTER the original 8 so old rows/columns keep their positions.
var LOG_HEADERS = ['Timestamp CT', 'Name', 'Digits', 'Full VIN', 'Class', 'Action', 'Reservation time', 'ClientId', 'Shift'];
var LOG_CLIENT_COL = 8;   // ClientId (1-based) - used for duplicate lookup
var LOG_SHIFT_COL = 9;    // Shift date (yyyy-MM-dd, stored as text)
var SHIFT_LOG_CUTOFF_HOUR = 6;      // Log: a timestamp before 06:00 CT belongs to the previous calendar date
var SHIFT_START_HOUR = 22;          // Archive: shifts start at 10 pm CT
var ARCHIVE_PREFIX = 'Archive ';
// 'Completed' tab: a VIN set to SP (returned to San Pedro) is listed here; a later non-SP status removes it.
var COMPLETED_SHEET_NAME = 'Completed';
var COMPLETED_HEADERS = ['VIN', 'Class', 'Reservation time', 'Moved by', 'Time completed CT'];
var COMPLETED_STATUS = 'SP';
var GREEN = '#b7e1cd';
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
    .addItem('New shift', 'newShift')
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
  var res = applySetup_(ss);
  SpreadsheetApp.getUi().alert(res.error || res.message);
}

/**
 * The Set up logic (validation + summary + Log tab), shared by "Set up" and "New shift".
 * Returns { message } or { error }. Does not show any UI itself.
 */
function applySetup_(ss) {
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return { error: 'Tab "' + SHEET_NAME + '" not found.' };
  var values = readDisplay_(sheet);
  var layout = findLayout_(values);
  var firstRow = FIRST_DATA_ROW;
  var lastRow = layout.lastDataRow;

  // 1. validation (set per cell: RangeList has no setDataValidation)
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
        ranges.push(sheet.getRange(r, g.statusCol));
        var s = String(values[r - firstRow][g.statusCol - 1] || '').trim();
        if (s && STATUSES.indexOf(s) < 0) legacy++;
      }
    }
    ranges.forEach(function (cell) { cell.setDataValidation(rule); });
  });

  // 1b. green highlight (VIN + status cell) while status = SP, and make sure the Completed tab exists
  applyCompletedFormatting_(sheet, lastRow);
  getCompletedSheet_(ss);

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

  // 3. log tab (create or migrate: adds the Shift column, back-fills old rows)
  getLogSheet_(ss, true);

  var msg = 'Set up complete.\n\n• Status dropdowns: ' + STATUSES.join(' / ') + ' (rows ' + firstRow + '–' + lastRow + ')\n' +
    '• Status Summary rewritten at row ' + layout.summaryRow + '\n• SP rows highlighted green; "' + COMPLETED_SHEET_NAME + '" tab ready\n• "' + LOG_SHEET_NAME + '" tab ready';
  if (legacy) msg += '\n\nNote: ' + legacy + ' cell(s) still hold an old value (e.g. "Dropped Off"). They were left as-is; change them to a new status.';
  return { message: msg };
}

/**
 * Menu: Fleet Tracker > New shift  (run AFTER the shift ends)
 *  1. Asks YES/NO.
 *  2. Copies 'Reservation Sort' to a new tab 'Archive yyyy-MM-dd' (date the 10 pm shift started, CT;
 *     ' (2)', ' (3)'... appended if the name exists). Aborts, changing nothing, if the copy fails.
 *  3. Clears ONLY the Status cells (columns C, E, G) of the live tab. VINs, reservations, the Log tab
 *     and everything else are left alone.
 *  4. Re-runs the Set up logic (dropdowns + summary).
 */
function newShift() {
  var ss = SpreadsheetApp.getActive();
  var ui = SpreadsheetApp.getUi();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { ui.alert('Tab "' + SHEET_NAME + '" not found.'); return; }

  var nowText = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  var existing = ss.getSheets().map(function (sh) { return sh.getName(); });
  var archiveName = uniqueName_(ARCHIVE_PREFIX + archiveDateFromText_(nowText), existing);

  var answer = ui.alert('Start new shift?',
    'This will:\n' +
    '1. Copy "' + SHEET_NAME + '" to a new tab "' + archiveName + '"\n' +
    '2. Copy the "' + COMPLETED_SHEET_NAME + '" tab to "' + archiveName + ' ' + COMPLETED_SHEET_NAME + '" and empty it\n' +
    '3. Clear ALL Status cells (Prod / CC / Dev) on "' + SHEET_NAME + '"\n' +
    '4. Re-run Set up (dropdowns, green SP highlight, summary)\n\n' +
    'VINs, reservations and the "' + LOG_SHEET_NAME + '" tab are NOT changed.',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    ui.alert('The tracker is busy right now. Nothing was changed — try again in a moment.');
    return;
  }
  try {
    // 2. archive first; never clear unless the copy is confirmed (name re-checked now that we hold the lock)
    archiveName = uniqueName_(ARCHIVE_PREFIX + archiveDateFromText_(nowText), ss.getSheets().map(function (sh) { return sh.getName(); }));
    var copy = sheet.copyTo(ss);
    copy.setName(archiveName);
    var check = ss.getSheetByName(archiveName);
    if (!check) throw new Error('archive tab missing after copy');

    SpreadsheetApp.flush();
    // freeze the archive's summary block to values (its formulas would otherwise follow the live Completed tab)
    var arch = findLayout_(readDisplay_(copy));
    var sumRows = Math.min(buildSummary_(arch.summaryRow, FIRST_DATA_ROW, arch.summaryDataEnd).rows.length, copy.getMaxRows() - arch.summaryRow + 1);
    if (sumRows > 0) { var sumRng = copy.getRange(arch.summaryRow, 1, sumRows, 5); sumRng.setValues(sumRng.getValues()); }

    // 2b. archive + empty the Completed tab (header row stays)
    var completedArchive = '';
    var comp = ss.getSheetByName(COMPLETED_SHEET_NAME);
    if (comp && comp.getLastRow() > 1) {
      completedArchive = uniqueName_(archiveName + ' ' + COMPLETED_SHEET_NAME, ss.getSheets().map(function (sh) { return sh.getName(); }));
      var compCopy = comp.copyTo(ss);
      compCopy.setName(completedArchive);
      if (!ss.getSheetByName(completedArchive)) throw new Error('Completed archive tab missing after copy');
    }

    // 3. clear only the status cells
    var layout = findLayout_(readDisplay_(sheet));
    var cleared = 0;
    statusClearRanges_(layout).forEach(function (r) {
      sheet.getRange(r.row, r.col, r.numRows, 1).clearContent();
      cleared += r.numRows;
    });

    if (completedArchive) {
      comp.getRange(2, 1, comp.getLastRow() - 1, COMPLETED_HEADERS.length).clearContent().clearFormat();
    }

    // 4. set up again
    var res = applySetup_(ss);
    SpreadsheetApp.flush();
    ui.alert(res.error ||
      ('New shift ready.\n\n• Archived to tab "' + archiveName + '"\n' + (completedArchive ? '• Completed list archived to "' + completedArchive + '" and emptied\n' : '• Completed list was empty\n') + '• Status cells cleared on "' + SHEET_NAME + '" (' +
       cleared + ' cells in rows ' + FIRST_DATA_ROW + '–' + layout.lastDataRow + ')\n• VINs and Log tab untouched\n\n' + res.message));
  } catch (err) {
    ui.alert('New shift failed: ' + (err && err.message ? err.message : err) +
      '\n\nCheck the tab list for a partial archive copy. Status cells are only cleared after the archive copy succeeds.');
  } finally {
    try { lock.releaseLock(); } catch (y) {}
  }
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

/** Status columns to clear for New shift: [{row, col, numRows}] - Status columns only, data block only. */
function statusClearRanges_(layout) {
  var n = layout.lastDataRow - FIRST_DATA_ROW + 1;
  return GROUPS.map(function (g) { return { row: FIRST_DATA_ROW, col: g.statusCol, numRows: n }; });
}

/** 'yyyy-MM-dd HH:mm:ss' -> {y,mo,d,h} or null */
function parseStamp_(text) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):\d{2}/.exec(String(text || '').trim());
  return m ? { y: +m[1], mo: +m[2], d: +m[3], h: +m[4] } : null;
}

function dayBefore_(p) {
  var t = new Date(Date.UTC(p.y, p.mo - 1, p.d) - 86400000);
  return t.toISOString().slice(0, 10);
}

function ymd_(p) {
  return p.y + '-' + (p.mo < 10 ? '0' : '') + p.mo + '-' + (p.d < 10 ? '0' : '') + p.d;
}

/**
 * Log 'Shift' column. Input: CT wall-clock text 'yyyy-MM-dd HH:mm:ss'.
 * Before 06:00 CT -> previous calendar date (overnight shift that started the evening before);
 * otherwise the same date. Unparseable input -> ''.
 */
function shiftDateFromText_(text) {
  var p = parseStamp_(text);
  if (!p) return '';
  return p.h < SHIFT_LOG_CUTOFF_HOUR ? dayBefore_(p) : ymd_(p);
}

/**
 * Archive tab date = the date the (10 pm CT) shift started. New shift is run AFTER the shift, so:
 * 22:00-23:59 -> today (shift in progress started today); 00:00-21:59 -> previous date
 * (e.g. run at 6:30 AM on Oct 1 -> the shift that started the evening of Sep 30).
 */
function archiveDateFromText_(text) {
  var p = parseStamp_(text);
  if (!p) return '';
  return p.h >= SHIFT_START_HOUR ? ymd_(p) : dayBefore_(p);
}

/** base, then 'base (2)', 'base (3)'... first name not in existingNames (case-insensitive, as Sheets is). */
function uniqueName_(base, existingNames) {
  var lower = existingNames.map(function (n) { return String(n).toLowerCase(); });
  if (lower.indexOf(base.toLowerCase()) < 0) return base;
  for (var i = 2; i < 1000; i++) {
    var cand = base + ' (' + i + ')';
    if (lower.indexOf(cand.toLowerCase()) < 0) return cand;
  }
  return base + ' (' + Date.now() + ')';
}

/** Conditional-format formula for one group: green when that group's status cell is SP. First cell = row `row`. */
function spFormula_(g, row) {
  return '=$' + colLetter_(g.statusCol) + row + '="' + COMPLETED_STATUS + '"';
}

/** True for rules created by applyCompletedFormatting_ (so re-running Set up replaces, never stacks, them). */
function isSpRuleFormula_(f) {
  return /^=\$[A-Z]+\d+="SP"$/.test(String(f || ''));
}

/** Row number (1-based, in the Completed tab) of vin in column-A values (2D, from row 2 down), or 0. */
function findCompletedRow_(colValues, vin) {
  for (var i = 0; i < colValues.length; i++) {
    if (String(colValues[i][0]).trim().toUpperCase() === String(vin).toUpperCase()) return i + 2;
  }
  return 0;
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
  // Completed tab count per class (VINs moved to SP through the app this shift)
  var completed = ['Completed (SP list)'];
  GROUPS.forEach(function (g) {
    completed.push('=COUNTIF(' + COMPLETED_SHEET_NAME + '!B2:B,"' + g.klass + '")');
  });
  completed.push('=SUM(B' + (blankRow + 2) + ':D' + (blankRow + 2) + ')');
  rows.push(completed);
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
 *       markCompleted([vin,klass,reservation,name,time]), unmarkCompleted(vin), cacheGet(k), cachePut(k,v,ttlSec), findLoggedClient(id):{...}|null }
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
  var stamp = io.nowText();
  io.appendLog([stamp, name, digits, m.vin, m.klass, body.action, m.reservation, body.clientId, shiftDateFromText_(stamp)]);
  // Completed list: SP adds/refreshes the VIN, any other status (a correction) removes it. A failure here
  // must not fail the request - the status and Log are already written.
  try {
    if (body.action === COMPLETED_STATUS) io.markCompleted([m.vin, m.klass, m.reservation, name, stamp]);
    else io.unmarkCompleted(m.vin);
  } catch (e) {}
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

/** Display text of a Log timestamp cell (string as written, or a Date Sheets auto-parsed). */
function logStampText_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
  return String(v == null ? '' : v);
}

/**
 * Returns the Log tab, creating it if missing. Existing tabs are migrated in place: any header
 * missing from LOG_HEADERS is added in its own position (so 'Shift' is appended as column 9);
 * old rows and columns 1-8 are never moved. With backfill=true, blank Shift cells of old rows are
 * filled from their timestamps.
 */
function getLogSheet_(ss, backfill) {
  var sh = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET_NAME);
    if (sh.getMaxColumns() < LOG_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), LOG_HEADERS.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@'); // keep leading zeros in Digits
    sh.getRange(1, LOG_SHIFT_COL, sh.getMaxRows(), 1).setNumberFormat('@'); // keep Shift as text, not a date
    return sh;
  }
  if (sh.getMaxColumns() < LOG_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), LOG_HEADERS.length - sh.getMaxColumns());
  var have = sh.getRange(1, 1, 1, LOG_HEADERS.length).getValues()[0];
  for (var i = 0; i < LOG_HEADERS.length; i++) {
    if (String(have[i] || '').trim() === '') {
      sh.getRange(1, i + 1).setValue(LOG_HEADERS[i]).setFontWeight('bold');
      if (i + 1 === LOG_SHIFT_COL) sh.getRange(1, LOG_SHIFT_COL, sh.getMaxRows(), 1).setNumberFormat('@');
    }
  }
  if (backfill) backfillShift_(sh, ss.getSpreadsheetTimeZone());
  return sh;
}

/** Fills blank Shift cells of existing Log rows from their Timestamp (never overwrites a value). */
function backfillShift_(sh, tz) {
  var last = sh.getLastRow();
  if (last < 2) return;
  var n = last - 1;
  var stamps = sh.getRange(2, 1, n, 1).getValues();
  var shifts = sh.getRange(2, LOG_SHIFT_COL, n, 1).getValues();
  var changed = false;
  for (var i = 0; i < n; i++) {
    if (String(shifts[i][0] == null ? '' : shifts[i][0]).trim() !== '') continue;
    var d = shiftDateFromText_(logStampText_(stamps[i][0], tz));
    if (d) { shifts[i][0] = d; changed = true; }
  }
  if (changed) {
    var rng = sh.getRange(2, LOG_SHIFT_COL, n, 1);
    rng.setNumberFormat('@');
    rng.setValues(shifts);
  }
}

/** Returns the Completed tab, creating it (header, frozen row) if missing. */
function getCompletedSheet_(ss) {
  var sh = ss.getSheetByName(COMPLETED_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(COMPLETED_SHEET_NAME);
    if (sh.getMaxColumns() < COMPLETED_HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), COMPLETED_HEADERS.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, COMPLETED_HEADERS.length).setValues([COMPLETED_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Adds the VIN to the Completed tab (or refreshes its row if already there) and highlights it green. */
function markCompleted_(ss, rowArr) {
  var sh = getCompletedSheet_(ss);
  var last = sh.getLastRow();
  var existing = last >= 2 ? findCompletedRow_(sh.getRange(2, 1, last - 1, 1).getValues(), rowArr[0]) : 0;
  var r = existing || Math.max(last, 1) + 1;
  var rng = sh.getRange(r, 1, 1, COMPLETED_HEADERS.length);
  rng.setNumberFormat('@');                       // keep reservation text / timestamp as text
  rng.setValues([rowArr.map(String)]);
  rng.setBackground(GREEN);
}

/** Removes the VIN from the Completed tab if present (status corrected away from SP). */
function unmarkCompleted_(ss, vin) {
  var sh = ss.getSheetByName(COMPLETED_SHEET_NAME);
  if (!sh) return;
  var last = sh.getLastRow();
  if (last < 2) return;
  var r = findCompletedRow_(sh.getRange(2, 1, last - 1, 1).getValues(), vin);
  if (r) sh.deleteRow(r);
}

/**
 * Green highlight for VIN + status cells of every group while Status = SP, via conditional formatting.
 * Replaces our own earlier rules, keeps any other rules on the sheet.
 */
function applyCompletedFormatting_(sheet, lastRow) {
  var kept = sheet.getConditionalFormatRules().filter(function (rule) {
    var c = rule.getBooleanCondition();
    if (!c || c.getCriteriaType() !== SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA) return true;
    return !isSpRuleFormula_(c.getCriteriaValues()[0]);
  });
  GROUPS.forEach(function (g) {
    var range = sheet.getRange(FIRST_DATA_ROW, g.vinCol, lastRow - FIRST_DATA_ROW + 1, 2); // VIN col + adjacent status col
    kept.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(spFormula_(g, FIRST_DATA_ROW))
      .setBackground(GREEN)
      .setRanges([range])
      .build());
  });
  sheet.setConditionalFormatRules(kept);
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
      log.getRange(r, LOG_SHIFT_COL).setNumberFormat('@');
      log.getRange(r, 1, 1, arr.length).setValues([arr.map(String)]);
    },
    markCompleted: function (arr) { markCompleted_(ss, arr); },
    unmarkCompleted: function (vin) { unmarkCompleted_(ss, vin); },
    cacheGet: function (k) { return cache.get(k); },
    cachePut: function (k, v, ttl) { cache.put(k, v, ttl); },
    findLoggedClient: function (id) {
      var log = ss.getSheetByName(LOG_SHEET_NAME);
      if (!log) return null;
      var last = log.getLastRow();
      if (last < 2) return null;
      var start = Math.max(2, last - LOG_SCAN_ROWS + 1);
      var rows = log.getRange(start, 1, last - start + 1, LOG_CLIENT_COL).getValues(); // cols 1-8 only: works on pre-migration tabs
      for (var i = rows.length - 1; i >= 0; i--) {
        if (String(rows[i][LOG_CLIENT_COL - 1]) === id) return { vin: rows[i][3], klass: rows[i][4], action: rows[i][5], reservation: rows[i][6] };
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
