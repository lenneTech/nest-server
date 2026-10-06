---
name: project-starter-image-smoke-and-ci-tokens
description: Smoke-running the nuxt-base-template image needs an API URL (without one GET / OOMs, pre-existing), and which base-repo CI pipelines pass GITHUB_TOKEN to the check-overrides / check-suppressions guards
metadata:
  type: project
---

**1. The nuxt-base-template image OOMs on `GET /` when no API URL is set.** Verified 2026-10-06 at
nuxt-base-starter HEAD and on the working tree (identical behaviour). The container logs
`Listening on http://0.0.0.0:3000` and the `[LtExtensions] No API URL configured for SSR` warning.
The first render then climbs to the 2 GB heap limit and the container exits with code 139. With
`-e NUXT_PUBLIC_API_URL=… -e NUXT_API_URL=…` (even an unreachable `http://127.0.0.1:9`), `/` and
`/auth/login` answer 200 in about 50 ms and the HEALTHCHECK turns healthy.

**Why:** a bare `docker run` smoke test looks like "the change broke the image" when it did not.
Real deployments always set the API URL. Note this fact during a review, but do not file it as a
finding against an unrelated diff.

**How to apply:** always pass the API URL when you smoke-run the app image. If `/` fails without it,
build HEAD (`git archive HEAD nuxt-base-template | tar -x -C <scratch>`) and compare before you
attribute the failure to the change.

**2. Which CI pipelines send a token to the Advisory-API guards** (as of 2026-10-06; re-check the
workflow files before relying on this):
- nest-server `build.yml` / `publish.yml`: send `secrets.GITHUB_TOKEN`.
- nest-server-starter `test.yml` (Run check): sends `secrets.GITHUB_TOKEN`.
- nuxt-base-starter ROOT `test.yml` (Run check, which chains into the template): sends `github.token`.
  The template's OWN `.github/workflows/test.yml` ships to generated projects and runs no `check`
  at all, so neither guard runs there.
- lt-monorepo `test.yml` audit job and `.gitlab-ci.yml` audit job: run `check:overrides` with NO
  token. In the template repo this is moot because the root has `ignoreGhsas: []`, so nothing is
  looked up. Generated projects, however, carry the hoisted union of the starter and template
  suppressions, so their lookups are unauthenticated (60 requests/hour per IP). Under `CI`, an
  unverified suppression FAILS the job. This predates wave 2b; flag it only when a diff touches
  that workflow or that escalation.

Related: [[project-cross-repo-patch-hoist-contract]], [[project-pnpm-audit-and-overrides]].
