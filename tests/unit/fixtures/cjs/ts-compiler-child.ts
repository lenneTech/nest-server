/**
 * Child fixture for `../ts-compiler.spec.ts`, run as `node -r <loader> <this file>`.
 *
 * Uses the TypeScript features a NestJS source run depends on and prints what the loader made of
 * them: decorator metadata (DI and every field decorator read it), enums, parameter properties,
 * class-field semantics, `import x = require()` and source-mapped stack traces.
 *
 * Not a `*.spec.ts`, so neither vitest runner picks it up as a suite.
 */
import 'reflect-metadata';

import fs = require('node:fs');

enum Kind {
  A = 'a',
  B = 'b',
}

class Dependency {}

function Injectable(): ClassDecorator {
  return () => undefined;
}

function Field(): PropertyDecorator {
  return () => undefined;
}

@Injectable()
class Service {
  @Field()
  label?: string;

  declared?: string;

  constructor(
    readonly dependency: Dependency,
    private readonly kind: Kind = Kind.B,
  ) {}

  get value(): Kind {
    return this.kind;
  }
}

const probe = new Error('stack probe'); // stack-probe
const service = new Service(new Dependency());
const typeName = (type: unknown): string => (type as { name: string }).name;

process.stdout.write(
  JSON.stringify({
    className: Service.name,
    declaredIsOwnProperty: Object.prototype.hasOwnProperty.call(service, 'declared'),
    enumValue: service.value,
    importEquals: typeof fs.readFileSync,
    paramTypes: (Reflect.getMetadata('design:paramtypes', Service) as unknown[]).map(typeName),
    propertyType: typeName(Reflect.getMetadata('design:type', Service.prototype, 'label')),
    stack: probe.stack,
    unused: Kind.A,
  }),
);
