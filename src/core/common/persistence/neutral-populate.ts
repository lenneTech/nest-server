import { Logger } from '@nestjs/common';

import { isObjectIdLike } from '../helpers/id.helper.js';
import type { DataStore } from './data-store.interface.js';
import { getModelDescriptor } from './model-metadata.registry.js';
import { getRegisteredDataStore } from './persistence-runtime.registry.js';

/** A populate option as `toPopulateOptions()` yields it */
export interface NeutralPopulateOption {
  /** Target model name, when the option overrides the field's `ref` */
  model?: unknown;
  path: string;
  populate?: unknown;
}

const logger = new Logger('NeutralPopulate');

/**
 * Populate references of plain records the way Mongoose populate does, for stores without Mongoose documents (plan
 * §3.6): per reference field, ONE `id $in` read through the target model's store — so its tenant layers, rights and
 * row check apply to the loaded records as to any other read — then nested options, then the ids are replaced in
 * place. An unresolved single reference becomes `null`, unresolved items of a reference list are dropped, as with
 * Mongoose.
 */
export async function populateNeutral(
  data: unknown,
  options: ReadonlyArray<NeutralPopulateOption | string>,
  modelName: string,
): Promise<void> {
  const records = (Array.isArray(data) ? data : [data]).filter(
    (record): record is Record<string, any> => !!record && typeof record === 'object',
  );
  if (!records.length || !options.length) {
    return;
  }
  const descriptor = getModelDescriptor(modelName);
  for (const option of options) {
    const entry = typeof option === 'string' ? { path: option } : option;
    for (const path of String(entry.path ?? '')
      .split(/\s+/)
      .filter(Boolean)) {
      const field = descriptor?.fields[path];
      const target = typeof entry.model === 'string' ? entry.model : field?.ref;
      if (!field || field.kind !== 'ref' || !target) {
        continue;
      }
      const store: DataStore<any> | undefined = getRegisteredDataStore(target);
      if (!store) {
        logger.debug(`${modelName}.${path}: no store is registered for "${target}", the reference stays an id`);
        continue;
      }
      const ids = new Set<string>();
      for (const record of records) {
        for (const id of idsOf(record[path])) {
          ids.add(id);
        }
      }
      if (!ids.size) {
        continue;
      }
      const loaded = await store.find({ id: { $in: [...ids] } });
      if (entry.populate) {
        await populateNeutral(loaded, toList(entry.populate), target);
      }
      const byId = new Map(loaded.map((item) => [String(item.id), item]));
      for (const record of records) {
        const value = record[path];
        if (Array.isArray(value)) {
          record[path] = value.map((item) => byId.get(idOf(item))).filter((item) => item !== undefined);
        } else if (value !== undefined && value !== null) {
          record[path] = byId.get(idOf(value)) ?? null;
        }
      }
    }
  }
}

function toList(populate: unknown): Array<NeutralPopulateOption | string> {
  return (Array.isArray(populate) ? populate : [populate]) as Array<NeutralPopulateOption | string>;
}

function idOf(value: unknown): string {
  if (isObjectIdLike(value)) {
    return value.toHexString();
  }
  if (value && typeof value === 'object') {
    const nested = (value as { _id?: unknown; id?: unknown }).id ?? (value as { _id?: unknown })._id;
    return String(nested ?? value);
  }
  return String(value);
}

function idsOf(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).filter((item) => item !== undefined && item !== null).map(idOf);
}
