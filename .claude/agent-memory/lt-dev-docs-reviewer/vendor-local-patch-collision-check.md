---
name: vendor-local-patch-collision-check
description: When a diff changes a core seam, check the local-patch registers of vendor-mode consumers — a clean 3-way merge can silently neutralize a downstream patch the guide never mentions
metadata:
  type: feedback
---

Before judging "does the migration guide cover everything a consumer observes", grep the
`src/core/VENDOR.md` local-patch tables of the vendor-mode consumer checkouts on this machine for the
files the diff touches. Upstream behaviour can be unchanged for npm consumers while a downstream
patch in the same function stops working.

**Why:** 11.42.9 review (2026-10-07). The diff added a framework-owned `generateUrl` to the
`@tus/server` options in `CoreTusService.createTusServer()`. In `@tus/server` 2.4.5
`BaseHandler.generateUrl()` a user `generateUrl` is consulted BEFORE `relativeLocation`, so a
vendor consumer's local "upstream-candidate" patch passing `relativeLocation: true` (added after a
production incident behind a same-origin proxy) would merge cleanly — its lines sit between `path:`
and `respectForwardedHeaders:`, which upstream never touched — and then do nothing. Its e2e helper
accepted both absolute and relative `Location`, so the sync would stay green. Nothing upstream
(guide, README, rules) could have flagged it; only the patch register did.

**How to apply:** for any diff touching a core file, list the vendor consumers' patch rows that name
that file and ask (1) does the patch still merge, (2) does it still take EFFECT (precedence/override
inside the library), (3) would the consumer's own tests notice. Keep customer names out of anything
written into this repo (public); name the pattern, not the project.
Related: [[vendor-mode-atomic-file-set-check]], [[review-committed-vs-working-tree]].
