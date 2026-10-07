/* ===== Bermuda Sort Station — AT-RISK release (PLAN.md §5.3, §9) =====
 * Releasing stock for processing is done from the Handover tab (consolidationService.releaseMany).
 */
import { handOver, pidInfo, nowISO, shiftOf } from '../core/index.js';

export function createHandoverService({ app, runMutation }) {
  // §5.3: R=0, C<5, N>0 -> AT RISK. Admin releases it manually (it goes back through PID Hunter);
  // this force-hands-over the remaining C barcodes, the one place the 1-4 hold-back rule is
  // deliberately bypassed, and only for a pid actually flagged at-risk.
  function releaseAtRisk(pid) {
    const info = pidInfo(app.st, pid);
    if (!info) return { ok: false, error: 'Unknown PID' };
    if (!info.sug.risk) return { ok: false, error: 'This PID is not AT RISK' };
    const now = new Date();
    const n = runMutation(st => {
      const given = handOver(st, pid, info.C, now);
      return { result: given, event: { ts: nowISO(now), shift: shiftOf(now), type: 'release', pid, detail: { given, reason: 'AT_RISK' } } };
    });
    return { ok: true, given: n };
  }

  return { releaseAtRisk };
}
