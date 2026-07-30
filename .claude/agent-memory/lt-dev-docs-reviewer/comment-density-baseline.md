---
name: comment-density-baseline
description: Measured house-style baseline for src/core comment density — 33% comment lines, 227 blocks >=15 lines, max 61; use it before grading a long narrative JSDoc as "over-commented"
metadata:
  type: project
---

**Long narrative JSDoc blocks that retell a past incident ARE this repo's house style, not an anomaly.**
Measured on `src/core/**/*.ts` (specs excluded), 2026-07-30:

- 55,353 lines, **18,299 comment lines = 33.1%**
- **227 block comments >= 15 lines** (of 2,723 blocks total)
- Longest: 61 lines (`src/core/common/helpers/process-diagnostics.helper.ts`), then 60 (`core-tenant.guard.ts`), 57 (`core-better-auth.controller.ts`), 54/49/47/47 (`server-options.interface.ts`)
- Non-`.ts` precedent is stronger still: `bin/migrate.js` opens with a 27-line docblock, `docker-entrypoint.sh` is ~40 lines of narrative rationale.

**Why:** "Is this 20-line docblock excessive?" is a recurring grading question, and answering *yes* against
this baseline penalises the author for following the codebase's most consistent convention. Recomputing the
number costs a scripted pass over 55k lines, so it is worth carrying.

**How to apply:** Do NOT grade a 15-25 line explanatory block as over-commenting — it lands mid-pack here.
Grade the three things that actually go wrong instead:
1. **Duplication.** The same incident narrative written verbatim in two or three places will drift. (Seen: the
   GridFS chunk-completeness story told twice inside `migration.helper.ts`, plus the "`migrate up` never
   exits" story told in both `migrate-cli.ts` and `migration.helper.ts`.)
2. **Placement.** The half of the narrative that answers *"should I upgrade?"* (user-visible symptom, blast
   radius) is release-note content and belongs in `migration-guides/`; the source should keep only the
   mechanism that answers *"why is this code shaped this way?"*.
3. **Accuracy.** A docblock asserting what a change fixes is a claim to verify against the source, never to
   accept — see [[migrate-cli-exit-guard-dead-through-bin-shim]] and [[ai-module-false-doc-claims]].

A useful secondary signal: the ratio of **added** comment lines to added lines in the diff. 57% in a change
whose files already sit at 40-52% is consistent; it is the duplication, not the ratio, that costs points.
