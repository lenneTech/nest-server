---
name: executable-doc-recipes
description: Which doc recipes and test claims can be executed to verify them (dotnet yes, pwsh no, Better-Auth OpenAPI, mutation replay in the scratchpad) without editing the working tree
metadata:
  type: reference
---

When a README ships cross-language recipes (e.g. the API-token signed-assertion recipes in
`src/core/modules/api-token/README.md`), execute them instead of eyeballing:

- **C#:** .NET 8 SDK at `~/.dotnet/dotnet` (not on PATH). Scratchpad console project
  (`net8.0`, `ImplicitUsings`), `DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 ~/.dotnet/dotnet run`.
- **PowerShell:** `pwsh` is NOT installed — emulate its output shape in Node instead (hashtable key
  order differs; `ConvertTo-Json -Compress` emits Int64 as a number).
- **Verify server-side:** a temp `.ts` at the repo root importing the helper by absolute path, run with
  `npx tsx` (a file in the scratchpad cannot resolve the repo's `node_modules`); delete it after.

- **Better-Auth OpenAPI claims (11.42.9+ Swagger docs):** a plain `.mjs` at the repo root
  (`betterAuth({ database: memoryAdapter({}), plugins: [..., openAPI({ disableDefaultReference: true })] })`
  then `await auth.api.generateOpenAPISchema()`) runs with bare `node`, no Mongo. On better-auth 1.7.7
  about half the operations (24 of 49 with jwt/twoFactor/passkey) carry NO `operationId`, so
  setupSwagger falls back to `<method><path>` — check any doc that says "handler = Better-Auth's
  operation id" against that. Before the internal plugin existed, `/iam/open-api/*` already
  answered 404 (Better-Auth 404 -> controller catch-all -> 404), so "now answers 404" is no change.

- **`@seen-failing` claims under a "do not edit files" review:** `check:mutations` edits the source,
  so replay a mutation in the SCRATCHPAD instead: copy the target file + spec(s) keeping their relative
  layout, `ln -s <repo>/node_modules <scratch>/node_modules` (this fixes the resolution problem above),
  a minimal `vitest.unit.config.mjs` (`unplugin-swc` + `include: ['tests/unit/**/*.spec.ts']`), then a
  python helper that reads the registry entry, asserts `find` occurs once and writes `replace`. Shows
  WHICH cases go red per mutation — the per-test granularity the gate itself does not report.
  Used 2026-10-11 for the four `e2e-slot-*` / `e2e-low-resource-cap-pooloptions` mutations (all red as tagged).
  Same scratch dir + `tsconfig` copy also answers "does tsc catch X" probes (it accepts unknown
  vitest config keys; since 12.0.0 the base tsconfig is `module`/`moduleResolution: nodenext` and
  `tsconfig.tests.json` overrides it with `preserve` + `bundler` — copy the one the claim is about).

- **FRAMEWORK-API.md generator claims** ("regenerates with the new version", "skips when unchanged"):
  `sed` the script into `<scratch>/gen.cts` with `const ROOT = '<repo>'` and `const OUTPUT` pointing at a
  scratch copy of FRAMEWORK-API.md, then run it from the repo with `NODE_PATH=<repo>/node_modules
  ./node_modules/.bin/tsx <scratch>/gen.cts` (the `.cts` extension keeps it CJS). Edit the scratch copy
  (version, date) to probe each branch. ~10 s, never touches the tracked file. Used 2026-10-20.

- **"Pin X and you get two copies" claims:** scratch dir with `fw/package.json` (the framework's deps) +
  root `package.json` (`"fake-framework": "file:./fw"` + the consumer pins), `pnpm-workspace.yaml` with
  `nodeLinker: hoisted` + `minimumReleaseAge: 0`, then `pnpm install --lockfile-only --ignore-scripts` (~3 s,
  needs the registry). Count `'@nestjs/mongoose@12.0.0(` snapshot keys: one per distinct peer set. Used 2026-10-24.
- **TypeScript-upgrade emit/runtime claims:** scratch project with `node_modules/typescript` symlinked to the
  repo's TS (6.x) and the starter's TS (5.9) as the baseline binary; compile a 3-line probe and `grep
  __importStar` / run it. For Nest schema effects, compile a tiny `@Resolver` and call
  `GraphQLSchemaFactory.create()` from `GraphQLSchemaBuilderModule` — no DB, no HTTP. ts-node under a newer TS:
  run the starter's `node_modules/ts-node/dist/bin.js` from a dir whose `node_modules/typescript` points at
  the new TS (ts-node resolves the compiler from the project dir). Used 2026-10-24.
- **A loader / config file against the real starter:** `cd nest-server-starter && node -e "require('<repo>/dist/…/ts-compiler.js'); require('./migrations-utils/mongo-uri').resolveMongoUri()"`
  loads the starter's `config.env.ts` read-only. Used 2026-10-24.

Verified 2026-09-26: the 11.41.4 C#, PowerShell-shaped and Node assertion recipes all pass
`decodeApiTokenAssertion` + `verifyApiTokenAssertionSignature` + `checkApiTokenAssertionTiming`.
