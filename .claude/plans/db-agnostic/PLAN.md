# Database-agnostic nest-server — one framework, the database as a dimension

> **Status:** planned, not started. No code on this branch yet beyond this directory.
> **Branch:** `feat/db-agnostic` (branched off `develop` at 11.34.0)
> **Read this file completely before writing any code.** It contains the decision,
> the evidence behind it, the abort criteria, and the constraints. Skipping to the
> task list will produce the wrong thing.

---

## 1. The goal, in the owner's words

> „Ich brauch einen sauberen, stabilen und vor allem sicheren Stand … Ich hätte
> gerne **ein Projekt an dem alle gemeinsam arbeiten, egal welche Datenbank
> verwendet wird, ähnlich wie bei REST und GraphQL**."

and

> „Ich möchte aber nicht zwei Projekte pflegen müssen. Außerdem ist es so viel
> schwieriger sicherheitsrelevante Dinge zu entdecken und in zwei Projekten zu
> fixen."

**The objective function is not "cheapest path to Postgres".** It is: one codebase,
one security model, one place to fix things — with the database as a swappable
dimension. Anyone re-deriving a recommendation must optimise for that, or they will
land on a different answer (as the first analysis did — see §7).

The REST/GraphQL analogy is load-bearing and it checks out structurally:
`graphQl: false` is 25 conditional wirings in `src/core.module.ts`, and
`CoreFileResolver` / `CoreFileController` take the *same* `CoreFileService` — the
service does not know which surface called it. The difference is that persistence
sits *below* the service rather than beside it, which is exactly where the work is.

---

## 2. The decision

**Two `CrudService` implementations selected at module registration, sharing the
DB-agnostic upper layers.** (Referred to as "option C" in the source analyses —
it was the third of five candidates evaluated; §4 records why the other four lose.)

`MongooseCrudService` is aliased as `CrudService`, so **nothing breaks for existing
projects** — which is this approach's decisive advantage over a repository/port abstraction.
Divergence lives in the escape hatches and is honest: Mongo keeps `aggregate`,
`$facet` and populate; Postgres gets `$queryRaw`, `include` and `groupBy`.

### What "equal status" honestly means

The analogy also supplies the answer to the hardest framing question. **nest-server
already does not promise GraphQL subscriptions over REST.** Per-driver capability
differences are the *existing* pattern, not a failure of the abstraction.

| Promise | Refuse in writing, up front |
|---|---|
| The 13 already-agnostic CRUD methods | `aggregate()` and any `PipelineStage` |
| The whole filter DSL (`FilterInput`, `CombinedFilterInput`, `SingleFilterInput`; all 10 comparison operators map 1:1 to Prisma) | `samples` / `$sample` |
| Offset pagination, sort, total count | `pushToArray` / `pullFromArray` with `$slice` / `$position` / `$sort` |
| The entire rights engine — `@Restricted`, `@Roles`, `S_*`, `securityCheck()`, all four interceptors | Subdocument arrays, `Mixed` |
| REST + GraphQL surface | GridFS |
| Redis, S3, rate limiting, cron, graceful shutdown, permissions module | `ServiceOptions.populate` in its Mongoose form, `collation` |
| | The raw `{ filterQuery, queryOptions }` arm |
| | Portability *between* drivers after init |
| | Multi-tenancy in v1 — decide separately, see §3 |

**The single most dangerous thing this project could do** is carry over CLAUDE.md's
nine High-Frequency Path rules silently. They instruct developers to bypass
`CrudService` and call `Model.create()` / `findByIdAndUpdate().lean()` directly
*because the Mongoose plugins still fire*. On the Prisma side the interception
mechanism and its escape hatches are different. Those rules must be rewritten
per-driver, not inherited.

---

## 3. The gate — run this BEFORE writing a driver

Two weeks, scratch branch, builds nothing reusable. It targets what is most likely
to kill the project, not what is easiest to build.

**Question:** Can a Prisma client extension reproduce the tenant plugin's
**fail-closed `ForbiddenException`** across all query paths *and* survive
`$queryRaw`?

Why this and nothing else: `mongoose-tenant.plugin.ts` (198 LOC) hooks 12 query
hooks plus `save`, `insertMany`, `bulkWrite` and `aggregate` (unshifting a `$match`
into the pipeline), and it **throws** when a tenantId-bearing schema is touched
without valid tenant context. Prisma client extensions **cannot intercept
`$queryRaw`**. Postgres offers RLS, which is categorically stronger — enforced by
the database, unbypassable — but it is a *different mechanism* with *different
behaviour*: RLS returns zero rows where the plugin throws.

