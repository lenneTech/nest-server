/**
 * DI tokens of the persistence layer. Import-free leaf — see `.claude/rules/architecture.md`
 * → "DI Token Placement (SWC-Safe)".
 */

/** Injection token of the data store of a model, by model name. */
export function getStoreToken(modelName: string): string {
  return `DataStore:${modelName}`;
}
