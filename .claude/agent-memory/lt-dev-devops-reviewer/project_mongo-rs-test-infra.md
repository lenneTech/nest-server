---
name: project-mongo-rs-test-infra
description: One-node MongoDB replica set test container (DEV-3901, sixth container) — why the readiness probe is sound, how to prove the CI action without Docker, the in-progress-job log trap
metadata:
  type: project
---

Since DEV-3901 (branch `feature/dev-3901-offline-sync-4-sync-modul`, reviewed 2026-10-31) the test
infrastructure has a sixth container: `mongo:8.0.4 --replSet rs0 --bind_ip_all` on 27019 (local
`nest-server-2985-mongo-rs`, CI `ci-mongo-rs`), used only by `tests/sync-contract.e2e-spec.ts`
(`directConnection=true`, own DB per run, drop-guarded, dropped in afterAll).

**Why the probe is sound:** no `MONGO_INITDB_*` env and no init scripts, so the image has no temp-server
phase. `rs.status()` throws in mongosh before initiation (NotYetInitialized), so the `try/catch` initiates
exactly once; a race throws AlreadyInitialized → non-zero exit → retry. Ready additionally requires
`db.hello().isWritablePrimary === true`, which stays false through election AND drain mode. Member host
`127.0.0.1:27017` is container-internal; the published port never enters the config.

**How to apply:**
- Proof without Docker (when Docker must not run locally): the composite step's
  conclusion in the Build run. Its sub-step exits 1 after 60s if not primary, so `success` proves it.
- `gh api .../actions/jobs/<id>/logs` answers `BlobNotFound` 404 while the job is still running — read
  step conclusions via `gh run view --json jobs` instead of waiting for logs.
- Workflow teardown still removes only Redis/RustFS (pre-existing, harmless on `ubuntu-latest`).
- `scripts/check-without-mongodb.mjs` runs `test-infra.mjs up` locally, so it now starts this container too.

Related: [[project-postgres-test-infra]], [[project-mysql-test-infra]], [[project-infra-surface]].
