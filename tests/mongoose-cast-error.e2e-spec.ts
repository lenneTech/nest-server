/**
 * A malformed id from the request answers 404 / 400 — not 500 — on the assembled stack.
 *
 * `MongooseCastErrorFilter` is registered by `CoreModule` as `APP_FILTER`. This spec boots the real
 * `ServerModule`, adds `HttpExceptionLogFilter` the way the starter's `main.ts` does, and drives:
 *
 * - core routes every project has (`/users/:id` over REST, `getUser` over GraphQL): a malformed id is
 *   answered exactly like an unknown one — 404;
 * - a probe model with an ObjectId reference: a malformed value in the body, the query string, or a
 *   nested GraphQL input is the client's mistake — 400;
 * - the refusal half: a cast that fails on a value the request does NOT contain (a broken stored id,
 *   a value computed by server code) stays a 500. Without that case, a filter that turned EVERY
 *   CastError into a 4xx would pass this spec too — and hide real data defects from monitoring.
 *
 * The classification itself (arrays, nesting, numbers, budgets) is unit-tested in
 * `tests/unit/mongoose-cast-error-filter.spec.ts`.
 */
import { Body, Controller, Get, Logger, Param, Patch, Post, Query } from '@nestjs/common';
import { Args, Field, InputType, Query as GqlQuery, Resolver } from '@nestjs/graphql';
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { MongoClient, ObjectId } from 'mongodb';
import { Model, Schema as MongooseSchema } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { HttpExceptionLogFilter, TestGraphQLType, TestHelper } from '../src';
import envConfig from '../src/config.env';
import { Roles } from '../src/core/common/decorators/roles.decorator';
import { RoleEnum } from '../src/core/common/enums/role.enum';
import { ErrorCode } from '../src/core/modules/error-code/error-codes';
import { ServerModule } from '../src/server/server.module';

/** What a client must never see: the Mongoose message names the model. */
const MONGOOSE_LEAK = /Cast to|CastProbe|for model/;

/** An id that is well-formed but names no document — the control for "answered like an unknown id". */
const UNKNOWN_ID = '507f1f77bcf86cd799439011';

/** A malformed id held by SERVER code, never sent by the client. */
const SERVER_SIDE_BROKEN_ID = 'server-side-broken-id';

@Schema()
class CastProbe {
  @Prop({ type: MongooseSchema.Types.ObjectId })
  owner: string;
}
const CastProbeSchema = SchemaFactory.createForClass(CastProbe);

@Controller('cast-probe')
@Roles(RoleEnum.S_EVERYONE)
class CastProbeController {
  constructor(@InjectModel('CastProbe') private readonly probeModel: Model<CastProbe>) {}

  /** The cast fails on a value only the server knows — must stay a 500. */
  @Get('internal/broken-reference')
  async brokenReference() {
    return (await this.probeModel.findById(SERVER_SIDE_BROKEN_ID).lean()) ?? {};
  }

  /** Query string → filter. */
  @Get()
  async find(@Query('owner') owner: string) {
    return this.probeModel.find({ owner }).lean();
  }

  /** Body → nested `$in` filter. */
  @Post('search')
  async search(@Body() body: { filter: { owners: string[] } }) {
    return this.probeModel.find({ owner: { $in: body.filter.owners } }).lean();
  }

  /** Body → update. The route parameter is valid; the body value is not. */
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: { owner: string }) {
    return (await this.probeModel.findByIdAndUpdate(id, { owner: body.owner }).lean()) ?? {};
  }
}

@InputType()
class CastProbeInput {
  @Field(() => String)
  owner: string;
}

@Resolver()
class CastProbeResolver {
  constructor(@InjectModel('CastProbe') private readonly probeModel: Model<CastProbe>) {}

  @GqlQuery(() => Boolean)
  @Roles(RoleEnum.S_EVERYONE)
  async castProbeByInput(@Args('input') input: CastProbeInput): Promise<boolean> {
    return !!(await this.probeModel.findOne({ owner: input.owner }).lean());
  }

  @GqlQuery(() => Boolean)
  @Roles(RoleEnum.S_EVERYONE)
  async castProbeServerSide(): Promise<boolean> {
    return !!(await this.probeModel.findById(SERVER_SIDE_BROKEN_ID).lean());
  }
}

