const assert = require('assert'); const fs = require('fs');
const L = require('../logic.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const iso = (ms) => new Date(ms).toISOString();

t('cleanDigits', () => { assert.strictEqual(L.cleanDigits(' 33-46x9!99'), '3346X9'); });

t('matchVins case-insensitive, needs 4+', () => {
  const list = [{ vin: '7SAYGDEE5TF559997' }, { vin: '7SAYGDEEXTF559946' }, { vin: '5YJAJEEU2TA003267' }];
  assert.strictEqual(L.matchVins(list, '9997').length, 1);
  assert.strictEqual(L.matchVins(list, '559').length, 0);
  assert.strictEqual(L.matchVins(list, '59946')[0].vin, '7SAYGDEEXTF559946');
  assert.strictEqual(L.matchVins([{ vin: '1abcdefghij00123x' }], '0123X').length, 1);
  assert.strictEqual(L.matchVins(list, '0123').length, 0);
});

t('parse CDT: Thu 10/01 4:00 AM = 09:00Z', () => {
  const now = Date.UTC(2026, 9, 1, 8, 0); // 3:00 AM CDT
  assert.strictEqual(iso(L.parseReservation('Thu 10/01 4:00 AM', now)), '2026-10-01T09:00:00.000Z');
  assert.strictEqual(iso(L.parseReservation('Thu 10/01  4:00 AM', now)), '2026-10-01T09:00:00.000Z');
  assert.strictEqual(iso(L.parseReservation('Thu 10/01 10:00 PM', now)), '2026-10-02T03:00:00.000Z');
  assert.strictEqual(iso(L.parseReservation('Thu 10/01 12:00 AM', now)), '2026-10-01T05:00:00.000Z');
  assert.strictEqual(iso(L.parseReservation('Thu 10/01 12:30 PM', now)), '2026-10-01T17:30:00.000Z');
});

t('parse CST (winter) offset -6', () => {
  const now = Date.UTC(2026, 11, 20, 12, 0);
  assert.strictEqual(iso(L.parseReservation('Mon 12/21 4:00 AM', now)), '2026-12-21T10:00:00.000Z');
});

t('DST edges: spring forward 2026-03-08, fall back 2026-11-01', () => {
  assert.strictEqual(iso(L.parseReservation('Sun 03/08 3:30 AM', Date.UTC(2026, 2, 8, 6))), '2026-03-08T08:30:00.000Z'); // CDT
  assert.strictEqual(iso(L.parseReservation('Sun 03/08 1:30 AM', Date.UTC(2026, 2, 8, 6))), '2026-03-08T07:30:00.000Z'); // CST
  assert.strictEqual(iso(L.parseReservation('Sun 11/01 5:00 AM', Date.UTC(2026, 10, 1, 6))), '2026-11-01T11:00:00.000Z'); // CST
  assert.strictEqual(iso(L.parseReservation('Sun 11/01 12:30 AM', Date.UTC(2026, 10, 1, 6))), '2026-11-01T05:30:00.000Z'); // CDT
});

t('year rollover using weekday (Dec -> Jan)', () => {
  // now: Wed 12/30/2026 11:00 PM CST; Fri 01/01 is 2027 (Jan 1 2027 = Friday)
  const now = Date.UTC(2026, 11, 31, 5, 0);
  assert.strictEqual(iso(L.parseReservation('Fri 01/01 4:00 AM', now)), '2027-01-01T10:00:00.000Z');
  // after New Year, yesterday's Dec 31 (Thu 2026) should be 2026, not 2027
  const now2 = Date.UTC(2027, 0, 1, 8, 0);
  assert.strictEqual(iso(L.parseReservation('Thu 12/31 10:00 PM', now2)), '2027-01-01T04:00:00.000Z');
  // no weekday -> nearest to now
  assert.strictEqual(iso(L.parseReservation('01/02 6:00 AM', now)), '2027-01-02T12:00:00.000Z');
});

t('uses Chicago date even when UTC date already rolled over', () => {
  // 2026-10-02T03:30Z is still Thu 10/01 10:30 PM CDT
  const now = Date.UTC(2026, 9, 2, 3, 30);
  assert.strictEqual(L.countdown('Thu 10/01 10:45 PM', now).text, 'due in 15m');
});

t('invalid / No Reservation', () => {
  assert.strictEqual(L.parseReservation('No Reservation', 0), null);
  assert.strictEqual(L.parseReservation('', 0), null);
  assert.strictEqual(L.parseReservation('Thu 13/01 4:00 AM', 0), null);
  assert.strictEqual(L.parseReservation('Thu 10/01 13:00 AM', 0), null);
  assert.strictEqual(L.countdown('No Reservation', 0).text, 'No reservation');
});

t('countdown text', () => {
  const base = L.parseReservation('Thu 10/01 4:00 AM', Date.UTC(2026, 9, 1, 8));
  assert.deepStrictEqual(L.countdown('Thu 10/01 4:00 AM', base - (2 * 60 + 15) * 60000), { text: 'due in 2h 15m', state: 'upcoming' });
  assert.deepStrictEqual(L.countdown('Thu 10/01 4:00 AM', base - 20 * 60000), { text: 'due in 20m', state: 'soon' });
  assert.strictEqual(L.countdown('Thu 10/01 4:00 AM', base).text, 'due now');
  assert.deepStrictEqual(L.countdown('Thu 10/01 4:00 AM', base + 35 * 60000), { text: 'overdue 35m', state: 'overdue' });
  assert.strictEqual(L.countdown('Thu 10/01 4:00 AM', base + 26 * 3600000).text, 'overdue 1d 2h');
});

t('decodeCfg round trip and bad input', () => {
  const o = { u: 'https://script.google.com/macros/s/AKfy/exec', k: 'pässword-ü/+=?' };
  const b64 = Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepStrictEqual(L.decodeCfg('#cfg=' + b64), { url: o.u, key: o.k, csv: '' });
  assert.deepStrictEqual(L.decodeCfg('https://x.github.io/vin-tracker/#cfg=' + b64), { url: o.u, key: o.k, csv: '' });
  assert.deepStrictEqual(L.decodeCfg(b64), { url: o.u, key: o.k, csv: '' });
  assert.strictEqual(L.decodeCfg('#cfg=%%%'), null);
  assert.strictEqual(L.decodeCfg(Buffer.from('{"u":"http://x","k":"a"}').toString('base64')), null);
  assert.strictEqual(L.decodeCfg(''), null);
});

t('uuid format', () => { assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(L.uuid())); });


