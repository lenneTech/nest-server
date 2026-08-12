/**
 * CONSUMER CONTRACT: `securityCheck()` — the second overridable seam nothing exercised.
 *
 * WHY THIS EXISTS
 * ---------------
 * 11.33.1 shipped because `checkRights()` — an extension point the whole `Core*` inheritance model
 * rests on — was documented in a JSDoc `@example` and executed by nothing. `securityCheck()` had the
 * same exposure and still largely does: it is the LAST line of defence on every outgoing response,
 * every project overrides it on every model, and the only thing pinning it in this repository is a
 * handful of assertions on `User` inside `safety-net.e2e-spec.ts`. Those prove that ONE model's rule
 * produces the right answer. They do not pin the CONTRACT the rule is written against — when the
 * hook is called, with what, on which shapes, and what the framework does with the return value.
 *
 * That distinction is where the risk lives. A project author reads "override securityCheck() and
 * narrow the object" and then relies, without ever being told so, on: arrays being visited item by
 * item; a model nested inside another checked model being visited too; the hook receiving the
 * authenticated user rather than `undefined`; and the returned object — not the original — being
 * what is serialized. Break any of those and `User`'s three assertions stay green while every
 * project's field-level rules quietly stop running on half their responses.
 *
 * WHAT IS DELIBERATELY DIFFERENT FROM safety-net.e2e-spec.ts
 * ----------------------------------------------------------
 * The models here are defined IN THE TEST and their `securityCheck()` RECORDS ITS INVOCATION
 * (`checkedFor`) instead of only narrowing fields. That turns "the response looks redacted" — which
 * a `@Restricted` rule, `prepareOutput`, or a plain typo in the fixture would also produce — into
 * "the hook ran, with this user, on this object". A contract test has to be able to tell those
 * apart; that is the whole difference between checking the seam and checking one consumer of it.
 *
 * The controller is registered alongside the real `ServerModule`, so the interceptor chain, the role
 * guard and the response pipeline are the shipped ones.
 */
import { Controller, Get } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { CurrentUser } from '../src/core/common/decorators/current-user.decorator';
import { Roles } from '../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { CoreModel } from '../src/core/common/models/core-model.model';
import { ServerModule } from '../src/server/server.module';

/**
 * A model whose `securityCheck()` both NARROWS and RECORDS.
 *
 * `checkedFor` is the load-bearing part: without it, an assertion that `secretNote` is absent proves
 * only that the field did not arrive — which is also what a broken fixture, a `@Restricted` rule or
 * a serialization quirk look like.
 */
class ContractChild extends CoreModel {
  checkedFor?: string = undefined;
  id: string = undefined;
  ownerId: string = undefined;
  secretNote?: string = undefined;

  override securityCheck(user: any, force?: boolean): this {
    this.checkedFor = force ? 'FORCED' : (user?.id ?? 'ANONYMOUS');
    if (!force && user?.id !== this.ownerId) {
      this.secretNote = undefined;
    }
    return this;
  }
}

class ContractParent extends CoreModel {
  checkedFor?: string = undefined;
  child?: ContractChild = undefined;
  children?: ContractChild[] = undefined;
  id: string = undefined;
  ownerId: string = undefined;
  secretNote?: string = undefined;

  override securityCheck(user: any, force?: boolean): this {
    this.checkedFor = force ? 'FORCED' : (user?.id ?? 'ANONYMOUS');
    if (!force && user?.id !== this.ownerId) {
      this.secretNote = undefined;
    }
    return this;
  }
}

/** A model that opts its children out of the deep walk. */
class ShallowParent extends ContractParent {
  _doNotCheckSecurityDeep = true;
}

const SECRET = 'only-the-owner-may-read-this';

function child(id: string, ownerId: string): ContractChild {
  return ContractChild.map({ id, ownerId, secretNote: SECRET });
}

@Controller('security-check-contract')
@Roles(RoleEnum.S_USER)
class SecurityCheckContractController {
  /** A single model — the simplest shape, and the one every `getX()` endpoint returns. */
  @Get('single')
  single(@CurrentUser() user?: any): ContractChild {
    return child('single-1', user?.id ?? 'nobody');
  }

  /** Someone else's object: the rule must narrow it. */
  @Get('foreign')
  foreign(): ContractChild {
    return child('foreign-1', 'a-different-owner');
  }

  /** A bare array — `securityCheck` is not a function on an Array, so the deep walk has to find the items. */
  @Get('array')
  array(@CurrentUser() user?: any): ContractChild[] {
    return [child('array-own', user?.id ?? 'nobody'), child('array-foreign', 'a-different-owner')];
  }

  /** Models held inside a PLAIN object — the `findX()` + meta shape projects return all the time. */
  @Get('wrapped')
  wrapped(@CurrentUser() user?: any): { items: ContractChild[]; total: number } {
    return { items: [child('wrapped-own', user?.id ?? 'nobody'), child('wrapped-foreign', 'other')], total: 2 };
  }

  /** A checked model holding further models — the recursion inside `check()`. */
  @Get('nested')
  nested(@CurrentUser() user?: any): ContractParent {
    return ContractParent.map({
      child: child('nested-child', 'a-different-owner'),
      children: [child('nested-list-0', 'a-different-owner')],
      id: 'nested-1',
      ownerId: user?.id ?? 'nobody',
      secretNote: SECRET,
    });
  }

  /** Same, with the deep walk opted out. */
  @Get('shallow')
  shallow(@CurrentUser() user?: any): ShallowParent {
    const parent = ShallowParent.map({
      child: child('shallow-child', 'a-different-owner'),
      id: 'shallow-1',
      ownerId: user?.id ?? 'nobody',
      secretNote: SECRET,
    });
    parent._doNotCheckSecurityDeep = true;
    return parent;
  }

