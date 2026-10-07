import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState, pid } from '../../src/core/state.js';
import { scan } from '../../src/core/scan.js';
import { recommend } from '../../src/core/recommend.js';

// build a waiting tote of processable barcodes for one pid
function addTote(st, toteId, toteNum, p, count) {
  st.totes[toteId] = { n: toteNum, s: 'H', bs: [] };
  for (let i = 0; i < count; i++) {
    const b = `${toteId}-B${i}`;
    st.barcodes[b] = { p, t: toteId, pt: '1', pr: 1, s: 'H' };
    st.totes[toteId].bs.push(b);
  }
}

test('recommend — only lists waiting (H) totes; totes opened by any station drop out', () => {
  const st = newState();
  addTote(st, 'T1', '1', 'PA', 3);
  addTote(st, 'T2', '2', 'PB', 3);
  pid(st, 'PA').R = 3; pid(st, 'PB').R = 3;
  let r = recommend(st);
  assert.equal(r.total, 2);
  scan(st, 'S1', 'T1'); // opens T1 -> state becomes 'O'
  r = recommend(st);
  assert.equal(r.total, 1);
  assert.equal(r.list[0].tote, 'T2');
});

test('recommend — excludeTotes hides specific waiting totes on request', () => {
  const st = newState();
  addTote(st, 'T1', '1', 'PA', 3);
  addTote(st, 'T2', '2', 'PB', 3);
  pid(st, 'PA').R = 3; pid(st, 'PB').R = 3;
  const r = recommend(st, { excludeTotes: ['T1'] });
  assert.equal(r.total, 1);
  assert.equal(r.list[0].tote, 'T2');
});

test('recommend — with N stations each opening the best remaining tote, all N get different totes', () => {
  const st = newState();
  for (let i = 1; i <= 4; i++) { addTote(st, 'T' + i, String(i), 'P' + i, 5); pid(st, 'P' + i).R = 5; }
  const offered = [];
  for (let i = 1; i <= 4; i++) {
    const r = recommend(st, 3);
    assert.ok(r.list.length > 0, `station ${i} should still get an offer`);
    const chosen = r.list[0].tote;
    assert.ok(!offered.includes(chosen), `tote ${chosen} already offered`);
    offered.push(chosen);
    scan(st, 'S' + i, chosen); // station opens it, removing it from future recommendations
  }
  assert.equal(new Set(offered).size, 4);
});

test('recommend — bare numeric argument still works as a limit (back-compat)', () => {
  const st = newState();
  for (let i = 1; i <= 5; i++) { addTote(st, 'T' + i, String(i), 'P' + i, 2); pid(st, 'P' + i).R = 2; }
  const r = recommend(st, 2);
  assert.equal(r.list.length, 2);
  assert.equal(r.total, 5);
});

test('recommend — totes that fit the remaining plan space are ordered ahead of ones that would exceed it', () => {
  const st = newState({ aisles: 1, totesPerAisle: 1, lastAisleTotes: 1, partitions: 1, cap: 120, headroomPct: 10, softPidCap: 20 });
  st.locations[0].used = 100; // only 8 free slots (plan=108)
  addTote(st, 'BIG', '1', 'PBIG', 3); pid(st, 'PBIG').R = 50; // brand-new PID needing lots of room -> won't fit
  addTote(st, 'SMALL', '2', 'PSMALL', 3); pid(st, 'PSMALL').R = 3; // fits easily
  const r = recommend(st);
  assert.equal(r.list[0].tote, 'SMALL');
  assert.equal(r.list[0].fits, true);
});
