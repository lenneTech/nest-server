---
name: executable-doc-recipes
description: Which non-Node doc recipes can be executed on this machine to verify them (dotnet yes, pwsh no) and how to check them against the server helpers
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

Verified 2026-09-26: the 11.41.4 C#, PowerShell-shaped and Node assertion recipes all pass
`decodeApiTokenAssertion` + `verifyApiTokenAssertionSignature` + `checkApiTokenAssertionTiming`.
