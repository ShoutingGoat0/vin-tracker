// Tests Code.gs pure logic by loading it into a vm sandbox (no Apps Script services needed).
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
const G = (name) => vm.runInContext(name, ctx);
const clone = (x) => JSON.parse(JSON.stringify(x));
const eq = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

// Fixture mirrors the real sheet shape, rows start at row 4.
const R = (a, b, c, d, e, f, g) => [a || '', b || '', c || '', d || '', e || '', f || '', g || ''];
const fixture = () => [
  R('Thu 10/01  4:00 AM', '7SAYGDEE5TF559997'),
  R('', '7SAYGDEE6TF563346'),
  R('Thu 10/01  5:30 AM', '', '', '5YJAJEEU2TA003267', '', '7SAYGDEE1TF561021'),
  R('', '', '', '5YJAJEEU4TA003111', 'Shop', '7SAYGDEE2TF585523'),
  R('No Reservation', '7SAYGDEE1TF575999', '', '5YJAJEEU2TA002121', '', '7SAYGDEE0TF346777'),
  R('', '', '', '', '', ''),
  R('Use each Status dropdown to mark Picked Up or Dropped Off.'),
  R(''),
  R('Status Summary', 'Prod Picked'),
  R('Current'),
];

let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('parseSheet_ carries reservation down, classes, stops at note', () => {
  const e = G('parseSheet_')(fixture());
  assert.strictEqual(e.length, 9);
  const a = e.find((x) => x.vin === '7SAYGDEE6TF563346');
  eq([a.klass, a.reservation, a.row, a.col], ['Prod', 'Thu 10/01 4:00 AM', 5, 3]);
  const b = e.find((x) => x.vin === '5YJAJEEU4TA003111');
  eq([b.klass, b.reservation, b.status, b.col], ['CC', 'Thu 10/01 5:30 AM', 'Shop', 5]);
  assert.strictEqual(e.find((x) => x.vin === '7SAYGDEE0TF346777').reservation, 'No Reservation');
  assert.strictEqual(e.find((x) => x.vin === '7SAYGDEE0TF346777').klass, 'Dev');
});

t('findLayout_ locates note + summary + last data row', () => {
  const l = G('findLayout_')(fixture());
  assert.strictEqual(l.noteRow, 10); assert.strictEqual(l.summaryRow, 12); assert.strictEqual(l.lastDataRow, 8);
  assert.strictEqual(l.summaryDataEnd, 8);
});

t('buildSummary_ formulas', () => {
  const s = G('buildSummary_')(55, 4, 51);
  assert.strictEqual(s.rows.length, 7);
  assert.strictEqual(s.rows[1][1], '=COUNTIF(C4:C51,"Picked Up")');
  assert.strictEqual(s.rows[2][2], '=COUNTIF(E4:E51,"Shop")');
  assert.strictEqual(s.rows[3][3], '=COUNTIF(G4:G51,"Charger")');
  assert.strictEqual(s.rows[4][4], '=SUM(B59:D59)');
  assert.ok(s.rows[5][1].indexOf('=SUMPRODUCT((B4:B51<>"")*(C4:C51=""))') === 0);
  assert.strictEqual(s.rows[6][2], '=COUNTA(D4:D51)');
});

const mkIo = (values) => {
  const st = { logs: [], sets: [], cache: {}, t: 1000000, values };
  return Object.assign(st, {
    now: () => st.t, nowText: () => '2026-10-01 03:00:00',
    getValues: () => clone(st.values),
    setStatus: (r, c, v) => { st.sets.push([r, c, v]); },
    appendLog: (a) => st.logs.push(a),
    cacheGet: (k) => st.cache[k] || null, cachePut: (k, v) => { st.cache[k] = v; },
    findLoggedClient: (id) => { const l = st.logs.find((x) => x[7] === id); return l ? { vin: l[3], klass: l[4], action: l[5], reservation: l[6] } : null; },
  });
};
const body = (o) => Object.assign({ name: 'Mark', digits: '3346', action: 'Shop', clientId: 'aaaaaaaa-1111' }, o);

t('unique match sets status + logs exactly the allowed fields', () => {
  const io = mkIo(fixture());
  const r = G('processAction_')(body(), io);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.vin, '7SAYGDEE6TF563346');
  eq(io.sets, [[5, 3, 'Shop']]);
  eq(io.logs[0], ['2026-10-01 03:00:00', 'Mark', '3346', '7SAYGDEE6TF563346', 'Prod', 'Shop', 'Thu 10/01 4:00 AM', 'aaaaaaaa-1111']);
  assert.strictEqual(io.logs[0].length, 8);
});