„Nicht erlaubt" and „gibt's nicht" are different answers, and existing projects'
error handling depends on the first one.

`nest-base` proves RLS works and is auditable (it ships a `check:rls` CI job that
inspects `pg_class.relrowsecurity` and checks whether the connecting role has
`rolbypassrls`). So the question is not *whether* Postgres can do tenancy — it is
whether the two mechanisms can be made to **answer the same way**.

### Concrete experiment

1. Implement `CoreTenantMemberModel` (and `CoreAiToolGrant` for its TTL index) on
   Prisma/Postgres behind a `PrismaCrudService` supporting only the 13 agnostic
   methods plus the filter DSL. Run the **existing tenant e2e suite** against it.
2. Port the five upsert-race sites to a `LockStore` (no-regret item 1, §5) and write
   ONE contract suite with a real N-worker race, run against Mongo, Redis **and**
   Postgres.
3. Count the lines actually touched for two models on two drivers.

### Abort criteria — these are not advisory

- **If tenancy cannot be preserved with matching semantics: STOP.** That is the line
  between "equal status" and "a second-class Postgres mode", and shipping the latter
  under the former's name is the worst outcome available.
- **If more than ~1,500 LOC of new+touched code is needed for two models on two
  drivers**, the full port exceeds ~15,000 — reconsider.
- `CoreAiToolGrant` uses `expireAfterSeconds: 0`. Postgres has **no TTL index**.
  Does the answer require `pg_cron` (new infrastructure for every project) or a
  framework-owned sweeper (which itself needs a lease, which needs item 1)?

---

## 4. Why the alternatives lose

Recorded so nobody re-litigates them without new information.

| | Why it loses |
|---|---|
| **A — Prisma-only, Mongo via Prisma's connector** | The only option that makes *existing* users strictly worse off. **Prisma 7 does not support MongoDB** ("MongoDB support for Prisma ORM v7 is coming in the near future. In the meantime, please use Prisma ORM v6.19" — verified 2026-08-11 at prisma.io/docs). Its Mongo connector **requires a replica set**; `replSet` / `rs.initiate` appear nowhere in nest-server, nest-server-starter or lt-monorepo, so this re-platforms every existing deployment before one line of business logic changes. Also: no Prisma Migrate on Mongo ("no plans"), no `Decimal`, no `autoincrement()`, and **Prisma cannot distinguish explicit `null` from a missing field** — which `prepareInput` / `mergePlain` PATCH semantics depend on. |
| **B — repository/port beneath `CrudService`** | Leaks at exactly the three places the value lives: the raw `filterQuery` arm (on `find`/`findOne`/`findAndCount`/`findAndUpdate` plus every `Force`/`Raw` variant), `aggregate()` (3 public methods, no honest neutral type), and `ServiceOptions` on all 35 methods — `populate` is the killer, because Mongoose's string-path model and Prisma's typed `include` only map in the simple cases. |
| **D — Mongo for framework infra, Postgres for the domain** | Removes 80 % of the difficulty, but the **wrong** 80 %. Domain entities in Postgres get no Mongoose plugin, so no fail-closed tenancy; any write spanning a domain entity and a user is a cross-database write with no transaction — reintroducing the exact bug class Postgres was chosen to remove; `populate` cannot cross the boundary. It keeps the framework whole by making the domain layer — the part the customer cares about — second-class. |
| **E — don't do it; `nest-base` is the Postgres answer** | This was the FIRST recommendation and it was wrong for this objective function. See §7. |

---

## 5. Sequencing — the no-regret work comes first

Each item must pay for itself **on the Mongo path alone**. Under this plan they are
not hedges, they are prerequisites.

