---
name: number-drift-in-tooling-prose
description: Hard-coded mutation counts live in BOTH .claude/rules/testing.md and the scripts/check-mutations.mjs header; since 11.36.3 a guard in regression-evidence.spec.ts covers all of them, but only for those two files — a third surface would drift unnoticed
metadata:
  type: project
---

`tests/regression-mutations.json` is quoted by prose in two places, and they drift independently:

| Surface | Numbers quoted |
|---|---|
| `.claude/rules/testing.md` | total registry size, MongoDB-free count, e2e-mutation count, "N times" cold starts, "all N verdicts" |
| `scripts/check-mutations.mjs` header comment (~lines 45/56/60) | MongoDB-free count, "runs all N", "bad trade at N mutations" |

**Why:** 11.36.3 first added a guard (`regression-evidence.spec.ts` → *"the documented counts match
the registry"*) that asserted only two literal strings and read only `testing.md`. It shipped green
while six numbers were wrong — testing.md said "51 mutations" and "49 times" two paragraphs apart,
and the script header still said 20/49/49. A guard covering the file its author was editing, but not
the file they were editing it ABOUT, institutionalises the illusion that the counts are maintained.

**Status:** fixed later in the same release. The guard now flattens whitespace (so an assertion can
no longer fail because a paragraph re-wrapped), checks all four counts in `testing.md` and all three
in the `check-mutations.mjs` header — 7 assertions across both files. The numbers themselves were
corrected in the same pass.

**What remains your job:** the guard knows about exactly those two surfaces. A THIRD place that
quotes a count (a README, a migration guide, a new script header) drifts silently — add it to the
guard rather than only fixing the number.

**How to apply:** On any diff that touches `tests/regression-mutations.json`, derive the four counts
yourself and grep both surfaces:

```
python3 -c "import json;m=json.load(open('tests/regression-mutations.json'))['mutations'];u=[x for x in m if all(s.startswith('tests/unit/') for s in x['specs'])];print(len(m),len(u),len(m)-len(u))"
grep -nE '\b(1[0-9]|[2-9][0-9])\b' .claude/rules/testing.md scripts/check-mutations.mjs
```

Distinguish COUNTS (must be updated) from MEASUREMENTS ("744s on a 12-core laptop") — the latter
are historical observations and may legitimately keep an old registry size in context, but only if
the sentence says so. See [[review-committed-vs-working-tree]].
