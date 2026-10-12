---
name: error-code-registry-override-semantics
description: How a project overrides a CORE error code's translations (additionalErrorRegistry, last registration wins per code) and the one config path where that is silently ignored — verify doc claims about it against these facts
metadata:
  type: project
---

`CoreErrorCodeService.generateTranslationsFromRegistry()` keys translations by `code` (not by the registry key) and spreads each new registry over the existing map. So a project entry `{ code: 'LTNS_0103', translations: {...} }` in `errorCode.additionalErrorRegistry` REPLACES the core translation for that code: the core registers in the constructor, the project registry right after it in `ErrorCodeModule.forRoot()`'s factory. A doc claim like "registered after the core and therefore winning" is correct (verified 2026-10-12, CoreTenantGuard refusal codes LTNS_0103-0107).

**The exception:** when `CoreModule.forRoot(env, { errorCode: { service } })` passes a custom service, `ErrorCodeModule.forRoot()` takes the `config.service` branch and never reads `additionalErrorRegistry`. The custom service has to call `registerErrorRegistry()` itself. This behaviour already existed and holds for every project code, not only for overrides.

Nothing enforces the "use your own prefix, not LTNS_" advice in `error-code/INTEGRATION-CHECKLIST.md`. There is no collision check, so overriding a core code is allowed and works.

**Why:** a docs review gets asked to confirm exactly this kind of "project override wins" claim, and it has to be confirmed against the code.

**How to apply:** treat the claim as true for the config path. Flag it only if a doc says it also works with a custom `service` override. The frontend parses `/^#([A-Z_]+_\d+):\s*(.+)$/` (nuxt-extensions `use-lt-error-translation.ts`), so any `#LTNS_NNNN: text` message translates once the code is in the registry.
