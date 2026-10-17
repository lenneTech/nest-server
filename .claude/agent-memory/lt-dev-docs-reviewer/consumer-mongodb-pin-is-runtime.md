---
name: consumer-mongodb-pin-is-runtime
description: A consumer's "test-only" mongodb devDependency is the version better-auth's MongoDB adapter loads at runtime (peer resolved from the project root); a stale pin plus an old bson lock splits ObjectId and breaks IAM with 401 / MongoAdapterError
metadata:
  type: project
---

nest-server-starter keeps `mongodb` in `devDependencies` ("only its tests import it"), but the lock
resolves `better-auth@x(mongodb@<that pin>)` and `@better-auth/mongo-adapter@x(mongodb@<that pin>)`
from it, and the adapter does `instanceof ObjectId` with its own `mongodb` import. nest-server wires
that adapter (`mongodbAdapter(db)` in better-auth.config.ts). A `--prod` install keeps it too: the
adapter's snapshot lists the pin as its own (optional) dependency.

So when the framework raises mongodb and a consumer's pin lags, the cost is not just test typings.
If the consumer's lock still holds an older bson for the old driver (the starter held bson 7.2.0
until 2026-10-09), two bson copies → ObjectId identity split → `MongoAdapterError: Invalid id value`
and 401s. Observed 2026-10-06: check:consumer 74/119 red (npm-maintainer memory, item 12).
With a shared bson (fresh lock) the split is types-only.

**Why:** 11.42.15's guide described the lag as a test-typing problem and the Troubleshooting entry
pointed at type errors — reported as High on 2026-10-13.
**How to apply:** whenever a guide covers a mongodb / bson / mongoose move, check that it names the
runtime auth symptom, and that "devDependency" is not presented as "test-only".
Related: [[override-recipe-vs-consumer-lockfiles]], [[migration-guide-behavior-change-count-trap]].
