---
name: project-postgres-test-infra
description: PostgreSQL test container (feat/db-agnostic, DEV-3829) — how to prove the CI action and scripts/test-infra.mjs work without touching the developer's live containers; hoisted-layout build-script scan
metadata:
  type: project
---

Since DEV-3829 (branch `feat/db-agnostic`, reviewed 2026-10-28) the test infrastructure has a third
container: `postgres:18.6-alpine3.24` on 5440, owner `nest_owner` (= POSTGRES_USER, superuser) and app role
`nest_app` (NOSUPERUSER NOBYPASSRLS) created by the readiness probe. Local name
`nest-server-2985-postgres`, CI name `ci-postgres` (action input default; the workflows' teardown env
lists only Redis/RustFS — harmless while every job is `runs-on: ubuntu-latest`).

**Why:** both readiness probes connect over TCP (`psql -h 127.0.0.1`) on purpose — the image's init-phase
temp server listens on the unix socket only, so a TCP success means the FINAL server is up and the
init restart can no longer cut connections. Verified in `docker logs` (temp server: socket only).

**How to apply (proof recipes, no side effects on the dev machine):**
- CI action: extract the two Postgres `run:` blocks from `.github/actions/test-infra/action.yml`,
  substitute the inputs with a throwaway name/port, run them with `bash`, then log in from the host as
  both roles with the `pg` driver. `docker rm -f` afterwards.
- Local script: copy `scripts/test-infra.mjs` to the scratchpad with `sed 's/nest-server-2985-/review-local-/g'`,
  run with `REDIS_HOST=remote.invalid S3_ENDPOINT=http://remote.invalid:9 PG_PORT=<free>` so only Postgres is
  created, run `up` twice (create + reuse path), then `down`. NEVER run the real script with a changed
  PG_PORT: `containerMatches()` fails and it `docker rm -f`s the developer's live container.
- `nodeLinker: hoisted` makes `pnpm ignored-builds` print "no node_modules found"; to check that new
  deps add no unclassified install scripts, scan every `package.json` under a scratch frozen install
  for pre/install/postinstall/binding.gyp and compare against `allowBuilds`.

Related: [[project-infra-surface]], [[project-pnpm-audit-and-overrides]].
