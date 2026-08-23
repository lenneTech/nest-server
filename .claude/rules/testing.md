# Testing Configuration

## Test Framework

**Vitest**, split across two runners. Which one claims a file is decided purely by its filename:

| Runner | Config | Test files | Needs MongoDB |
|--------|--------|-----------|:-------------:|
| Unit | `vitest.config.ts` | `tests/unit/**/*.spec.ts` | No |
| E2E | `vitest-e2e.config.ts` | `tests/**/*.e2e-spec.ts`, `tests/stories/**/*.story.test.ts` | Yes |

**Test files NEVER live in `src/`.** Not a style preference — `src/` is this framework's shipping
artifact: `package.json` → `files` ships all of `src` recursively into the npm tarball, and
vendor-mode consumers copy `src/core/` into their own tree as first-class project code (the CLI's
`convertCloneToVendored` applies no spec filter). A co-located spec therefore reaches every consumer
as a test file they neither run nor maintain, re-delivered on every core update. Co-location is a
fine default for an application; for a library whose `src/` IS the delivery, separation wins.

Enforced twice: the unit runner's glob no longer looks at `src/` at all, and
`tests/unit/test-file-placement.spec.ts` fails on any `.spec.ts`/`.test.ts` found there — so a
misplaced test surfaces as a failure rather than as silently skipped coverage.

| Kind | Where | Suffix |
|------|-------|--------|
| Unit | `tests/unit/` | `*.spec.ts` |
| E2E / integration | `tests/` | `*.e2e-spec.ts` |
| Story (e2e-grade) | `tests/stories/` | `*.story.test.ts` |
| Type-only (compiled, never run) | `tests/types/` | `*.type-test.ts` |

A file matching neither pattern would run nowhere. `tests/unit/test-file-routing.spec.ts` asserts
that every `*.spec.ts` / `*.test.ts` in the repo is claimed by **exactly one** runner, so a
mis-named suite fails the build instead of silently passing. Type-only tests
(`tests/types/*.type-test.ts`) are compiled by `pnpm run test:types`, never executed.

## Infrastructure containers (Redis + S3)

**Eight** e2e suites talk to a **real** Redis and/or a **real** S3-compatible store rather than a
mock, and they **fail loudly** when it is missing — a silently skipped infrastructure test is how an
untested driver ships:

| Suite | Needs |
|-------|-------|
| `tests/redis-infra.e2e-spec.ts` | Redis |
| `tests/redis-consumers.e2e-spec.ts` | Redis |
| `tests/multi-replica.e2e-spec.ts` | Redis |
| `tests/s3-infra.e2e-spec.ts` | S3 |
| `tests/file-storage-parity.e2e-spec.ts` | S3 |
| `tests/file-storage-http-parity.e2e-spec.ts` | S3 |
| `tests/redis-s3-bootstrap.e2e-spec.ts` | Redis + S3 |
| `tests/graceful-shutdown.e2e-spec.ts` | Redis + S3 |

`tests/global-setup.ts` starts both containers automatically, so `pnpm test` works from a clean
machine with no manual docker command. It is idempotent (a running container is reused) and never
fatal: without Docker every other suite still runs, and the eight above report their own actionable
error.

```bash
pnpm run test:infra          # start + wait for readiness (also runs automatically)
pnpm run test:infra:status   # what is running
pnpm run test:infra:down     # stop and remove
```

| | Redis | S3 (RustFS) |
|---|---|---|
| Port | 6380 (6379 is an auth-protected TurboOps Redis on lt dev machines) | 9102 |
| Container | `nest-server-2985-redis` | `nest-server-2985-rustfs` |

**CI provisions its own** containers in `.github/workflows/*.yml` and sets `LT_TEST_INFRA=0` so the
automatic start stays out of the way. Same images, same ports — only who starts them differs. Set
`LT_TEST_INFRA=0` locally too if you want to manage them yourself.

**Bucket cleanup:** every suite that creates a bucket names it per run and removes it in `afterAll`
via `tests/helpers/s3-test-cleanup.ts`. Emptying and deleting belong together — a bucket cannot be
deleted while it holds objects — which is why that lives in one helper rather than per suite. Before
it existed, two empty buckets leaked into the store per run.