  /** A plain object carrying a configured secret field — the interceptor's own safety net. */
  @Get('secret-fields')
  secretFields(): { note: string; nested: { password: string }; password: string } {
    return { nested: { password: 'nested-secret' }, note: 'visible', password: 'top-level-secret' };
  }
}

describe('securityCheck consumer contract (e2e)', () => {
  let app: any;
  let mongoClient: MongoClient;
  let testHelper: TestHelper;

  const testId = `seccheck-${Date.now()}-p${process.pid}`;
  const user = { email: `${testId}@test.com`, id: '', password: `Pw-${Math.random().toString(36).substring(2, 10)}`, token: '' };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [SecurityCheckContractController],
      imports: [ServerModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    testHelper = new TestHelper(app);
    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);

    const signUp: any = await testHelper.graphQl({
      arguments: {
        input: { email: user.email, firstName: 'Security', lastName: 'Contract', password: user.password },
      },
      fields: [{ user: ['id'] }],
      name: 'signUp',
      type: TestGraphQLType.MUTATION,
    });
    user.id = signUp.user.id;
    await mongoClient
      .db()
      .collection('users')
      .updateOne({ _id: new ObjectId(user.id) }, { $set: { verified: true } });

    const signIn: any = await testHelper.graphQl({
      arguments: { input: { email: user.email, password: user.password } },
      fields: ['token'],
      name: 'signIn',
      type: TestGraphQLType.MUTATION,
    });
    user.token = signIn.token;
    expect(user.token).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    await mongoClient
      ?.db()
      ?.collection('users')
      .deleteMany({ email: { $regex: testId } })
      .catch(() => undefined);
    await mongoClient?.close();
    await app?.close();
  }, 120_000);

  const get = (path: string) => testHelper.rest(`/security-check-contract/${path}`, { token: user.token });

  describe('the hook runs, and it runs with the authenticated user', () => {
    it('calls securityCheck() on a returned model', async () => {
      const result = await get('single');
      // Not "the response looks right" — the hook itself reports that it ran, and for whom.
      expect(result.checkedFor).toBe(user.id);
    });

    it('passes force=false for an ordinary authenticated request', async () => {
      // `force` is reserved for the sign-in/sign-up path, where no user exists yet. A route that
      // accidentally forced would hand every field to every caller while looking perfectly normal.
      const result = await get('single');
      expect(result.checkedFor).not.toBe('FORCED');
      expect(result.checkedFor).not.toBe('ANONYMOUS');
    });
  });

  describe('the returned object is what gets serialized', () => {
    it('keeps a field the rule allows', async () => {
      const result = await get('single');
      expect(result.secretNote).toBe(SECRET);
    });

    it('drops a field the rule removes', async () => {
      const result = await get('foreign');
      expect(result.checkedFor).toBe(user.id);
      expect(result.secretNote).toBeUndefined();
    });
  });

  describe('every shape a project actually returns is visited', () => {
    it('visits each item of a bare array', async () => {
      // An Array has no `securityCheck`, so the interceptor has to reach the items through its deep
      // walk. If that stopped working, a `findX()` endpoint would return unfiltered rows while the
      // single-object endpoint next to it stayed correct.
      const result = await get('array');
      expect(result).toHaveLength(2);
      for (const item of result) {
        expect(item.checkedFor, item.id).toBe(user.id);
      }
      expect(result.find((item: any) => item.id === 'array-own').secretNote).toBe(SECRET);
      expect(result.find((item: any) => item.id === 'array-foreign').secretNote).toBeUndefined();
    });

    it('visits models nested in a plain wrapper object', async () => {
      const result = await get('wrapped');
      expect(result.total).toBe(2);
      for (const item of result.items) {
        expect(item.checkedFor, item.id).toBe(user.id);
      }
      expect(result.items.find((item: any) => item.id === 'wrapped-foreign').secretNote).toBeUndefined();
    });

    it('recurses into models held by an already-checked model', async () => {
      const result = await get('nested');
      expect(result.checkedFor).toBe(user.id);
      expect(result.secretNote).toBe(SECRET);
      // The child belongs to someone else, so ITS rule must have run and narrowed it — being
      // reachable from an allowed parent grants nothing.
      expect(result.child.checkedFor).toBe(user.id);
      expect(result.child.secretNote).toBeUndefined();
      expect(result.children[0].checkedFor).toBe(user.id);
      expect(result.children[0].secretNote).toBeUndefined();
    });
  });

  describe('_doNotCheckSecurityDeep stops the walk at the parent', () => {
    it('checks the parent but not its children', async () => {
      const result = await get('shallow');
      expect(result.checkedFor).toBe(user.id);
      // The escape hatch exists for models that have already filtered their own children (and for
      // cyclic graphs). Pinning it matters in BOTH directions: a project that sets the flag is
      // taking responsibility for its children, and a framework change that started descending
      // anyway would re-run rules on objects the parent already handled.
      expect(result.child.checkedFor).toBeUndefined();
    });
  });

  describe('the secret-field safety net is independent of securityCheck', () => {
    it('strips configured secret fields from plain objects, at any depth', async () => {
      // Nothing here is a model, so no `securityCheck()` runs at all. This is the layer that catches
      // the response a project forgot to model — the reason `security.secretFields` is a union with
      // the framework defaults rather than a replaceable list.
      const result = await get('secret-fields');
      expect(result.note).toBe('visible');
      expect(result.password).toBeUndefined();
      expect(result.nested.password).toBeUndefined();
    });
  });
});