describe('MongooseCastErrorFilter (e2e)', () => {
  let app: any;
  let mongoClient: MongoClient;
  let testHelper: TestHelper;

  const testId = `casterror-${Date.now()}-p${process.pid}`;
  const user = {
    email: `${testId}@test.com`,
    id: '',
    password: `Pw-${Math.random().toString(36).substring(2, 10)}`,
    token: '',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [CastProbeController],
      imports: [ServerModule, MongooseModule.forFeature([{ name: 'CastProbe', schema: CastProbeSchema }])],
      providers: [CastProbeResolver],
    }).compile();
    app = moduleFixture.createNestApplication();
    // As in the starter's main.ts: the filter under test must coexist with the HttpException filter
    app.useGlobalFilters(new HttpExceptionLogFilter());
    await app.init();
    testHelper = new TestHelper(app);
    mongoClient = await MongoClient.connect(envConfig.mongoose.uri);

    const signUp: any = await testHelper.graphQl({
      arguments: { input: { email: user.email, firstName: 'Cast', lastName: 'Error', password: user.password } },
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

  /**
   * @regression   11.42.16 — a malformed id in a route parameter reached Mongoose, whose CastError
   *   escaped the @Catch(HttpException) filter, so GET/PATCH/DELETE /users/<malformed-id> (and 70 more
   *   routes in a consuming project, including the AI module's /ai/<resource>/:id routes) answered
   *   500 instead of the 404 an unknown id gets.
   * @seen-failing Stop registering the filter in src/core.module.ts — registered as mutation
   *   `cast-error-filter-not-registered` in tests/regression-mutations.json.
   */
  describe('a malformed id in a route parameter is answered like an unknown one', () => {
    it.each([
      ['a word', 'upcoming-birthdays'],
      ['the 12-character form ObjectId.isValid() accepts', 'abcdefghijkl'],
    ])('GET /users/<%s> answers 404 without the Mongoose message', async (_label, malformedId) => {
      const body: any = await testHelper.rest(`/users/${malformedId}`, { statusCode: 404, token: user.token });

      expect(body.message).toBe(ErrorCode.RESOURCE_NOT_FOUND);
      expect(JSON.stringify(body)).not.toMatch(MONGOOSE_LEAK);
    });

    it('answers PATCH and DELETE the same way', async () => {
      await testHelper.rest('/users/upcoming-birthdays', {
        method: 'PATCH',
        payload: { jobTitle: 'x' },
        statusCode: 404,
        token: user.token,
      });
      await testHelper.rest('/users/upcoming-birthdays', { method: 'DELETE', statusCode: 404, token: user.token });
    });

    it('control: a well-formed unknown id is a 404 too', async () => {
      await testHelper.rest(`/users/${UNKNOWN_ID}`, { statusCode: 404, token: user.token });
    });

    it('answers getUser(id: <malformed>) over GraphQL with 404', async () => {
      const result: any = await testHelper.graphQl(
        { arguments: { id: 'upcoming-birthdays' }, fields: ['id'], name: 'getUser', type: TestGraphQLType.QUERY },
        { token: user.token },
      );

      expect(result.errors?.[0]?.extensions?.originalError?.statusCode).toBe(404);
      expect(result.errors[0].message).toBe(ErrorCode.RESOURCE_NOT_FOUND);
      expect(JSON.stringify(result.errors)).not.toMatch(MONGOOSE_LEAK);
    });
  });

  describe('a malformed value the client sent as data is a 400', () => {
    it('in the body of an update', async () => {
      const body: any = await testHelper.rest(`/cast-probe/${UNKNOWN_ID}`, {
        method: 'PATCH',
        payload: { owner: 'not-an-object-id' },
        statusCode: 400,
      });

      expect(body.message).toBe(`${ErrorCode.INVALID_FIELD_FORMAT} [owner]`);
      expect(JSON.stringify(body)).not.toMatch(MONGOOSE_LEAK);
    });

    it('in the query string', async () => {
      await testHelper.rest('/cast-probe?owner=not-an-object-id', { statusCode: 400 });
    });

    it('as one element of an array nested in the body', async () => {
      await testHelper.rest('/cast-probe/search', {
        method: 'POST',
        payload: { filter: { owners: [UNKNOWN_ID, 'not-an-object-id'] } },
        statusCode: 400,
      });
    });

    it('nested in a GraphQL input', async () => {
      const result: any = await testHelper.graphQl({
        arguments: { input: { owner: 'not-an-object-id' } },
        name: 'castProbeByInput',
        type: TestGraphQLType.QUERY,
      });

      expect(result.errors?.[0]?.extensions?.originalError?.statusCode).toBe(400);
    });

    it('control: well-formed values pass', async () => {
      await testHelper.rest(`/cast-probe?owner=${UNKNOWN_ID}`, { statusCode: 200 });
      await testHelper.rest(`/cast-probe/${UNKNOWN_ID}`, {
        method: 'PATCH',
        payload: { owner: UNKNOWN_ID },
        statusCode: 200,
      });
    });
  });

  /**
   * @regression   11.42.16 (pre-release) — the refusal half: a cast failure on a value only the server
   *   holds must stay a 500, or a broken stored id is reported as the client's mistake.
   * @seen-failing Make the query/body branch of classifyHttpCastError() in
   *   src/core/common/filters/mongoose-cast-error.filter.ts match unconditionally — registered as
   *   mutation `cast-error-server-value-relabelled-e2e` in tests/regression-mutations.json.
   */
  describe('a cast failure on a value the request does not contain stays a 500', () => {
    it('over REST: the generic Nest body, logged as an error', async () => {
      const logged: string[] = [];
      vi.spyOn(Logger.prototype, 'error').mockImplementation(((message: unknown) => {
        logged.push(String(message));
      }) as never);

      const body: any = await testHelper.rest('/cast-probe/internal/broken-reference', { statusCode: 500 });

      expect(body).toEqual({ message: 'Internal server error', statusCode: 500 });
      expect(logged.some((line) => line.includes(SERVER_SIDE_BROKEN_ID))).toBe(true);
    });

    it('over GraphQL: neither a 404 nor a 400', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation((() => undefined) as never);

      const result: any = await testHelper.graphQl({ name: 'castProbeServerSide', type: TestGraphQLType.QUERY });

      expect(result.errors?.length).toBe(1);
      expect([400, 404]).not.toContain(result.errors[0].extensions?.originalError?.statusCode);
      expect(result.errors[0].extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
});
