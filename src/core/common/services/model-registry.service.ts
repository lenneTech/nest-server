import { CoreModel } from '../models/core-model.model';

/**
 * Central registry mapping Mongoose model names to CoreModel classes.
 * Populated automatically by ModuleService constructors.
 */
export class ModelRegistry {
  private static models = new Map<string, new (...args: any[]) => CoreModel>();

  static register(dbModelName: string, modelClass: new (...args: any[]) => CoreModel): void {
    this.models.set(dbModelName, modelClass);
  }

  static getModelClass(dbModelName: string): (new (...args: any[]) => CoreModel) | undefined {
    return this.models.get(dbModelName);
  }

  static getAll(): Map<string, new (...args: any[]) => CoreModel> {
    return this.models;
  }

  static clear(): void {
    this.models.clear();
  }
}
