/* ===== Bermuda Sort Station — scanner label resolution (PLAN.md §4.1) =====
 * Tote labels carry the partition (tote ID = first 12 chars, like LEFT(scan,12));
 * barcode labels carry a link prefix (barcode = last 12 chars, like RIGHT(scan,12)).
 */

export function normalize(st, raw) {
  const v = String(raw || '').trim().toUpperCase(); if (!v) return '';
  if (st.totes[v] || st.barcodes[v]) return v;
  if (v.length > 12) {
    const left = v.slice(0, 12), right = v.slice(-12);
    if (st.totes[left]) return left;
    if (st.barcodes[right]) return right;
    if (/^TL/.test(left)) return left;
    return right;
  }
  return v;
}