## Running Tests

```bash
# Unit + E2E (default) — the E2E half needs MongoDB
pnpm test

# Unit tests only (fast, no MongoDB)
pnpm run vitest:unit

# E2E tests only
pnpm run test:e2e

# Both suites with coverage → coverage/unit + coverage/e2e
pnpm run test:cov

# Run in CI mode (unit + E2E with NODE_ENV=ci)
pnpm run test:ci

# Debug open handles
npx vitest run --config vitest-e2e.config.ts --reporter=hanging-process

# Clean up leftover test artifacts (.txt, .bin files from failed file upload tests)
pnpm run test:cleanup
```

## Test Environment

- Environment: `NODE_ENV=e2e` for the E2E runner (`pnpm run vitest`). The unit runner sets no
  `NODE_ENV`; vitest defaults it to `test`, and `getEnvironmentConfig()` falls back to `config.local`.
- Both runners load `tests/setup.ts` via `setupFiles` (Nest Logger restricted to `error`/`fatal`,
  `@UnifiedField` deprecation warnings filtered).
- Database (E2E only): **one unique database per run** (`nest-server-e2e-run-<ts>-p<pid>`), created by `tests/global-setup.ts` so concurrent runs cannot interfere with each other. Specs needing an extra DB derive it via `deriveTestDbUri('<suffix>')` — never a hardcoded/`Date.now()` name (escapes the cleanup scheme).
- DB lifecycle (`tests/db-lifecycle.reporter.ts`): run passes → DB dropped immediately + stale run DBs from crashed/failed runs collected; run fails → DB kept for debugging. Additionally `tests/global-setup.ts` runs a **startup sweep** (shared `isStaleTestDb()` predicate, dead-PID/age guarded) — leftovers are removed when the NEXT run starts, which survives SIGKILL (check watchdog) and `--reporter` CLI overrides. An externally set `MONGODB_URI` (CI) opts out of the scheme.
- The drop guard (`SAFE_TEST_DB_PATTERN` + `NON_DISPOSABLE_DB_PATTERN`): nothing in the scheme drops
  a database whose name does not carry `e2e`, `ci`, `test` or `acctest` as a **whole segment**
  (`/(^|[-_])(e2e|ci|test|acctest)([-_]|$)/i`). It gates all three drop sites: the externally-set
  `MONGODB_URI` branch, the startup sweep, and the reporter's post-run collection. **The anchoring
  is the point, not decoration.** The original form matched the marker as a substring ANYWHERE, and
  `ci` hides inside soCIal / speCIal / finanCIal / priCIng / muniCIpal, `test` inside laTEST /
  conTEST / TESTimonials. `lt dev up` exports `MONGODB_URI` at the project's DEVELOPMENT database
  (`<slug>-local`), so a developer on a project named e.g. `pricing-portal` who started the e2e
  suite from that shell had their working data dropped BY the guard that exists to prevent exactly
  that. It had never had a test.

  Three things about it are load-bearing and easy to undo:

  1. **`acctest` is a separate alternative BECAUSE of the anchoring** — `test` no longer matches
     inside it, so deleting it as "redundant" silently stops acceptance-test databases from ever
     being collected.
  2. **The externally-set-URI branch is the only drop site with no second condition.** The other two
     also require `isStaleTestDb()`, i.e. the name must belong to this project's own base. So that
     one branch additionally applies `NON_DISPOSABLE_DB_PATTERN` (`-local`, `-dev`, `-prod`,
     `-staging`, …) via `isDroppableTestDb()`: a project slug may legitimately carry a marker as a
     whole word — `ci` is the German abbreviation for *Corporate Identity*, `test` a product noun
     for an exam — and `ci-portal-local` passes the segment rule. It also refuses a URI that names
     **no** database, because the driver would fall back to its default (`test`) and that name
     passes the guard.
  3. **The anchoring is a naming contract on the base DB name.** A base like `shope2e` or
     `app-e2edb` satisfies nothing, and its databases would then accumulate with nothing collecting
     them — silently, which is why both sweep loops now COUNT and log the stale candidates the
     guard refused.

  Pinned by `tests/unit/db-lifecycle-guard.spec.ts` (registered mutation
  `safe-test-db-pattern-unanchored`; reverting the anchoring turns 13 cases red). **The refusal list
  in that spec IS the specification** — extend it rather than loosening the pattern.
