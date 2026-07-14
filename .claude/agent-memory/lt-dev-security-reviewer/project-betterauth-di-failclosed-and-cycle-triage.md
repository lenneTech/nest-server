---
name: project-betterauth-di-failclosed-and-cycle-triage
description: BetterAuth DI degrades fail-closed (null authInstance -> 401, never bypass); criterion for triaging madge import cycles as TDZ-risky vs benign
metadata:
  type: project
---

Two durable conclusions from auditing the BetterAuth DI-token extraction (`core-better-auth.constants.ts`, 11.27.6+).

## 1. BetterAuth DI failure is FAIL-CLOSED, never fail-open

`CoreBetterAuthService` injects the auth instance with `@Optional() @Inject(BETTER_AUTH_INSTANCE)`. A silently-unresolved token degrades to `authInstance = null`, and that propagates **closed**:

`isEnabled()` returns `false` -> every session path (`getSession`, `getSessionByToken`, JWT verify) returns `{ session: null, user: null }` -> middleware never sets `req.user` -> `BetterAuthRolesGuard.canActivate()` hits `if (!user) throw new UnauthorizedException(ErrorCode.UNAUTHORIZED)`.

**Why:** `@Optional()` on a security-critical token *looks* like a fail-open hazard, and that is the first instinct on every review. It is not one here. The worst case is a total 401 outage (availability), not an auth bypass. `S_EVERYONE` endpoints stay public — which is correct, they are public by design.

**How to apply:** When reviewing any change to BetterAuth DI wiring, injection tokens, or `isEnabled()`, do NOT classify `@Optional()` auth-instance injection as a bypass risk without tracing it. Classify a broken-injection scenario as availability/DoS (Medium at most), not Critical. Re-verify the chain only if someone changes `isEnabled()` to default-true, or makes the guard treat a missing user as permissive.

## 2. Triaging madge import cycles: decorator-arg vs method-body

`pnpm dlx madge --circular --extensions ts src/core/modules/better-auth/` reports 4 cycles. Only some are dangerous. The discriminator is **where the cross-cycle binding is dereferenced**:

- **TDZ-risky (real bug):** binding referenced at *module-evaluation time* — most importantly as a **decorator argument**, since decorators execute at class-definition time. This was the actual SWC crash: `@Inject(BETTER_AUTH_INSTANCE)` in the service's constructor, with the token declared in the module that imports the service. Under tsc/CommonJS it survived on evaluation-order luck (partial-exports gives `undefined`, not a throw); under SWC it raised `ReferenceError: Cannot access 'BETTER_AUTH_INSTANCE' before initialization`. Note the CommonJS variant is the *scarier* one — a silent `@Inject(undefined)` rather than a loud crash.
- **Benign:** binding referenced only inside a **method/function body**, dereferenced at call time long after both modules finished evaluating. Example: `better-auth-roles.guard.ts > core-better-auth.module.ts` — the guard touches `CoreBetterAuthModule.getTokenServiceInstance()` only inside `getTokenService()`, and the module touches `BetterAuthRolesGuard` only inside `createDeferredModule()`. Safe in both directions; leaving it is fine.

**Watch item:** the 3 remaining pre-existing cycles include `restricted.decorator.ts > db.helper.ts > input.helper.ts` — that one touches a *security* decorator. Currently benign (`equalIds`/`getIncludedIds` are called inside function bodies), but if anything there ever moves to a decorator argument or top-level const, it becomes the same class of SWC-TDZ bug on a security-critical path. Re-check it whenever `restricted.decorator.ts` is edited.

Related: [[project-betterauth-native-cookie-forwarding]], [[project-e2e-node-env-trap]].