| # | Work | ~LOC | Why it is justified today, independent of Postgres |
|---|---|---|---|
| 1 | **`LockStore` for the five upsert-race sites** | ~400 | Today: three different mechanisms, three different failure policies, **no shared test**. Sites: system-setup claim (reachable **anonymously** via `POST /system-setup/init`), migration lock (15 s heartbeat + stale takeover), cron lease (fails **open** by design), AI tool grant, better-auth user link. One `tryAcquire(key, ttl) → token \| null` / `renew` / `release` contract plus one N-worker race test is better engineering regardless. **It also defuses the single most dangerous porting trap: Prisma's `upsert()` is NOT atomic against a concurrent insert** — a naive port compiles, passes every single-process test, and lets two replicas both create the initial admin. The five sites currently detect the loss by string-matching Mongo's `E11000` error text. |
| 2 | **Pay down the ID drift** | ~200 | `CorePersistenceModel.id` is *already* `string`; the leakage is in `IdType` / `StringOrObjectId` (both `import { Types } from 'mongoose'`) and in `getObjectIds` (only **16 call sites** outside its own file, in 2 files). `id.helper.ts`'s own docblock says it exists to break an SWC-TDZ cycle and must stay a leaf — removing its last runtime mongoose import makes that true rather than aspirational. **Also pre-existing debt to pay first:** better-auth's `session.userId` are real BSON ObjectIds and `better-auth-token.service.ts` does `Types.ObjectId.isValid(payload.sub)` on the **JWT hot path**. |
| 3 | **Neutral field-metadata record from `@UnifiedField`** | ~150 | 651 LOC, of which **16** emit Mongoose (`unified-field.decorator.ts:546-561`), 259 usages. Today it emits GraphQL + Swagger + validation + `@Restricted` + `@Prop` and keeps **nothing**. Emit a `Reflect.defineMetadata` record: name, base type, array-ness, optionality, roles, `ref` **+ cardinality**, unique, index, default. Immediate payoff: the Hub's models/ERD panel and `model-doc.service.ts` currently reverse-engineer structure from Mongoose schemas; `FRAMEWORK-API.md`'s generator gets a real source; `lt server addProp` gets something to read instead of regex. Only **5** `ref:` declarations exist repo-wide — adding cardinality is a 5-line change now and archaeology in three years. **This is also the only thing that makes a second CLI generator target cheap rather than a fork.** |
| 4 | **Test seeding/teardown facade** | ~300 | ~368 assertions reach into `collection('users' \| 'session' \| 'account')` — i.e. they assert on **better-auth's wire format**, a fast-moving external dependency. A `TestDb` facade collapses 368 brittle couplings to ~10. Worth doing if Postgres never happens. |

**Explicitly NOT no-regret — do not do speculatively:** a repository interface, a
Prisma driver, neutralising `ServiceOptions`, touching better-auth's storage.

---

## 6. The assets — what is already driver-free

This changes the size of the job materially and must not be re-derived from scratch.

| Component | LOC | Note |
|---|---|---|
| `common/helpers/input.helper.ts` | **858** | The entire field-level rights engine. **Zero** mongoose references. |
| `common/decorators/restricted.decorator.ts` | 444 | Imports only `equalIds` / `getIncludedIds` from the string-based `id.helper`. |
| All four interceptors | 477 | `check-response`, `check-security`, `response-model`, `translate-response`. Duck-typed on `typeof item.toObject === 'function'` — degrades correctly to POJOs, which is what Prisma returns. |
| `common/models/core-model.model.ts` | 135 | `map` / `mapDeep` / `init` / `securityCheck`. Zero mongoose. |
| `modules/permissions/` | — | Zero mongoose. |
| `RequestContext` (AsyncLocalStorage) | — | The context every plugin reads. Backend-neutral. |
| Redis / S3 / `RateLimitStore` / `installGracefulShutdown` | — | Already optional, already abstracted. |
| Filter DSL inputs | — | Fully DB-agnostic; only `generateFilterQuery()` emits Mongo. |
| `TestHelper` | 896 | **One** Mongoose branch (`test.helper.ts:531-532`). |
| Test infrastructure | — | Run governor, runner routing, `SAFE_TEST_DB_PATTERN`, `isStaleTestDb()`, `scripts/test-infra.mjs` container registry — all backend-neutral. **A Postgres container is one array element.** |

**Of `CrudService`'s 35 public methods, 13 already have DB-agnostic signatures**
(`create`/`createForce`/`createRaw`, `get`/`getForce`/`getRaw`, `update`×3,
`delete`×3, `distinct`). The other 22 carry `PipelineStage`, `QueryFilter`,
`QueryOptions`, `PopulateOptions`, `Types.ObjectId`, `Document`, `Query` or
`MongooseModel`.

---

## 7. Why the first recommendation was E, and why it changed

Recorded honestly so the reversal is auditable rather than looking like drift.