- Run governor (`tests/e2e-run-slots.ts`): machine-wide slot dir (`<tmpdir>/lt-e2e-run-slots`) caps concurrent e2e runs across ALL lt projects/sessions (default 2 on ≥8 cores). Further runs wait, logging `[e2e-governor] waiting…` every 15s (keeps the check watchdog fed — a queued run is NOT hung). The e2e config counts foreign slots at load time and drops to low-resource mode (reduced forks, raised timeouts) when another run is active — deterministic, unlike the lagging 1-min load average (kept as second signal). Knobs: `LT_E2E_MAX_RUNS` (0 disables), `LT_E2E_SLOT_DIR`, `LT_E2E_SLOT_TIMEOUT` (fail-open).
- `retry: 2` (e2e) is deliberate — with `retry: 5`, one spec file with broken app/socket state ground through 6 attempts × 30s timeout × 22 tests ≈ an hour at 0% CPU (looked like a deadlock; the check watchdog killed it). Never raise retry to paper over contention.
- Infrastructure containers (E2E only, the **seven** specs listed under "Infrastructure containers"
  above) round-trip against a REAL Redis and/or a REAL S3-compatible store.
  `redis-s3-bootstrap` boots the assembled `CoreModule` with both
  configured — the only test that covers the WIRING, which fakes and directly-constructed
  services cannot: an unresolvable provider or a lifecycle hook that throws on a real
  connection would pass every other spec and fail on a consumer's first `nest start`. `multi-replica` is the acceptance test for the
  distributed features: it builds TWO independent service instances sharing one Redis and
  asserts the properties a second replica must preserve — a scheduled tick and a startup tick
  each run exactly once, one rate limit is enforced instead of one per replica, and a severed
  Redis still yields a decision instead of an error. Single-instance specs against fakes cannot
  show any of that: a limiter counting per process, or a lease key differing per instance,
  passes them and fails here. `redis-consumers` covers the framework's own Redis consumers seen
  from two replicas, `file-storage-s3` runs `CoreFileService` against a real bucket, and
  `graceful-shutdown` needs real connections for `installGracefulShutdown()` to close.
  Five of the seven preflight the connection in `beforeAll` and throw a written diagnosis —
  `redis-infra`, `s3-infra` and `multi-replica` quote the full `docker run` line, `redis-consumers`
  and `file-storage-s3` name the port and how to start it. So a forgotten container is a ~2s clear
  error instead of a 43s opaque `MaxRetriesPerRequestError`. The other two fail fast without a
  custom message: `graceful-shutdown` probes with `connectTimeout: 2000` /
  `maxRetriesPerRequest: 1` and lets the raw connect error surface, and `redis-s3-bootstrap` has no
  separate probe at all — its `beforeAll` IS the boot.

  ```bash
  docker run -d --name nest-server-2985-redis -p 6380:6379 redis:7.4-alpine
  docker run -d --name nest-server-2985-rustfs -p 9102:9000 -e RUSTFS_ROOT_USER=rustfs -e RUSTFS_ROOT_PASSWORD=rustfs-secret -e RUSTFS_VOLUMES=/data rustfs/rustfs:1.0.0-rc.1 server /data
  ```

  Both tags are pinned, and these hints must stay identical to the tags in
  `scripts/test-infra.mjs` / `.github/actions/test-infra/action.yml`. `containerMatches()` compares
  the running container's image against the pinned one, so a hint that says `:latest` starts a
  container the next `pnpm test` tears down and recreates.

  | Service | Port | Overridable via |
  |---------|------|-----------------|
  | Redis | 6380 | `REDIS_HOST`, `REDIS_PORT` |
  | RustFS (S3) | 9102 | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |

  **Why 6380 and not 6379:** on lt dev machines 6379 is occupied by an auth-protected TurboOps
  Redis. Binding the test container to 6380 keeps the two apart — no auth setup, no cross-wiring.
  CI (`.github/workflows/build.yml` / `publish.yml`) maps the same ports and waits for readiness
  before installing dependencies.
