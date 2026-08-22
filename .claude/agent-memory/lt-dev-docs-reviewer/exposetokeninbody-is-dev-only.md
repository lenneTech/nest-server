---
name: exposetokeninbody-is-dev-only
description: Any bug gated on cookies.exposeTokenInBody affects dev/ci/e2e ONLY — the framework throws at startup in production/staging — so grade its migration-guide severity accordingly
metadata:
  type: project
---

`cookies.exposeTokenInBody: true` **fails the boot** in `production` and `staging`
(`assertCookiesProductionSafe` in `src/core/common/helpers/cookies.helper.ts:86`, since 11.25.0;
called from `src/core.module.ts`). Test-ish envs (`local`, `development`, `ci`, `e2e`) are exempt,
and this repo's own `src/config.env.ts` sets it in two of them.

**Why:** when reviewing a defect whose trigger includes `exposeTokenInBody`, the reachable
population is *only* dev machines and CI/e2e suites — no production deployment can have been
running that config. The 11.36.2→.3 session-cookie/JWT mix-up is the worked example: it reads like
a fleet-wide auth outage until you apply this gate.

**How to apply:** Do NOT grade such a fix as a production-severity incident, and require the
migration guide to *state the scoping* — a guide that omits it triggers needless panic upgrades.
The third precondition is usually the JWT plugin: `shouldConvertSessionTokenToJwt()` returns false
when `betterAuth.jwt` is off, so hybrid mode alone is not sufficient to reproduce. Still warrants a
guide under [[patch-release-migration-guide-convention]], just a calmly-worded one.
