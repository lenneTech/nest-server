import { FieldNode, GraphQLResolveInfo, SelectionNode } from 'graphql';
import * as _ from 'lodash';
import { Document, Model, PopulateOptions, Query, SchemaType, Types } from 'mongoose';
import { ResolveSelector } from '../interfaces/resolve-selector.interface';
import { CoreModel } from '../models/core-model.model';
import { FieldSelection } from '../types/field-selection.type';
import { IdsType } from '../types/ids.type';
import { StringOrObjectId } from '../types/string-or-object-id.type';

// =====================================================================================================================
// Export functions
// =====================================================================================================================

/**
 * Add IDs to array
 * @param target Array will be changed
 * @param ids ID or IDs to add
 * @param convert Convert ID and / or array values
 *    'auto': ID will be converted to type of first element in array
 *    'string': ID and other array values will be converted to string IDs
 *    'object': ID and other array values will be converted to ObjectIds
 *    false: no conversion
 * @param options
 *    uniqui: Add only non-existing IDs, if true
 */
export function addIds(
  target: any,
  ids: StringOrObjectId | StringOrObjectId[],
  convert: 'string' | 'object' | 'auto' | false = 'auto',
  options?: { unique?: boolean }
): any[] {
  // Set config
  const config = {
    unique: true,
    ...options,
  };

  // Check and convert parameters
  let result = target as any;
  if (!Array.isArray(result)) {
    result = [];
  }
  if (!Array.isArray(ids)) {
    ids = [ids];
  }

  // Unique
  if (config.unique) {
    removeIds(ids, target as any);
  }

  // Process ids
  if (ids.length) {
    // Add autoconverted ID
    if (
      result.length &&
      convert === 'auto' &&
      ((result[0] instanceof Types.ObjectId && !(ids instanceof Types.ObjectId)) ||
        (typeof result[0] === 'string' && typeof ids !== 'string'))
    ) {
      const converted = result[0] instanceof Types.ObjectId ? getObjectIds(ids) : getStringIds(ids);
      result.push(...(converted as any));
    }

    // Add ID
    else {
      result.push(...ids);
    }
  }

  // Convert array
  if (['string', 'object'].includes(convert as string)) {
    for (let i = 0; i < result.length; i++) {
      result[i] = convert === 'string' ? getStringId(result[i]) : getObjectIds(result[i]);
    }
  }

  // Return result
  return result;
}

/**
 * Checks if all IDs are equal
 */
export function equalIds(...ids: IdsType[]): boolean {
  if (!ids) {
    return false;
  }
  const compare = getStringIds(ids[0]);
  if (!compare) {
    return false;
  }
  return ids.every((id) => getStringIds(id) === compare);
}

/**
 * Get included ids
 * @param includes IdsType, which should be checked if it contains the ID
 * @param ids IdsType, which should be included
 * @param convert If set the result array will be converted to pure type String array or ObjectId array
 * @return IdsType with IDs which are included, undefined if includes or ids are missing or null if none is included
 */
export function getIncludedIds(includes: IdsType, ids: IdsType, convert?: 'string'): string[];
export function getIncludedIds(includes: IdsType, ids: IdsType, convert?: 'object'): Types.ObjectId[];
export function getIncludedIds<T = IdsType>(
  includes: IdsType,
  ids: T | IdsType,
  convert?: 'string' | 'object'
): T[] | null | undefined {
  if (!includes || !ids) {
    return undefined;
  }

  if (!Array.isArray(includes)) {
    includes = [includes];
  }

  if (!Array.isArray(ids)) {
    ids = [ids];
  }

  let result = [];
  const includesStrings = getStringIds(includes);
  for (const id of ids) {
    if (includesStrings.includes(getStringIds(id))) {
      result.push(id);
    }
  }

  if (convert) {
    result = convert === 'string' ? getStringIds(result) : getObjectIds(result);
  }

  return result.length ? result : null;
}

