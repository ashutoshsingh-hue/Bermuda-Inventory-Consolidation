/* ===== Bermuda Sort Station — clock (Asia/Kolkata wall clock in, string out) =====
 * shiftOf() is descriptive metadata only (stamped onto events/totes/barcodes for audit and
 * reporting) — nothing in the system gates or restricts behavior on it. There is no shift-end
 * enforcement and no "off shift" blocking; scanning works the same at any hour.
 */

export function shiftOf(d) {
  const h = d.getHours();
  return h >= 6 && h < 14 ? 'A' : h >= 14 && h < 22 ? 'B' : 'OFF';
}

export const nowISO = d => {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};
