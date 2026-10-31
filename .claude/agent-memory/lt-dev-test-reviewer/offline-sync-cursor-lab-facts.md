---
name: offline-sync-cursor-lab-facts
description: DEV-3899 cursor-lab harness (prototypes/ under .claude/plans/offline-sync) — what its LOST number can and cannot see, per-variant traps; reviewed 2026-10-31, no defect found
metadata:
  type: project
---

The phase-2 cursor lab (`.claude/plans/offline-sync/prototypes/cursor-lab.mjs` + `targets.mjs` + `cursor-writer.mjs`)
decided C1d (counter taken last, trigger + sentinel -1) for SQL and C2 (`$$NOW` + window W) for MongoDB. Reviewed
2026-10-31 for false-zero risk: none found. Facts worth knowing when phase 3 turns it into contract cases:

- LOST = final-state convergence per record (version + deleted), not "every version delivered". A later write masks
  a lost intermediate version — heavily on the 5-record hot set, rarely on inserts (50 % of writes, mostly never
  rewritten). Detection power comes from inserts.
- C1d's `late` holds the transaction BEFORE the stamp (row with -1, PAUSE, final `SET sync_seq = NULL`), commit right
  after. "Counter lock held to commit = commit order" is proven by the C1/C1t late runs (trailing sleep after the
  stamp), not by C1d. Multi-row statements / multi-row transactions under C1d are NOT exercised (PLAN §5 says so).
- No path commits a -1 row: the final UPDATE always hits the row the same transaction wrote.
- MySQL executor uses `pool.query` (client-side escaping), so a string cursor vs BIGINT column compares as DOUBLE —
  exact only below 2^53 (µs epoch ~1.8e15, fine). bigNumberStrings: `deleted` arrives as '0'/'1', handled via Number().
- mongo-standalone C2 `late` / `beyond-w` apply no hold at all (writer still counts `late`) — PLAN marks "no late case".
- C2 run always restarts from lw (previous run start − W); a MAX_PAGES-cut run would skip (pos, lw] — a false LOSS
  path, only if nonTerminating > 0 (was 0; max seen 17,768 of 20,000 pages on mongo-standalone C2).
- `MONGO_TXN_NO_RETRY` run: every late tx aborted by the server, so its 0 lost is "nothing committed late"; holds
  between the lifetime limit and the reaper run are untested (PLAN §10 open question).

**How to apply:** when phase 3 ports these into matrix cases, keep inserts dominant (or assert per-version delivery),
add a C1d case with a gap between the final statement and COMMIT and a multi-row case, and pin the MAX_PAGES path.
