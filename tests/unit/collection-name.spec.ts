import mongoose from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultCollectionName, legacyPluralize } from '../../src/core/common/persistence/mongo/collection-name';

/**
 * A model without a declared collection is named by Mongoose's pluralizer — on MongoDB the collection, on SQL the table
 * (`tableName()`). Without Mongoose installed the framework applies a copy of the same rules; a difference would give a
 * model another table the day a project removes Mongoose.
 */
describe('default collection name', () => {
  // Names the framework ships plus one per rule, uncountables included
  const NAMES = [
    'User',
    'TenantMember',
    'CoreApiTokenModel',
    'CoreAiConversation',
    'CoreFilesystemFile',
    'CoreS3File',
    'Human',
    'Woman',
    'Person',
    'Child',
    'Ox',
    'Axis',
    'Octopus',
    'Status',
    'Bus',
    'Potato',
    'Medium',
    'Analysis',
    'Wife',
    'Hive',
    'Company',
    'Box',
    'Matrix',
    'Mouse',
    'Knife',
    'Quiz',
    'Goose',
    'News',
    'Sheep',
    'Address',
    'Item2',
    'Media',
  ];
  const legacyMongoosePluralize = mongoose.pluralize();
  afterEach(() => {
    mongoose.pluralize(legacyMongoosePluralize);
  });

  it('copies Mongoose legacy rules exactly', () => {
    for (const name of NAMES) {
      expect(legacyPluralize(name), name).toBe(legacyMongoosePluralize!(name));
    }
  });

  it("follows the project's own pluralizer where Mongoose is installed, null included", () => {
    expect(defaultCollectionName('Company')).toBe('companies');
    mongoose.pluralize((name: string) => `x_${name}`);
    expect(defaultCollectionName('Company')).toBe('x_Company');
    mongoose.pluralize(null);
    expect(defaultCollectionName('Company')).toBe('Company');
  });
});
