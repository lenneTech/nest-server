/**
 * Reads the packed file list out of `npm pack --json`, whichever npm major printed it.
 *
 * npm 11 prints an ARRAY with one entry per packed package; npm 12 prints an OBJECT keyed by the package name. The
 * publish workflow installs npm 12 for Trusted Publishing (DEV-3143) while the runner's Node 24 ships npm 11, and a
 * developer may have either — so `JSON.parse(raw)[0].files` works under one and throws under the other.
 *
 * @param {string} raw - stdout of `npm pack --dry-run --json`
 * @param {string} name - the package name (package.json `name`), the key npm 12 uses
 * @returns {string[]} the paths of the packed files
 */
export function packedFilesFromNpmPackJson(raw, name) {
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : (parsed?.[name] ?? Object.values(parsed ?? {})[0]);
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`npm pack --json printed no file list for ${name}`);
  }
  return entry.files.map((file) => file.path);
}
