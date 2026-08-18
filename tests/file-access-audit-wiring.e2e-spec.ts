import { Test, TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreFileAccessAuditInitializer } from '../src/core/modules/file/core-file-access-audit.initializer';
import { FILE_ROLE_MEMBERS } from '../src/core/modules/file/file-roles.config';
import { FileController } from '../src/server/modules/file/file.controller';
import { ServerModule } from '../src/server/server.module';

import type { INestApplication } from '@nestjs/common';

/**
 * The WIRING of the file-access audit, against the assembled application.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UNIT SUITE
 * ----------------------------------------------
 * `tests/unit/file-access-effective-roles.spec.ts` proves the DECISION: given a set of registered
 * classes, which of them are open for a reason the configuration cannot explain. It supplies those
 * classes through a stubbed `DiscoveryService`, because instantiating the real controller wants a
 * live Mongo connection that has nothing to do with the question.
 *
 * That leaves one claim untested, and it is the load-bearing one: **that `DiscoveryService` actually
 * hands us the registered file controller.** A stub can only confirm what it was told to return. If
 * the provider is never constructed, or `DiscoveryModule` is missing from `CoreModule`'s imports, or
 * controllers turn out not to appear in `getControllers()` for this application shape, then every
 * unit test still passes and the audit silently inspects nothing — which is the exact failure mode
 * the audit was written to end. A security check that quietly does not run is worse than no check,
 * because its silence reads as a clean bill of health.
 *
 * So this boots the real `ServerModule` and asserts the audit can SEE the reference server's own
 * `FileController`.
 *
 * @regression   11.35.x — the audit closing the subclass blind spot is only worth anything if
 *   discovery reaches the registered controller. Nothing else in the suite would notice if it
 *   returned an empty list.
 * @seen-failing Make `CoreFileAccessAuditInitializer.registeredEndpointClasses()` skip controllers
 *   (drop the `getControllers()` loop) — registered as mutation
 *   `file-access-audit-skips-controllers` in `tests/regression-mutations.json`. Discovery then finds
 *   no controller and the first two cases below go red, while the unit suite stays entirely green:
 *   precisely the split this file exists to cover.
 */
describe('file access audit — wiring against the assembled application', () => {
  let app: INestApplication;
  let initializer: CoreFileAccessAuditInitializer;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ServerModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    initializer = app.get(CoreFileAccessAuditInitializer, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('is registered as a provider — CoreModule constructs it', () => {
    expect(initializer).toBeInstanceOf(CoreFileAccessAuditInitializer);
  });

  it('discovers the reference server\'s registered FileController', () => {
    // The claim a stubbed DiscoveryService cannot make. `FileController extends CoreFileController`
    // and is registered by the server's own FileModule, so the audit must see it by its own name.
    const handlers: { member: string }[] = (initializer as any).collectHandlers();
    const members = handlers.map(handler => handler.member);

    expect(members).toContain(`${FileController.name}.getFileById`);
    expect(members).toContain(`${FileController.name}.getFile`);
  });

  it('covers every governed member of the classes it found', () => {
    // A discovery that returns the class but only half its members would report a partial audit as a
    // complete one.
    const handlers: { member: string }[] = (initializer as any).collectHandlers();
    const controllerMembers = FILE_ROLE_MEMBERS.filter(member => member.className === 'CoreFileController');

    for (const member of controllerMembers) {
      expect(handlers.some(handler => handler.member.endsWith(`.${member.method}`))).toBe(true);
    }
  });

  it('stays silent for this application — its controller INHERITS the governed members', () => {
    // The reference server subclasses `CoreFileController` but re-declares none of the members the
    // knobs govern, so configuration and reality agree and there is nothing for the audit to add.
    // This is the false-positive guard: an audit that fired here would fire for most projects, get
    // muted, and protect nobody.
    expect(() => initializer.onApplicationBootstrap()).not.toThrow();

    const handlers: { key: string; member: string; roles: string[] }[] = (initializer as any).collectHandlers();
    const inherited = handlers.filter(handler => handler.member.startsWith(`${FileController.name}.`));

    expect(inherited.length).toBeGreaterThan(0);
    for (const handler of inherited) {
      // Whatever the configured roles are, they arrived through configuration — never through a
      // `@Roles()` this project wrote on an override.
      expect(handler.roles.length).toBeGreaterThan(0);
    }
  });
});
