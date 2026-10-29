---
name: project-mysql-test-infra
description: MySQL 8.4 / MariaDB 11.8 test containers (feat/db-agnostic, DEV-3848 phase 6) — why the TCP readiness probe is sound for both entrypoints, measured init times, side-effect-free proof recipe for the CI action and scripts/test-infra.mjs
metadata:
  type: project
---

Since DEV-3848 (reviewed 2026-10-29) the test infrastructure has five containers: the Postgres one
plus `mysql:8.4.10` on 3316 and `mariadb:11.8.8` on 3317 (local `nest-server-2985-mysql/-mariadb`,
CI `ci-mysql/ci-mariadb`). Accounts are created by the readiness probe: `nest_owner` (ALL ON *.* WITH
GRANT OPTION) and `nest_app` (USAGE only). `tests/helpers/mysql-test-db.ts` grants DML per database.

**Why the probe is safe:** both image entrypoints start their init-phase temporary server with
`--skip-networking`; `docker logs` shows `port: 0` for the temp server and `port: 3306` only for the
final one. The probe runs `docker exec <c> mysql|mariadb -h 127.0.0.1 -uroot …` (TCP), so it cannot
succeed before the final server. Measured cold init: MySQL ~7-8 s, MariaDB ~3-4 s (local
arm64). Both images are multi-arch (amd64 + arm64). The local `waitFor` timeout is 60 s, the CI loop 120 s.

**How to apply (proof recipe, no effect on the developer's live containers):**
- CI action: extract the two MySQL/MariaDB `run: |` blocks from `.github/actions/test-infra/action.yml`
  with node, substitute the inputs with `review-ci-*` names and free ports (23316/23317), run with bash.
- Local script: `sed 's/nest-server-2985-/review-local-/g'` copy, run with `REDIS_HOST=remote.invalid
  S3_ENDPOINT=http://remote.invalid:9 PG_HOST=remote.invalid MYSQL_PORT=23316 MARIADB_PORT=23317`,
  `up` twice (create + reuse), then `down`.
- Verify from the host with the repo's `mysql2` (createRequire on the repo package.json): owner creates
  a DB + table + grant, app inserts/selects, app DDL is refused. Do NOT put `DROP DATABASE` in a probe:
  a PreToolUse hook blocks it. `docker rm -f` the throwaway containers instead.

Related: [[project-postgres-test-infra]], [[project-pnpm-audit-and-overrides]].