The first analysis optimised for **cheapest path to Postgres** and concluded E:
keep nest-server Mongo-native, finish `nest-base` (Bun + Prisma 7 + Postgres 18,
reachable via `lt fullstack init --next`, actively maintained). Two things changed
the answer:

1. **The objective function is different** (§1).
2. **`nest-base` cannot serve as the fallback that E assumed.** It is 3.5 months
   old, 97 % of it written by an agent loop in a five-week window, **0 releases ever
   cut**, 2 human contributors, one consumer project still mid-development.
   Critically, its documented three-layer authorization model has **one layer that
   does not exist**: `@casl/prisma` is a declared dependency and is imported nowhere
   in `src`, so per-record `accessibleBy` filtering — the layer that would do
   per-record authorization — is absent. Layer 1 degrades to a subject-*type* check
   (the guard passes a string, so CASL conditions cannot evaluate). Its output field
   allowlist is **inert on every default subject** (member rules ship `fields: []`,
   which means "no restriction"), and the fail-loud path is hardcoded to `mask`,
   making it unreachable in production. `securityCheck()` has no equivalent at all;
   `S_CREATOR` / `S_SELF` have no expression.

**Therefore: security knowledge does not transfer between the two codebases — not
merely twice, but in two different vocabularies.** That is the concrete answer to
the owner's concern, and it is what makes one codebase the right call.

`nest-base` is nonetheless **ahead on infrastructure and hygiene**, and should be
treated as a **donor, not a competitor**. Worth harvesting into nest-server:

- **Postgres RLS as a database-enforced tenancy floor**, plus its `check:rls` CI
  audit. nest-server's tenant isolation is application-layer only.
- **Contract-drift CI gates**: OpenAPI snapshot drift, generated-SDK drift, a
  route-gating audit asserting every route carries `@Can`/`@Public`.
- **Operational primitives nest-server lacks entirely**: idempotency keys,
  ETag/If-Match optimistic concurrency, transactional outbox, HMAC-signed webhooks
  with retry, AES-256-GCM field encryption with KEK rotation, OpenTelemetry +
  Prometheus, GDPR export/erasure, Postgres FTS.
- **Type hygiene**: 9 `any` in 62k LOC, against nest-server's 721 in 66.6k. That is
  the difference between refactors the compiler catches and refactors it does not.

---

## 8. Non-negotiable constraints for whoever implements this

These are not style preferences. Every one of them exists because it was violated
during the 11.33.x / 11.34.0 work and cost a shipped defect.

1. **`pnpm run check` is green after every step, and the test count never goes
   down.** Baseline on this branch: **11 steps, 3083 tests / 146 files, audit 0**.
   A red check is stop-and-fix, never something to work around.
2. **Every behaviour fix ships with a test that fails without it — and that failure
   must be *observed*, not assumed.** Register it in `tests/regression-mutations.json`
   and run `pnpm run check:mutations`. Four vacuous regression tests were caught this
   way in one session, one of them written by the same agent that wrote the fix. An
   unverified claim of coverage carries no weight here.
3. **Never weaken an assertion to make something pass.** If a test encodes old
   behaviour you are deliberately changing, update it *and say so explicitly*.
4. **`src/core/` must stay self-contained** — no import pointing outside it, or
   vendor-mode consumers break. DI tokens live in import-free leaf files
   (`.claude/rules/architecture.md` → "DI Token Placement (SWC-Safe)"); verify with
   `pnpm run check:swc-tdz` and `npx madge --circular --extensions ts src/`.
5. **Optional peers stay lazy-imported and every non-configured fallback keeps
   working.** A project using neither Redis nor S3 — nor Postgres — installs nothing
   extra and behaves exactly as before.
6. **No `@ts-ignore`, no `eslint-disable`, no skipped tests, no `--passWithNoTests`.**
7. **Comments explain WHY, in English.** And they must be *true*: eight of thirteen
   findings in the second review round were comments describing behaviour the code
   did not have. Re-read what you write against the code.
8. **The reference server must exercise the extension point, not just the default.**
   `src/server` took every default and that is why a shipped bug had no test. Any new
   seam gets used there, as code, not as a commented `@example`.

### The ratchet already in place — use it