- Test helper: `src/test/test.helper.ts`
- Coverage: Collected from `src/**/*.{ts,js}`. The two runners are separate vitest processes, so
  they write separate reports (`coverage/unit`, `coverage/e2e`) rather than overwriting each other.

## Behaviour matrices: test the CONTRACT once, against every implementation

**Rule: when one contract has several interchangeable implementations, there is ONE list of
behaviours and it runs against all of them. Never one suite per implementation.**

File storage is the worked example, and it is a worked example because getting it wrong shipped two
defects. Three drivers (`filesystem`, `gridfs`, `s3`) sat behind one `CoreFileService` contract with
one suite each — different files, different drivers, overlapping intent, no shared list. A behaviour
that was correct under GridFS and broken under `filesystem` had nowhere to surface. 11.33.0 shipped
exactly that (`getRawFileInfoByName()` consulted two of the three stores), and every suite was green.

| Piece | Where |
|-------|-------|
| The matrix — cases, drivers, exclusions, folded-in receipts | `tests/helpers/file-storage-matrix.ts` |
| Per-driver plumbing (config, planting into a non-active store, byte probes) | `tests/helpers/file-storage-drivers.ts` |
| Service-contract executor | `tests/file-storage-parity.e2e-spec.ts` |
| Route-contract executor (boots the real `ServerModule` per driver) | `tests/file-storage-http-parity.e2e-spec.ts` |
| Structural guard | `tests/unit/file-storage-parity-matrix.spec.ts` |

### A cell is EXECUTED, IMPOSSIBLE, or DIFFERENT-BY-DESIGN — never merely absent

Omitting a case for one implementation and declaring it impossible there produce the same artefact
in a report: nothing. That is how a gap hides, so the three states are declared and the guard fails
on anything else:

- **EXECUTED** — the case lists the driver; the executor registers a real `it()` via `parityIt()`.
- **IMPOSSIBLE:** — the behaviour has no equivalent primitive in that store. No `provenBy`, nothing
  registered; there is nothing to assert instead.
- **DIFFERENT-BY-DESIGN:** — the driver behaves differently on purpose. MUST name a `provenBy` case
  that runs for that driver, and MUST register a `parityComplement()` asserting what happens
  instead. A design difference nobody asserts is indistinguishable from a bug nobody noticed.

An exclusion is a claim about the PRODUCT. If you are adding one to get green, you are writing down
a bug.

### Consolidating suites requires a receipt

Folding a per-implementation suite into the matrix must not trade breadth for tidiness. Each case
the old suite asserted gets an entry in `FOLDED_IN` (`from`, `was`, `into`), and the guard asserts
every `into` still names a live case, that the folded-in cases cover **all** drivers, and that the
origin files are gone rather than left behind to drift.

## Regression tests must carry their evidence

**Rule: a test that claims to pin a defect declares `@regression` AND `@seen-failing`, and the
`@seen-failing` line names a mutation registered in `tests/regression-mutations.json`.**

### Why — two vacuous tests, in the session that was fixing the bug

While fixing 11.33.1, two tests written specifically to pin the defect **passed with the defect
fully restored**:

1. The `deleteFileByName()` ownership case drove a rule that read a missing `currentUser` as
   "internal, allow". The broken, context-less inner lookup therefore succeeded too, and the whole
   assertion held with the bug present. It only detects anything because the rule now **fails
   closed**.
2. A by-name lookup case asserted around the defect rather than on it.

Both were caught only because somebody re-broke the source by hand and re-ran them. A green test
looks identical whether it is checking something or nothing; the single thing that separates the two
is having watched it go red — and that observation used to live in terminal scrollback.

### The convention

```typescript
/**
 * @regression   11.33.1 — deleteFileByName() re-resolved the file with an EMPTY context, so an
 *   overridden checkRights() was asked two different questions about one request.
 * @seen-failing Drop `serviceOptions` from the getFileInfoByName() call in
 *   src/core/modules/file/core-file.service.ts — registered as mutation
 *   `delete-by-name-drops-context` in tests/regression-mutations.json.
 */
```