/**
 * Get indexes of IDs in an array
 */
export function getIndexesViaIds(ids: IdsType, array: IdsType): number[] {
  // Check and prepare parameters
  if (!ids) {
    return [];
  }
  if (!Array.isArray(ids)) {
    ids = [ids];
  }
  if (!Array.isArray(array)) {
    return [];
  }

  // Get indexes
  const indexes: number[] = [];
  ids.forEach((id) => {
    array.forEach((element, index) => {
      if (equalIds(id, element)) {
        indexes.push(index);
      }
    });
  });

  // Return indexes
  return indexes;
}

/**
 * Get IDs from string of ObjectId array in a flat string array
 */
export function getStringIds(elements: any[], options?: { deep?: boolean; unique?: boolean }): string[];
export function getStringIds(elements: any, options?: { deep?: boolean; unique?: boolean }): string;
export function getStringIds<T extends any | any[]>(
  elements: T,
  options?: { deep?: boolean; unique?: boolean }
): string | string[] {
  // Process options
  const { deep, unique } = {
    deep: false,
    unique: false,
    ...options,
  };

  // Check elements
  if (!elements) {
    return elements as any;
  }

  // Init ids
  let ids = [];

  // Process non array
  if (!Array.isArray(elements)) {
    return getStringId(elements);
  }

  // Process array
  for (const element of elements) {
    if (Array.isArray(element)) {
      if (deep) {
        ids = ids.concat(getStringIds(element, { deep }));
      }
    } else {
      const id = getStringId(element);
      if (id) {
        ids.push(id);
      }
    }
  }

  // Return (unique) ID array
  return unique ? _.uniq(ids) : ids;
}

/**
 * Convert string(s) to ObjectId(s)
 */
export function getObjectIds(ids: any[]): Types.ObjectId[];
export function getObjectIds(ids: any): Types.ObjectId;
export function getObjectIds<T extends any | any[]>(ids: T): Types.ObjectId | Types.ObjectId[] {
  if (Array.isArray(ids)) {
    return ids.map((id) => new Types.ObjectId(getStringId(id)));
  }
  return new Types.ObjectId(getStringId(ids));
}

/**
 * Get (and remove) elements with specific IDs from array
 */
export function getElementsViaIds<T = any>(
  ids: any | any[],
  array: T[],
  options: {
    splice?: boolean;
    unique?: boolean;
  } = {}
): T[] {
  // Config
  const config = {
    // Remove found elements from array
    splice: false,

    // Return unique elements
    unique: false,

    // Overwrite with options from parameters
    ...options,
  };

  // Get and check indexes
  const indexes = getIndexesViaIds(ids, array);
  if (!indexes?.length) {
    return [];
  }

  // Get elements
  const elements = [];
  indexes.forEach((index) => {
    if (config.splice) {
      elements.push(array.splice(index, 1)[0]);
    } else {
      elements.push(array[index]);
    }
  });

  // Unique elements
  if (config.unique) {
    return elements.filter((value, index, self) => {
      return self.findIndex((e) => getStringIds(e)) === index;
    });
  }

  // Return elements
  return elements;
}

/**
 * Get populate options from GraphQL resolve info
 */
export function getPopulateOptions(info: GraphQLResolveInfo, select?: string): PopulateOptions[] {
  const result = [];

  if (!info?.fieldNodes?.length) {
    return result;
  }

  for (const fieldNode of info.fieldNodes) {
    if ((select || fieldNode?.name?.value === select) && fieldNode?.selectionSet?.selections?.length) {
      return getPopulatOptionsFromSelections(fieldNode.selectionSet.selections);
    }
  }

  return result;
}

/**
 * Get populate options from selections
 */
