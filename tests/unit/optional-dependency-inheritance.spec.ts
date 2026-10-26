/**
 * How `@Optional()` crosses inheritance under NestJS 12 — the contract the framework's own classes
 * and every project subclass of a `Core*` class now rely on.
 *
 * NestJS 11 read the optional-dependency markers with `Reflect.getMetadata`, which returns the
 * NEAREST class in the prototype chain that carries any: a subclass that redeclared its constructor
 * without a single `@Optional()` silently took over the parent's optional INDICES, whatever its own
 * parameters at those positions were.
 *
 * NestJS 12 reads them from the class that declares the constructor being called
 * (`Injector.getConstructorOwner()`, 12.1+):
 *
 *  - a subclass WITHOUT a constructor keeps the parent's parameters AND their optional flags;
 *  - a subclass WITH a constructor gets exactly the `@Optional()` it declares, nothing inherited.
 *
 * 12.0.0 inherited no flags at all (`Reflect.getOwnMetadata` on the subclass) — the behaviour the
 * official migration guide still describes. The framework's `AuthGuard()` subclasses depend on the
 * 12.1+ rule, which is why the first case is pinned here.
 */
import { Injectable, Optional } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { RefreshTokenGuard } from '../../src/core/modules/auth/guards/refresh-token.guard';

class OptionalDependency {}

@Injectable()
class BaseWithOptional {
  constructor(@Optional() readonly dependency?: OptionalDependency) {}
}

@Injectable()
class InheritsConstructor extends BaseWithOptional {}

@Injectable()
class RedeclaresWithoutOptional extends BaseWithOptional {
  // A redeclared constructor is the case under test — that it only forwards is the point.
  // eslint-disable-next-line no-useless-constructor
  constructor(dependency?: OptionalDependency) {
    super(dependency);
  }
}

@Injectable()
class RedeclaresWithOptional extends BaseWithOptional {
  constructor(@Optional() dependency?: OptionalDependency) {
    super(dependency);
  }
}

describe('optional dependencies across inheritance (NestJS 12)', () => {
  it('provides RefreshTokenGuard — a constructor-less AuthGuard() subclass — without PassportModule', async () => {
    // The mixin's constructor takes AuthModuleOptions and ModuleRef as optional. Without inherited
    // flags (NestJS 12.0.0) this throws UnknownDependenciesException for AuthModuleOptions.
    const moduleRef = await Test.createTestingModule({ providers: [RefreshTokenGuard] }).compile();
    const guard = moduleRef.get(RefreshTokenGuard);

    expect(guard).toBeInstanceOf(RefreshTokenGuard);
    expect((guard as any).options).toEqual({});
    await moduleRef.close();
  });

  it('keeps the optional flags of an inherited constructor', async () => {
    const moduleRef = await Test.createTestingModule({ providers: [InheritsConstructor] }).compile();
    expect(moduleRef.get(InheritsConstructor).dependency).toBeUndefined();
    await moduleRef.close();
  });

  it('does NOT carry the flags over to a redeclared constructor — that subclass must repeat @Optional()', async () => {
    // NestJS 11 resolved this to `undefined` through the parent's index. Projects whose subclass of
    // a Core* class redeclares the constructor and forwards an optional dependency hit this on upgrade.
    await expect(Test.createTestingModule({ providers: [RedeclaresWithoutOptional] }).compile()).rejects.toThrow(
      /can't resolve dependencies of the RedeclaresWithoutOptional/i,
    );

    const moduleRef = await Test.createTestingModule({ providers: [RedeclaresWithOptional] }).compile();
    expect(moduleRef.get(RedeclaresWithOptional).dependency).toBeUndefined();
    await moduleRef.close();
  });
});