```bash
pnpm run check:mutations                    # apply every registered mutation, require its specs to go RED
pnpm run check:mutations -- --id=<id>       # one mutation
pnpm run check:mutations -- --list          # the registry, without running anything
pnpm run check:mutations -- --allow-dirty   # when the fix and its evidence share a working tree
pnpm run check:mutations -- --jobs=4        # N mutations at a time (default: 2, or 4 on >=12 cores)
pnpm run check:mutations -- --no-infra      # only the 22 that need no MongoDB
pnpm run check:mutations -- --since=<ref>   # only mutations touching files changed since <ref>
```

`--no-infra` and `--since` narrow the run for LOCAL work and are deliberately not wired into the
publish path. Both print how many mutations they did NOT check, because a narrowed run that reports
only what it ran reads exactly like a full pass. An empty selection exits **2**, not 0 — the message
alone would not stop a `&&` chain or a hook from reading "nothing ran" as "everything passed".

`--since` is a **heuristic**: it matches a mutation's own target file and spec files, and does NOT
follow what those specs transitively import or read at runtime (`email-templates.spec.ts` reads
`.ejs` files that appear in no import graph). A refactor three modules away can hollow out a test it
will happily skip — the precise failure this tool exists to catch. It falls back to the full set
when the registry, a vitest config or a setup file changed, since those can move any verdict.

**Why the gate does not cache per-mutation verdicts instead.** It runs ONCE PER RELEASE, not per
commit, so selective re-running would save ~10 minutes a release. The price is a cache that has to
model each spec's full dependency closure correctly, and getting that wrong produces a stale PASS
for a test that has since gone vacuous — exactly what the gate is there to prevent. Bad trade at 53
mutations. Worth revisiting around 100, where the full run approaches half an hour.

Not part of `pnpm run check` — it edits source and re-runs whole e2e suites. It belongs in review
and on the publish path. It is also reachable on demand, without cutting a release:

```
gh workflow run regression-evidence.yml --ref develop                      # the full registry
gh workflow run regression-evidence.yml --ref develop -f args="--no-infra" # the unit subset
```

**Why that matters, and what it cost to learn (11.36.3).** The gate lived only in `publish.yml`,
which triggers on `release: released`. So the only way to observe it on a CI runner was to cut a
release — and when it reported `0/51 mutations confirmed`, diagnosing that required cutting another
one. A gate you cannot run without shipping is a gate you cannot debug.

**A verdict must carry its reason.** `INCONCLUSIVE` exists so a crashed, timed-out or starved run is
not counted as evidence — but the first version reported the verdict and discarded the output that
explained it. `classifyRun()` now attaches the last 25 lines (`tailOf`) and names the exit code.

**The parser must strip ANSI, and this is the load-bearing part.** vitest COLOURS its summary on a CI
runner, so the line carries escape sequences between `Tests` and the number; `\s+` matches whitespace,
never an escape. The count therefore did not parse in CI — and it never had. The *previous* verdict
was `failedCount ?? 'some'` with `ok: true` on any non-zero exit, so it never needed the count: on the
publish path the gate had been accepting a crash, a timeout or a collection error as "went red".

Two consequences worth stating plainly:

1. Requiring a real failure count is what makes the gate a check rather than a rubber stamp. Do not
   relax it back to "non-zero exit is enough" — that is the defect, not a convenience.
2. **Mutation confirmations from CI runs before 11.36.3 are not evidence.** They were verified
   locally (where output is colourless) and stamped in CI. The first trustworthy full-registry run on
   a runner is the `51/51` from the 11.36.3 retag.

Anything that PARSES a spawned run's output belongs behind `stripAnsi()`: the same command is
colourless on a pipe and colourised on a runner, so a regex tested locally can be reliably wrong in
exactly the environment where the answer matters.

### The cost is vitest's cold start, not the tests

Worth knowing before optimising the wrong thing: the specs behind all 31 e2e mutations add up to
**~40 seconds**. The step takes ~740s. The remaining ~700s is paying vitest's startup — process
spawn, transform, module graph, mongod connect, DB create and drop — once per mutation, 53 times.
That work is largely single-threaded I/O and barely scales with cores: the full registry measures
**744s on a 12-core laptop and 777s on a 4-vCPU CI runner**.

