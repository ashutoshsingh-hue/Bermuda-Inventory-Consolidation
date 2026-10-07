# Bermuda Sort Station
- Read PLAN.md and STRUCTURE.md before any change.
- Business rules in PLAN.md §5 are fixed. Do not change them without the owner's approval.
- core/ must stay pure (no db/http/fs, time passed in). Appendix A is historical; the current rules are PLAN.md §5 (rev. 03-Oct-2026).
- Space is reserved per active batch (route), never for the whole dump.
- Build one milestone at a time (PLAN.md §11). Run `npm test` and keep it green before moving on.
- Never convert pid/barcode/tote to numbers. Never trust tote_simplified.
- Any number of stations: nothing may assume a fixed station count.

## Current status
@HANDOFF.md
