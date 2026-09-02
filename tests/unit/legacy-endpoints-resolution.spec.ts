/**
 * The resolution table for `auth.legacyEndpoints`, asserted row by row.
 *
 * WHY THIS FILE EXISTS
 *
 * `isLegacyEndpointEnabled()` decides whether a second, fully functional password
 * authentication surface is reachable: `signIn` / `signUp` / `logout` / `refreshToken` over
 * GraphQL and `/auth/signin` / `/auth/signup` / `/auth/logout` / `/auth/refresh-token` over
 * REST. 11.38.0 flipped its default from ON to OFF — the headline breaking change of that
 * release.
 *
 * And nothing could observe it. Every environment in this repository's own `config.env.ts`
 * sets `legacyEndpoints: { enabled: true }`, and the only suites that touch the option
 * (`scenario-3-http410`, `scenario-3-iam-only`) set `enabled: false` explicitly — the branch
 * that behaved identically before and after. Reverting the flip to `enabled !== false` left
 * the unit suite (1958 tests) and the legacy-relevant e2e specs green, measured, not assumed.
 * The release's central hardening was a claim with no check behind it.
 *
 * The rows below are that check. The two that matter most are the ones no other test reaches:
 * "nothing set" (the flip itself) and "explicit off plus per-transport on" (the asymmetry that
 * keeps an upgrade from widening a door a project deliberately closed).
 *
 * @regression   11.38.0 — `auth.legacyEndpoints.enabled` defaults to `false`. Before the flip
 *   a project that registered the legacy auth module and never made a decision kept a second
 *   password-authentication surface open indefinitely, by inertia rather than by choice.
 * @seen-failing Registered mutation `legacy-endpoints-default-on` in
 *   tests/regression-mutations.json — restores `enabled !== false` as the fall-through, i.e.
 *   the pre-11.38.0 default.
 */

import { describe, expect, it } from 'vitest';

import type { IAuthLegacyEndpoints } from '../../src/core/common/interfaces/server-options.interface';

import { isLegacyEndpointEnabled } from '../../src/core/modules/auth/helpers/legacy-endpoints.helper';

interface Row {
  /** What the config block looks like, `undefined` meaning the key is absent entirely. */
  config: IAuthLegacyEndpoints | undefined;
  expectedGraphql: boolean;
  expectedRest: boolean;
  /** Why this row is what it is — the reason, not a restatement of the values. */
  why: string;
}

const TABLE: Row[] = [
  {
    config: undefined,
    expectedGraphql: false,
    expectedRest: false,
    why: 'no config at all — the flip. A project that never decided gets no legacy surface.',
  },
  {
    config: {},
    expectedGraphql: false,
    expectedRest: false,
    why: 'an empty block is still no decision. Presence of the key must not imply consent.',
  },
  {
    config: { enabled: true },
    expectedGraphql: true,
    expectedRest: true,
    why: 'the opt-in a project still mid-migration has to write.',
  },
  {
    config: { enabled: false },
    expectedGraphql: false,
    expectedRest: false,
    why: 'the explicit off switch, unchanged from before 11.38.0.',
  },
  {
    config: { graphql: true },
    expectedGraphql: true,
    expectedRest: false,
    why: 'a per-transport flag decides its own transport and says nothing about the other.',
  },
  {
    config: { rest: true },
    expectedGraphql: false,
    expectedRest: true,
    why: 'the mirror of the row above.',
  },
  {
    config: { enabled: true, graphql: false },
    expectedGraphql: false,
    expectedRest: true,
    why: 'a per-transport flag narrows a global on — this is how a project retires one transport first.',
  },
  {
    config: { enabled: false, rest: true },
    expectedGraphql: false,
    expectedRest: false,
    why:
      'THE ASYMMETRY. An explicit `enabled: false` is a hard off switch that a per-transport ' +
      '`true` cannot reopen. It is the setting a project reached for to close legacy down, and ' +
      'an upgrade must never widen it.',
  },
  {
    config: { enabled: false, graphql: true },
    expectedGraphql: false,
    expectedRest: false,
    why: 'the same asymmetry on the other transport.',
  },
];

describe('isLegacyEndpointEnabled — resolution table', () => {
  for (const row of TABLE) {
    const label = row.config === undefined ? 'undefined' : JSON.stringify(row.config);

    it(`${label} → graphql=${row.expectedGraphql}, rest=${row.expectedRest} (${row.why})`, () => {
      expect(isLegacyEndpointEnabled(row.config, 'graphql'), `graphql: ${row.why}`).toBe(row.expectedGraphql);
      expect(isLegacyEndpointEnabled(row.config, 'rest'), `rest: ${row.why}`).toBe(row.expectedRest);
    });
  }

  it('is closed for every configuration that does not ask for it', () => {
    // Stated once as a property rather than nine times as a row: the only inputs that may
    // return true are those where the caller wrote `true` somewhere. A future refactor that
    // reintroduces any implicit-on path fails here even if it invents a config shape the
    // table above does not list.
    for (const row of TABLE) {
      const asksForGraphql = row.config?.graphql === true || (row.config?.enabled === true && row.config?.graphql !== false);
      const asksForRest = row.config?.rest === true || (row.config?.enabled === true && row.config?.rest !== false);
      const hardOff = row.config?.enabled === false;

      expect(isLegacyEndpointEnabled(row.config, 'graphql')).toBe(!hardOff && asksForGraphql);
      expect(isLegacyEndpointEnabled(row.config, 'rest')).toBe(!hardOff && asksForRest);
    }
  });

  it('treats a non-boolean per-transport value as "not set" rather than as truthy', () => {
    // Config arrives as JSON through NEST_SERVER_CONFIG / NSC__*, so a string is reachable.
    // `'false'` is truthy in JavaScript; reading it as "on" would turn a deployment's attempt
    // to switch the transport off into switching it on.
    const config = { graphql: 'false', rest: 'true' } as unknown as IAuthLegacyEndpoints;

    expect(isLegacyEndpointEnabled(config, 'graphql')).toBe(false);
    expect(isLegacyEndpointEnabled(config, 'rest')).toBe(false);
  });
});
