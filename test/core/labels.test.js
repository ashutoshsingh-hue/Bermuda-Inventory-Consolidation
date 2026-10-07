import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../src/core/labels.js';
import { newState } from '../../src/core/state.js';

function stateWith({ totes = [], barcodes = [] } = {}) {
  const st = newState();
  for (const t of totes) st.totes[t] = { n: t, s: 'H', bs: [] };
  for (const b of barcodes) st.barcodes[b] = { p: 'P1', t: '', pt: '', pr: 1, s: 'H' };
  return st;
}

test('normalize — exact match to a known tote wins', () => {
  const st = stateWith({ totes: ['TL0000018463'] });
  assert.equal(normalize(st, 'TL0000018463'), 'TL0000018463');
});

test('normalize — exact match to a known barcode wins', () => {
  const st = stateWith({ barcodes: ['CCC162221732'] });
  assert.equal(normalize(st, 'CCC162221732'), 'CCC162221732');
});

test('normalize — tote label carries partition suffix, LEFT(12) resolves to known tote', () => {
  const st = stateWith({ totes: ['TL0000018463'] });
  assert.equal(normalize(st, 'TL0000018463-83-2'), 'TL0000018463');
});

test('normalize — link-prefixed barcode label, RIGHT(12) resolves to known barcode', () => {
  const st = stateWith({ barcodes: ['CCC162221732'] });
  assert.equal(normalize(st, 'HTTPS://LNK/CCC162221732'), 'CCC162221732');
});

test('normalize — neither side known: TL-prefixed LEFT(12) treated as tote', () => {
  const st = stateWith();
  const raw = 'TL00000184639999';
  assert.equal(normalize(st, raw), raw.slice(0, 12));
});

test('normalize — neither side known and not TL-prefixed: treated as barcode, RIGHT(12)', () => {
  const st = stateWith();
  const raw = 'XYZLINKPREFIXCCC162221732';
  assert.equal(normalize(st, raw), raw.slice(-12));
});

test('normalize — short input (<=12 chars) passes through unchanged (uppercased/trimmed)', () => {
  const st = stateWith();
  assert.equal(normalize(st, '  abc123  '), 'ABC123');
});

test('normalize — empty input returns empty string', () => {
  const st = stateWith();
  assert.equal(normalize(st, ''), '');
  assert.equal(normalize(st, '   '), '');
});