t('CSV fallback parse (real master.csv when present)', () => {
  const p = '/workspace/master.csv';
  const csv = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'Fleet,,,,,,\r\n,,,,,,\r\nReservation Time (CT),Prod VIN,Prod Status,CC VIN,CC Status,Dev VIN,Dev Status\r\nThu 10/01  4:00 AM,7SAYGDEE5TF559997,,,,,\r\n,7SAYGDEE6TF563346,Shop,,,,\r\nUse each Status x\r\n';
  const v = L.parseSheetCsv(csv);
  assert.ok(v.length >= 2);
  const a = v.find((x) => x.vin === '7SAYGDEE6TF563346');
  assert.strictEqual(a.reservation, 'Thu 10/01 4:00 AM'); assert.strictEqual(a.klass, 'Prod');
  if (fs.existsSync(p)) {
    assert.strictEqual(v.find((x) => x.vin === '5YJAJEEU4TA003111').reservation, 'Thu 10/01 5:30 AM');
    assert.strictEqual(v.find((x) => x.vin === '7SAYGDEE0TF346777').reservation, 'No Reservation');
    assert.strictEqual(v.find((x) => x.vin === '5YJAJEEU0TA001923').reservation, 'Sat 10/03 10:00 PM');
    assert.ok(!v.some((x) => /status|picked|current/i.test(x.vin)));
  }
  assert.deepStrictEqual(L.parseCsv('a,"b,""c""",d\r\n1,2,3'), [['a', 'b,"c"', 'd'], ['1', '2', '3']]);
});

t('cfg with csv', () => {
  const o = { u: 'https://script.google.com/x/exec', k: 'k1', c: 'https://docs.google.com/pub?output=csv' };
  assert.deepStrictEqual(L.decodeCfg('#cfg=' + Buffer.from(JSON.stringify(o)).toString('base64url')), { url: o.u, key: 'k1', csv: o.c });
  const bad = Buffer.from(JSON.stringify({ u: o.u, k: 'k1', c: 'http://evil' })).toString('base64url');
  assert.strictEqual(L.decodeCfg(bad).csv, '');
});

console.log(`\n${n} logic tests passed`);
