#!/usr/bin/env node
/**
 * Verifies that what package.json PROMISES actually ships in the tarball.
 *
 * Two silent failure modes this catches — both produce a green `check` and a
 * broken release:
 *
 *   1. A `files` pattern that matches nothing. Rename `.claude/rules/` or move
 *      `src/`, and npm packs zero files for that entry without any warning. The
 *      published package is simply missing them — vendor mode (which consumes
 *      `src/**`) or the lt-dev agent rules then break in consuming projects,
 *      not here.
 *   2. `main` / `types` / `bin` pointing at a path that is not packed, e.g.
 *      after a build-output move. `check` builds into dist/ and is happy; the
 *      installed package cannot be required at all.
 *
 * Runs on the ALREADY BUILT tree (--ignore-scripts, no prepack) — so put it
 * after the build step in the `check` chain, where dist/ is fresh.
 *
 * Exit code: 0 when every promise holds, 1 otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

let raw;
try {
  raw = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  console.error("[package-manifest] `npm pack --dry-run` failed:");
  console.error(`${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-10).join("\n"));
  process.exit(1);
}

const packed = JSON.parse(raw)[0].files.map((f) => f.path);
const problems = [];

// 1. Every `files` entry must contribute at least one file.
for (const pattern of pkg.files ?? []) {
  const base = pattern.replace(/\/\*\*\/\*$/, "").replace(/\/\*$/, "");
  const hits = packed.filter((f) => f === base || f.startsWith(`${base}/`)).length;
  if (hits === 0) {
    problems.push(`files entry "${pattern}" matches nothing — it will ship empty`);
  }
}

// 2. Every advertised entry point must actually be in the tarball. This covers
// the `exports` map too — a subpath like "./testing" pointing at an unpacked
// file fails only in the consumer, on import.
function exportTargets(node, path = "exports", out = []) {
  if (typeof node === "string") {
    if (node.startsWith("./")) out.push([path, node]);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) exportTargets(value, `${path}.${key}`, out);
  }
  return out;
}

const entries = [
  ["main", pkg.main],
  ["types", pkg.types],
  ["module", pkg.module],
  ...Object.entries(pkg.bin ?? {}).map(([k, v]) => [`bin.${k}`, v]),
  ...exportTargets(pkg.exports),
];
for (const [label, target] of entries) {
  if (!target) continue;
  const path = String(target).replace(/^\.\//, "");
  if (!packed.includes(path)) {
    problems.push(`${label} -> "${target}" is not in the tarball`);
  }
}

if (problems.length > 0) {
  console.error("[package-manifest] the published package would be broken:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\n  Inspect with: npm pack --dry-run --ignore-scripts`);
  process.exit(1);
}

console.log(`[package-manifest] ok — ${packed.length} files, every files entry and entry point resolves`);
