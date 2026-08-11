---
name: core-controller-override-contract
description: Overriding a Core*Controller route method silently DELETES the route unless @Get/@Post is re-declared; CUSTOMIZATION.md documents the broken form. Verified against NestJS PathsExplorer.
metadata:
  type: project
---

Overriding a route method of a `Core*Controller` in a consumer subclass **removes the route
entirely** unless the HTTP-method decorator is re-declared on the override.

**Why:** `node_modules/@nestjs/core/router/paths-explorer.js` → `exploreMethodMetadata()` does
`Reflect.getMetadata(PATH_METADATA, prototype[methodName])`. For an override, `prototype[methodName]`
is the SUBCLASS function object — a different function with no own `PATH_METADATA`, and a function's
reflect-metadata prototype chain is `Function.prototype`, not the base class method. `routePath`
is `undefined` → `return null` → the route is never registered. No error, no warning.

`@Roles` behaves differently and asymmetrically:
- **Not overridden** → `context.getHandler()` is the BASE function, which still carries its
  handler-level `roles`. Handler metadata beats class metadata, so a consumer **cannot relax an
  inherited method's roles via a class-level `@Roles`** — they must override.
- **Overridden without re-declaring `@Roles`** → falls back to the subclass's class-level roles
  (safe direction, but usually not what the author intended).

`src/core/modules/better-auth/CUSTOMIZATION.md` (~line 165) documents exactly the broken pattern:
`override async signUp(...)` with no `@Post`. Following it unregisters `POST /iam/sign-up/email`.

**How to apply:** when reviewing "consumers can just override this" as the escape hatch for a
hardened default, check that the docs say to re-declare BOTH decorators — otherwise the documented
escape hatch does not work. Also flag CUSTOMIZATION.md's example if it is still undecorated.
