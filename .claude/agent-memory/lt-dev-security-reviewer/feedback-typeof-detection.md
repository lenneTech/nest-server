---
name: CoreModule.forRoot() typeof detection and Type<any> classification
description: The isIamOnlyMode detection changed from undefined-check to typeof-check in 11.22.0; Type<any> in ICoreModuleOverrides is the correct NestJS pattern
type: project
---

**CoreModule.forRoot() signature detection (11.22.0):**

Old: `authModuleOrUndefined === undefined && optionsOrUndefined === undefined` — broke when overrides object was passed as 2nd arg (treated as Legacy mode).

New: `typeof authServiceOrOptions !== 'function'` — correct because Legacy mode always passes a class (function) as first arg.

**Type<any> in ICoreModuleOverrides:** Using `Type<any>` instead of `Type<CoreBetterAuthController>` etc. is the correct NestJS framework pattern. Stronger generics would require circular imports between the interface file and concrete module classes. This is an INFO-level observation, not a vulnerability.

**How to apply:** Don't flag `Type<any>` in NestJS module configuration interfaces as a security finding. It is idiomatic for NestJS DI registration.