| Gate | What it does |
|---|---|
| `pnpm run check:mutations` | Re-applies each historical defect and asserts the specs go red. 14/14 confirmed. A `find` matching 0 times is a **rotted** entry and counts as failure. |
| `pnpm run check:consumer` | Packs the tarball, copies `nest-server-starter` to a temp dir, runs its checks against it. This is the gate that would have caught the 11.33.1 bug before release. Wired into `publish.yml`. |
| `tests/unit/service-options-forwarding.spec.ts` | AST invariant: an internal call must forward `serviceOptions`. Two shipped defects were literally "the sibling forwards, this one does not". |
| `tests/file-storage-parity.e2e-spec.ts` + `tests/helpers/file-storage-matrix.ts` | One matrix × three drivers. **Untested and impossible cells are structurally different** — every cell is `EXECUTED`, `IMPOSSIBLE:` or `DIFFERENT-BY-DESIGN:`, and an undeclared cell fails the build. **This is the model to copy for the Mongo/Postgres matrix.** |
| `tests/unit/regression-evidence.spec.ts` | `@regression` requires `@seen-failing` naming a registered, still-matching mutation. |

---

## 9. Downstream — not optional, and not a follow-up

Any approach that ignores these is incomplete.

- **`lt` CLI** (`~/code/lenneTech/cli`): all four `nest-server-module` templates plus
  `nest-server-object` hardcode `@nestjs/mongoose` / `SchemaFactory` /
  `MongooseModule.forFeature`. `lt server addProp` has **`ObjectId` as a first-class
  property type** and is ts-morph surgery assuming `getClasses()[0]` is the model,
  with string heuristics on rendered type text (`includes('ObjectId')`). There is no
  seam: the Mongoose emission is a nested ternary building a template string at
  `src/extensions/server.ts:522-531`, **duplicated** at
  `src/commands/server/add-property.ts:305-319`. Estimated ~25-30 files, ~1,500-2,000
  LOC.
- **Vendor mode**: `convertCloneToVendored()` copies `src/core` with a fixed 7-entry
  whitelist and `filesystem.copy` — no filter, all-or-nothing. **69 files in
  `src/core/` import mongoose, totalling 22,692 LOC**, so without subsystem-aware
  vendoring every Postgres vendor project receives the entire Mongoose driver as
  first-class code it must maintain. **This is a precondition, not a
  follow-up**, and it is a cross-repo change.
- **Optional peers are invisible to vendor mode**: `convertCloneToVendored` reads only
  `dependencies` / `devDependencies`; `vendor-runtime-deps.json` is a flat
  `string[]` with no predicate. "Install only the driver you use" is **not
  expressible** without a new schema shape.

---

## 10. First actions for a fresh session

1. Read this file. Then read the three source analyses referenced in §11 if any
   number here needs re-deriving — **do not re-run the analyses from scratch.**
2. Confirm the baseline: `pnpm run check` (expect 3083/146), `pnpm run check:mutations`
   (expect 14/14).
3. Start with **no-regret item 1 (`LockStore`)**. It is the highest-value item, it is
   justified on the Mongo path alone, and step 2 of the gate experiment depends on it.
4. Only then run the gate experiment (§3). **Do not write a Prisma driver before the
   tenancy question is answered.**

## 11. Where the evidence lives

The numbers in this file come from three analyses run on 2026-08-11 against
nest-server 11.33.0 and the ~30 nest-server backends under `~/code`:

- **Coupling inventory** — `src/core/` is 61,185 LOC of which **~1,167 touch a
  Mongo/Mongoose API** (~1.9 %), concentrated in five places carrying security,
  identity and atomicity. **Zero MongoDB transactions are used anywhere.**
- **Portfolio survey** — 30 backends, 24 live, **10 vendor / 14 npm**. 404 model
  files, 4,197 Mongoose property declarations, 634 `@InjectModel`, **~96
  `.aggregate(` calls across ~500k LOC with 12 of 24 projects at zero**. Three
  projects carry documented data-corruption hazards from the missing transactions
  (a §14-UStG gap-free invoice sequence, a 21-model tenant retag, a hand-rolled
  write-ahead log). **Nobody built a repository layer** — `CrudService` is not
  failing people; it fails at exactly one place, having no transaction or
  atomic-primitive API. **TurboOps already runs PostgreSQL inside a nest-server
  project** (Kysely, real `BEGIN`/`COMMIT`, entirely beside `CrudService`) and
  needed nothing from the framework.
- **`nest-base` assessment** — see §7.

Full reports are in the session transcript of 2026-08-11/12. If a claim here matters
to a decision and cannot be re-derived from the code in minutes, re-verify it rather
than trusting this summary.
