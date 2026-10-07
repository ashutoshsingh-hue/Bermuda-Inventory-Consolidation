import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoverSuggestion } from '../../src/core/handover.js';

// PLAN.md §5.3 — the six required cases, with an owner-approved override on the fourth:
// PLAN.md's own text says "R = 0 or R >= 5: hand over all C, even when C is under 5" — the
// owner explicitly rejected that (a give under 5 is never worth an operator trip), so
// C=3/R=12 now waits instead of giving 3. See GIVE_MIN in handover.js.
const cases = [
  { C: 6, R: 6, give: 6, keep: 0 },
  { C: 8, R: 4, give: 7, keep: 1 },
  { C: 20, R: 3, give: 18, keep: 2 },
  { C: 3, R: 12, give: 0, keep: 3 }, // overridden: was give:3 per PLAN.md's own example
  { C: 5, R: 2, give: 0, keep: 5 },
  { C: 7, R: 0, give: 7, keep: 0 },
];

test('handoverSuggestion — §5.3 table', () => {
  for (const c of cases) {
    const r = handoverSuggestion(c.C, c.R);
    assert.equal(r.give, c.give, `give for C=${c.C} R=${c.R}`);
    assert.equal(r.keep, c.keep, `keep for C=${c.C} R=${c.R}`);
    assert.equal(r.give + r.keep, c.C, 'give+keep must equal C');
    const leftover = c.C - r.give + c.R;
    assert.ok(leftover === 0 || leftover >= 5, `leftover ${leftover} must be 0 or >=5`);
  }
});

test('handoverSuggestion — GIVE_MIN override: R>=5 with C<5 waits instead of giving a small amount', () => {
  // R=10 keeps T=C+10 well clear of the earlier "Small PID (T 5-9): wait" branch, so these
  // land on the GIVE_MIN check itself, not a different wait reason
  for (const C of [1, 2, 3, 4]) {
    const r = handoverSuggestion(C, 10);
    assert.equal(r.give, 0, `C=${C} R=10 should wait, not give ${C}`);
    assert.equal(r.keep, C);
    assert.match(r.why, /waiting for 5\+/);
  }
  // R huge, C still under 5 — same wait, not "all collected" style over-eagerness
  assert.equal(handoverSuggestion(4, 500).give, 0);
});

test('handoverSuggestion — GIVE_MIN override: once C reaches 5, it gives normally', () => {
  const r = handoverSuggestion(5, 5); // C right at the GIVE_MIN boundary
  assert.equal(r.give, 5);
  assert.equal(r.keep, 0);
  assert.match(r.why, /5 still to come/);
});

test('handoverSuggestion — R=0 is unaffected by the override (already guaranteed C>=5 by the under-5 branch)', () => {
  const r = handoverSuggestion(7, 0);
  assert.equal(r.give, 7);
  assert.equal(r.why, 'All collected');
});

test('handoverSuggestion — C=0 gives nothing', () => {
  const r = handoverSuggestion(0, 10);
  assert.equal(r.give, 0); assert.equal(r.keep, 0);
});

test('handoverSuggestion — R=0, C<5, N>0 is AT RISK', () => {
  const r = handoverSuggestion(3, 0, 2);
  assert.equal(r.give, 0); assert.equal(r.risk, 1);
});

test('handoverSuggestion — R=0, C<5, N=0 is under-5, waits', () => {
  const r = handoverSuggestion(3, 0, 0);
  assert.equal(r.give, 0); assert.equal(r.under5, 1);
});

test('handoverSuggestion — T<5 waits regardless of R', () => {
  const r = handoverSuggestion(2, 1, 0);
  assert.equal(r.give, 0); assert.equal(r.under5, 1);
});

test('handoverSuggestion — small PID (5-9) with R>0 waits for full collection', () => {
  const r = handoverSuggestion(4, 3); // T=7
  assert.equal(r.give, 0); assert.equal(r.keep, 4);
});

// PLAN.md §5.3, made explicit (rev. 03-Oct-2026, owner-approved): give is only ever 0, >=5, or
// exactly C with R=0 (a PID's final remainder, however small) — broadly, not just on the 6-row
// table, and the "never leave 1-4" rule (PLAN.md §5.2) holds for every (C, R) combination.
test('handoverSuggestion — give is always 0, or >=5, or exactly C with R=0 (final remainder) — across a wide sweep, not just the table', () => {
  for (let C = 0; C <= 30; C++) {
    for (let R = 0; R <= 30; R++) {
      const r = handoverSuggestion(C, R);
      const isFinalRemainder = r.give === C && R === 0;
      assert.ok(r.give === 0 || r.give >= 5 || isFinalRemainder, `give=${r.give} invalid for C=${C} R=${R}`);
    }
  }
});

test('handoverSuggestion — never leaves 1-4: C+R minus what\'s given is always 0 or >=5, across a wide sweep', () => {
  // excluded deliberately: C=0 (nothing placed, no decision made) and anything flagged
  // under5/risk — T<5 so far (R>0: more might still arrive) or R=0 with C<5 (nothing more
  // ever coming) are states the system explicitly surfaces as exceptions rather than silently
  // resolving, not a rule violation — the "never leave 1-4" guarantee is about handover
  // decisions the system actually makes (give>0, or the deliberate wait once T>=5)
  for (let C = 1; C <= 30; C++) {
    for (let R = 0; R <= 30; R++) {
      const r = handoverSuggestion(C, R);
      if (r.under5 || r.risk) continue;
      const leftover = (C - r.give) + R;
      assert.ok(leftover === 0 || leftover >= 5, `leftover=${leftover} invalid for C=${C} R=${R}`);
      assert.equal(r.give + r.keep, C, `give+keep must equal C for C=${C} R=${R}`);
    }
  }
});

test('handoverSuggestion — a PID\'s final remainder (R=0) is handed over in full, even if under 5, once it\'s already past the AT-RISK/under-5 gate', () => {
  // R=0 and C<5 is caught earlier as AT RISK or under-5 (give=0) — the "give==C, R==0" disjunct
  // is for C>=5, R=0, where the whole remainder goes regardless of exact size
  for (const C of [5, 6, 11, 29]) {
    const r = handoverSuggestion(C, 0);
    assert.equal(r.give, C);
    assert.equal(r.keep, 0);
  }
});