t('case-insensitive digits (letters / X)', () => {
  const io = mkIo(fixture());
  const r = G('processAction_')(body({ digits: 'a003267', clientId: 'bbbbbbbb-2222' }), io);
  assert.strictEqual(r.ok, false); // 7 chars invalid
  const r2 = G('processAction_')(body({ digits: '03267', clientId: 'bbbbbbbc-2222', action: 'SP' }), io);
  assert.strictEqual(r2.vin, '5YJAJEEU2TA003267');
  const io2 = mkIo([R('x', '7SAYGDEEXTF561020')]);
  assert.strictEqual(G('processAction_')(body({ digits: '1020', clientId: 'cccccccc-3333' }), io2).ok, true);
  const io3 = mkIo([R('x', '7SAYGDEEXTF55994a')]);
  assert.strictEqual(G('processAction_')(body({ digits: '994A', clientId: 'dddddddd-4444' }), io3).ok, true);
});

t('0 matches and >1 matches write nothing', () => {
  const io = mkIo(fixture());
  let r = G('processAction_')(body({ digits: '9999' }), io);
  assert.strictEqual(r.ok, false); eq(r.matches, []);
  // two VINs ending 3346? build fixture
  const v = [R('t', '1AAAAAAAAAA013346'), R('', '1AAAAAAAAAA023346')];
  const io2 = mkIo(v);
  r = G('processAction_')(body({ digits: '3346', clientId: 'eeeeeeee-5555' }), io2);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.matches.length, 2);
  eq(Object.keys(r.matches[0]).sort(), ['klass', 'reservation', 'status', 'vin']);
  assert.strictEqual(io2.sets.length + io2.logs.length + io.sets.length + io.logs.length, 0);
  r = G('processAction_')(body({ digits: '013346', clientId: 'eeeeeeee-5556' }), io2);
  assert.strictEqual(r.ok, true);
});

t('dedupe by clientId', () => {
  const io = mkIo(fixture());
  G('processAction_')(body(), io);
  const r = G('processAction_')(body(), io);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.duplicate, true); assert.strictEqual(io.logs.length, 1);
  io.cache = {}; // cache expired: log lookup still dedupes
  const r2 = G('processAction_')(body(), io);
  assert.strictEqual(r2.duplicate, true); assert.strictEqual(io.logs.length, 1);
});

t('dedupe same vin+action within 20s, allowed after / different action', () => {
  const io = mkIo(fixture());
  G('processAction_')(body(), io);
  io.t += 10000;
  let r = G('processAction_')(body({ clientId: 'ffffffff-6666' }), io);
  assert.strictEqual(r.duplicate, true); assert.strictEqual(io.logs.length, 1);
  r = G('processAction_')(body({ clientId: 'ffffffff-6667', action: 'Charger' }), io);
  assert.ok(!r.duplicate); assert.strictEqual(io.logs.length, 2);
  io.t += 25000;
  r = G('processAction_')(body({ clientId: 'ffffffff-6668' }), io);
  assert.ok(!r.duplicate); assert.strictEqual(io.logs.length, 3);
});

t('validation rejects bad input', () => {
  const io = mkIo(fixture());
  for (const o of [{ digits: '123' }, { digits: '1234567' }, { digits: '12 4' }, { action: 'Dropped Off' }, { name: '' }, { clientId: '' }, { name: 'x'.repeat(41) }]) {
    assert.strictEqual(G('processAction_')(body(o), io).ok, false, JSON.stringify(o));
  }
  assert.strictEqual(io.logs.length + io.sets.length, 0);
});

t('formula injection in name is neutralised', () => {
  const io = mkIo(fixture());
  G('processAction_')(body({ name: '=HYPERLINK("x")' }), io);
  assert.strictEqual(io.logs[0][1][0], "'");
});

t('checkKey_', () => {
  const c = G('checkKey_');
  assert.strictEqual(c('abc', 'abc'), ''); assert.ok(c('abd', 'abc')); assert.ok(c('', 'abc')); assert.ok(c('x', '')); assert.ok(c(undefined, 'abc'));
});

console.log(`\n${n} Code.gs tests passed`);
