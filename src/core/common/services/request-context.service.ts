import { AsyncLocalStorage } from 'async_hooks';

export interface IRequestContext {
  currentUser?: {
    id: string;
    hasRole?: (roles: string[]) => boolean;
    roles?: string[];
  };
  language?: string;
}

/**
 * Request-scoped context using AsyncLocalStorage.
 * Provides access to the current user in Mongoose hooks and other
 * places where NestJS request scope is not available.
 */
export class RequestContext {
  private static storage = new AsyncLocalStorage<IRequestContext>();

  static run<T>(context: IRequestContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  static get(): IRequestContext | undefined {
    return this.storage.getStore();
  }

  static getCurrentUser(): IRequestContext['currentUser'] | undefined {
    return this.storage.getStore()?.currentUser;
  }

  static getLanguage(): string | undefined {
    return this.storage.getStore()?.language;
  }
}