export function getPopulatOptionsFromSelections(selectionNodes: readonly SelectionNode[]): PopulateOptions[] {
  const populateOptions = [];

  if (!selectionNodes || !selectionNodes.length) {
    return populateOptions;
  }

  for (const node of selectionNodes as FieldNode[]) {
    // Set main path
    const option: PopulateOptions = {
      path: node.name.value,
    };

    // Check for subfields
    if (node.selectionSet?.selections?.length) {
      for (const innerNode of node.selectionSet.selections as FieldNode[]) {
        // Subfiled is a primitive
        if (!innerNode.selectionSet?.selections?.length) {
          option.select ? option.select.push(innerNode.name.value) : (option.select = [innerNode.name.value]);
        }

        // Subfield ist an object
        else {
          const innerPopulate = getPopulatOptionsFromSelections([innerNode]);
          option.populate = option.populate
            ? (option.populate as PopulateOptions[]).concat(innerPopulate)
            : innerPopulate;
        }
      }
    }

    // Add option to populate options
    if (option.select || option.populate) {
      populateOptions.push(option);
    }
  }

  return populateOptions;
}

/**
 * Get simple clone of object via JSON.stringify and JSON.parse
 * @param obj
 */
export function getJSONClone<T = any>(obj: T): Partial<T> {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Convert all ObjectIds to strings
 */
export function objectIdsToStrings(element: any, prepared: WeakMap<any, any> = new WeakMap()) {
  // Check element
  if (!element) {
    return element;
  }

  // ObjectId to string
  if (element instanceof Types.ObjectId) {
    return element.toHexString();
  }

  // Process array
  if (Array.isArray(element)) {
    return element.map((e) => objectIdsToStrings(e, prepared));
  }

  // Process object
  if (typeof element === 'object') {
    // Avoid infinite regress
    if (prepared.has(element)) {
      return prepared.get(element);
    }
    const preparedObject = element;
    prepared.set(element, preparedObject);
    for (const [key, val] of Object.entries(element)) {
      preparedObject[key] = objectIdsToStrings(val, prepared);
    }
  }

  // Process others
  return element;
}

/**
 * Remove unresolved references: ObjectId => null
 */
export function removeUnresolvedReferences<T = any>(
  populated: T,
  populatedOptions: string | PopulateOptions | PopulateOptions[] | (string | PopulateOptions)[],
  ignoreFirst = true
): T {
  // Check parameter
  if (!populated || !populatedOptions) {
    return populated;
  }

  // Process array
  if (Array.isArray(populated)) {
    populated.forEach((p) => removeUnresolvedReferences(p, populatedOptions, false));
    return populated;
  }

  // Process object
  if (typeof populated === 'object') {
    // populatedOptions is an array
    if (Array.isArray(populatedOptions)) {
      populatedOptions.forEach((po) => removeUnresolvedReferences(populated, ignoreFirst ? po.populate : po, false));
      return populated;
    }

    // populatedOptions is a string
    if (typeof populatedOptions === 'string') {
      if (!['id', '_id'].includes(populatedOptions) && populated[populatedOptions] instanceof Types.ObjectId) {
        populated[populatedOptions] = null;
      }
      return populated;
    }

    // populatedOptions is an PopulateOptions object
    if (populatedOptions.path) {
      const key = populatedOptions.path;
      if (!['id', '_id'].includes(key) && populated[key] instanceof Types.ObjectId) {
        populated[key] = null;
      } else if (populatedOptions.populate) {
        removeUnresolvedReferences(populated[key], populatedOptions.populate, false);
      }
    }
  }

  // Process others
  return populated;
}

/**
 * Set populates, execute and map result
 */
export async function popAndMap<T extends CoreModel>(
  queryOrDocument: Query<any, any> | Document | Document[],
  populate: FieldSelection,
  modelClass: new (...args: any[]) => T,
  mongooseModel?: Model<any>
): Promise<T | T[]> {
  let result;
  let populateOptions: PopulateOptions[] = [];
  if (populate) {
    if (Array.isArray(populate) && typeof (populate as PopulateOptions[])[0]?.path === 'string') {
      populateOptions = populate as PopulateOptions[];
    } else if (Array.isArray(populate) && typeof (populate as SelectionNode[])[0]?.kind === 'string') {
      populateOptions = getPopulatOptionsFromSelections(populate as SelectionNode[]);
    } else if ((populate as ResolveSelector).info) {
      populateOptions = getPopulateOptions((populate as ResolveSelector).info, (populate as ResolveSelector).select);
    }
  }
  if (queryOrDocument instanceof Query) {
    // Get result
    result = await setPopulates(queryOrDocument, populateOptions, mongooseModel?.schema?.paths);
    if (result instanceof Query) {
      result = await result.exec();
    }

    // Map result
    if (Array.isArray(result)) {
      result = result.map((item) => (modelClass as any).map(item));
    } else {
      result = (modelClass as any).map(result);
    }
  } else {
    // Process documents
    if (Array.isArray(queryOrDocument)) {
      await setPopulates(queryOrDocument, populateOptions, mongooseModel?.schema?.paths);
      result = queryOrDocument.map((item) => (modelClass as any).map(item));
    }

    // Process document
    else {
      await setPopulates(queryOrDocument, populateOptions, mongooseModel?.schema?.paths);
      result = (modelClass as any).map(queryOrDocument);
    }
  }

  // Check for unresolved references
  return removeUnresolvedReferences(result, populateOptions);
}

/**
 * Remove ID from array
 * @param source Array with IDs which will be reduced
 * @param ids ID(s) to remove
 */
export function removeIds(source: any[], ids: StringOrObjectId | StringOrObjectId[]): any[] {
  // Check params and convert if necessary
  if (!ids) {
    return source;
  }
  if (!Array.isArray(ids)) {
    ids = [ids];
  }
  if (!Array.isArray(source)) {
    return [];
  }

  // Remove IDs from array
  const stringIds = getStringIds(source);
  ids.forEach((id) => {
    const position = stringIds.indexOf(getStringIds(id));
    if (position !== -1) {
      source.splice(position, 1);
    }
  });

  // Return array
  return source;
}

/**
 * Set populates via populates options array
 */
export async function setPopulates<T = Query<any, any> | Document>(
  queryOrDocument: T,
  populateOptions: PopulateOptions[],
  modelSchemaPaths?: { [key: string]: SchemaType }
): Promise<T> {
  // Check parameters
  if (!populateOptions?.length || !queryOrDocument) {
    return queryOrDocument;
  }

  // Filter populate options via model schema paths
  if (modelSchemaPaths) {
    populateOptions = populateOptions.filter((options) => {
      return Object.keys(modelSchemaPaths).includes(options.path);
    });
  }

  // Query => Chaining
  if (queryOrDocument instanceof Query) {
    for (const options of populateOptions) {
      queryOrDocument = (queryOrDocument as any).populate(options);
    }
  }

  // Document => Non chaining
  // Array with documents
  else if (Array.isArray(queryOrDocument)) {
    const promises = [];
    queryOrDocument.forEach((item) => promises.push(item.populate(populateOptions)));
    await Promise.all(promises);
  }
  // Single document
  else {
    await (queryOrDocument as any).populate(populateOptions);
  }

  // Return populated
  return queryOrDocument;
}

// =====================================================================================================================
// Not exported helper functions
// =====================================================================================================================
/**
 * Get ID of element as string
 */
function getStringId(element: any): string {
  // Check element
  if (!element) {
    return element;
  }

  // Sring handling
  if (typeof element === 'string') {
    return element;
  }

  // Object handling
  if (typeof element === 'object') {
    if (element instanceof Types.ObjectId) {
      return element.toHexString();
    }

    if (element.id) {
      return getStringId(element.id);
    } else if (element._id) {
      return getStringId(element._id);
    }
  }

  // Other types
  return element.toString();
}