So it parallelises well, and `--jobs` does exactly that: **744s → 399s (1.87×) at 4 jobs**. Verified
by diffing all 49 verdicts against a sequential run (measured at the 49-mutation registry) — a
parallel mode that changes a verdict is not
an optimisation, it is a broken safety net.

**A mutation writes into the source tree**, which is why N cannot simply run at once: two mutations
in one tree would see each other's edits and the specs would answer about a source state nobody
registered. Each worker therefore gets its own `git worktree`, with `node_modules` symlinked from
the main checkout (pnpm's internal links are relative, so one symlink serves every worktree).

That isolation has a consequence: a worktree is at **HEAD**, so parallel mode tests COMMITTED code.
When `src/` or `tests/` is dirty — or `--allow-dirty` is passed — the run says so and falls back to
sequential. A fast answer about the wrong source is worse than a slow answer about the right one.
`tests/unit/mutation-jobs-planning.spec.ts` pins that decision. Between runs the registry is kept from rotting by
`tests/unit/regression-evidence.spec.ts`, which asserts every `find` still matches its target
**exactly once**: a stale mutation would silently become a no-op, and a no-op "confirms" evidence
that was never checked.

`tests/unit/regression-evidence.spec.ts` also enforces the other direction — every registered
mutation must be referenced by some `@regression` block, and each referenced mutation must actually
run the file the tag lives in.

Free prose ("Regression guard: …") is untouched by any of this. It predates the convention and often
sits on tests whose defect has no reachable mutation any more; retro-fitting it would produce
ceremony, not evidence. **The tag is the promise.**

### What a reviewer must ask for

When a change adds or edits a test that claims to fix or pin a bug:

1. **"Show me it red."** Either the `@seen-failing` line with a registered mutation id, or the
   pasted output of `pnpm run check:mutations -- --id=<id>`.
2. **"Which cases went red, and under which driver/configuration?"** One red case where you expected
   four means the mutation is not the defect, or the coverage is narrower than claimed.
3. **"Would a permissive fixture also make this pass?"** For anything driving an authorization hook,
   the paired refusal case is mandatory — without it, a rule that has silently gone permissive
   explains the green just as well as the fix does.
4. **"Is the mutation the defect, or a proxy for it?"** A mutation that breaks everything proves
   nothing about the specific behaviour.

## Consumer gate: the starter runs BEFORE publish, not after

`pnpm run check:consumer` builds the tarball (`pnpm pack`), installs it into a **throwaway copy** of
`nest-server-starter`, and runs the consumer's own checks against it.

```bash
pnpm run check:consumer                            # full: the starter's own `check`
pnpm run check:consumer -- --fast                  # typecheck + build + tests (~5 min)
pnpm run check:consumer -- --starter=<path>        # else ../nest-server-starter, or NEST_SERVER_STARTER_PATH
pnpm run check:consumer -- --keep                  # keep the workspace for inspection
```

It is not a duplicate of `pnpm run check`. This repo's suite exercises `src/server` — a consumer
that, by construction, tracks every framework change in the same commit and imports `src/` by
relative path. The starter does neither: it subclasses the shipped `Core*` classes and consumes
`dist/` through the package's public entry points. It therefore catches what nothing else can: a
`files`/`exports` mistake that drops something from the tarball, a signature change only a
**subclass** notices, a `devDependency` used at runtime by framework code, and behaviour that
differs under the starter's configuration.

Wired into `.github/workflows/publish.yml` before the publish step, with `--fast`. Deliberately not
on every push (~5 minutes), and deliberately not the starter's full `check` in CI: that also runs
the starter's own `pnpm audit` / `format:check` / `lint`, none of which say anything about our
tarball — a fresh advisory in one of the starter's own dependencies would otherwise block an
unrelated release.

## Consumer contracts: exercise the extension points, in executed code

**Rule: an overridable seam that only `src/server`'s defaults ever touch is an untested seam.**
`src/server` IS a consumer of `src/core`, but for a long time it was a consumer that took every
default — and a `@Restricted`/`checkRights()`/`securityCheck()` override documented only in a JSDoc
`@example` is never compiled, never type-checked and never run.

| Seam | Contract suite |
|------|----------------|
| `CoreFileService.checkRights()` | `tests/file-ownership.e2e-spec.ts` (+ the parity matrix, per driver) |
| `CoreModel.securityCheck()` | `tests/security-check-contract.e2e-spec.ts` |

A contract suite tests the SEAM, not one consumer of it. `security-check-contract` is the shape to
copy: its models' `securityCheck()` **records its own invocation** (`checkedFor`) as well as
narrowing fields, so "the response looks redacted" — which a `@Restricted` rule, `prepareOutput` or
a typo in the fixture would produce too — becomes "the hook ran, with this user, on this object".

## Structural invariants over `src/`

Some properties cannot be observed by running the code, only by reading it — and a runtime guard
catches the *failure*, never the *disarming* of the safety property.

| Invariant | Guard |
|-----------|-------|
| DI tokens live in import-free leaves (SWC/TDZ) | `tests/unit/import-cycle-invariants.spec.ts` |
| Internal calls forward the caller's `ServiceOptions` | `tests/unit/service-options-forwarding.spec.ts` |
| The parity matrix is complete and honest | `tests/unit/file-storage-parity-matrix.spec.ts` |
| Regression tests carry re-runnable evidence | `tests/unit/regression-evidence.spec.ts` |

`service-options-forwarding` is 11.33.1 generalised: inside `src/core/`, a method that HAS the
caller's context must pass it to every internal call that accepts one. Passing a local derived from
it counts (`const config = { ...serviceOptions, … }`). A call that must genuinely run context-free
says so at the call site — the opt-out is a claim about authorization, so it belongs in the diff:

```typescript
// serviceOptions-forwarding: <why this call must not carry the caller's context>
```

## Test Best Practices

1. **Always run tests before completing changes**: `pnpm test`
2. **Production-ready = all tests pass** without errors
3. **Use TestHelper** for GraphQL and REST API testing
4. **Clean up test data** in `afterAll` hooks
5. **Unique test data** - Use timestamps/random strings to avoid conflicts
6. **One contract, one matrix** — see "Behaviour matrices" above before writing a second suite for
   the same contract with a different implementation
7. **A regression test carries `@regression` + `@seen-failing`** — see "Regression tests must carry
   their evidence"

## Test File Structure

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { TestHelper } from '../../src';

describe('Feature Name', () => {
  let testHelper: TestHelper;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [ServerModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    await app.init();
    testHelper = new TestHelper(app);
  });

  afterAll(async () => {
    // Cleanup test data
    await app.close();
  });

  it('should do something', async () => {
    const result = await testHelper.graphQl({
      name: 'someQuery',
      type: TestGraphQLType.QUERY,
      fields: ['id', 'name'],
    });
    expect(result.data.someQuery).toBeDefined();
  });
});
```

## WebSocket/Subscription Tests

When testing GraphQL subscriptions, use `httpServer.listen(0)` instead of `app.listen()`:

```typescript
// CORRECT: No startup log, dynamic port
await app.init();
const httpServer = app.getHttpServer();
await new Promise<void>((resolve) => {
  httpServer.listen(0, '127.0.0.1', () => resolve());
});
const port = httpServer.address().port;
testHelper = new TestHelper(app, `ws://127.0.0.1:${port}/graphql`);

// Cleanup in afterAll
if (httpServer) {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
await app.close();
```

```typescript
// WRONG: Produces "Nest application successfully started" log
await app.init();
await app.listen(3030);
```

**Why:**
- `app.listen()` triggers NestJS startup log -> noisy test output
- Dynamic port (`0`) avoids port conflicts between parallel tests
- Explicit `httpServer.close()` prevents open handle warnings

## TestHelper Reference

Full documentation for TestHelper (REST, GraphQL, Cookie support):
`src/test/README.md` (also available in `node_modules/@lenne.tech/nest-server/src/test/README.md`)

## Common Test Issues

- **Tests timeout**: Ensure MongoDB is running
- **Open handles**: Run vitest with `--reporter=hanging-process` to debug
- **Data conflicts**: Use unique identifiers per test
- **"NestApplication successfully started" log**: Use `httpServer.listen()` instead of `app.listen()`
