---
name: primitive-body-args-bypass-validation
description: "@Body('x')/@Args('x') typed as a primitive is NOT validated by MapAndValidatePipe — an object payload reaches Mongoose verbatim; live operator-injection in CoreUserService.resetPassword"
metadata:
  type: project
---

`MapAndValidatePipe` (`src/core/common/pipes/map-and-validate.pipe.ts:729`) short-circuits on
`!value || typeof value !== 'object' || !metatype || isBasicType(metatype)`. A parameter declared
`@Body('token') token: string` has `metatype === String`, so **the pipe returns the value untouched
— including when the value is an object**. There is no `express-mongo-sanitize` and no
`mongoose.set('sanitizeFilter')` anywhere in the repo (verified 2026-09-02).

**How to apply:** any handler parameter destructured out of the body/args with a primitive type
annotation, whose value flows into a Mongoose filter, is an operator-injection sink. Grep pattern:

```bash
grep -rn "@Body('\|@Args('" src/ | grep -v spec        # candidates
# then check whether the value reaches findOne/find/updateOne as a filter VALUE
```

Live instances at 11.38.0 (both in the shipped `src/core` sink, reachable through the
`src/server` routes that `nest-server-starter` mirrors):

- `CoreUserService.resetPassword` → `findOne({ passwordResetToken: token })`.
  `{"token":{"$ne":null}}` matches the first user holding a live token → password set without ever
  seeing the mail. `{"token":null}` matches a user with NO token at all (Mongo `null` matches
  missing), which the 11.38.0 expiry check happens to block — but only while
  `auth.passwordReset.tokenExpiresInMinutes` is non-zero. `0` (the documented opt-out) re-opens it.
- `CoreUserService.createPasswordResetToken` → `findOne({ email })`, same shape.

**Related:** [[project-exception-wire-format]] — the 404 thrown on the miss path.

The durable lesson, independent of these two sites: *"the framework has a global validation pipe"*
is not the same as *"this parameter is validated"*. Verify the metatype.
