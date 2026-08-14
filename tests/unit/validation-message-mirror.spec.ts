/**
 * Unit Tests: the local mirror of class-validator's message renderer must not drift from the
 * installed class-validator.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MapAndValidatePipe` re-implements class-validator's `ValidationExecutor`, so it also has to
 * render error messages the way that executor does. 11.34.1 fixed it doing neither — a custom
 * `message` was dropped, and `$constraint1` reached API clients raw. The fix ports two internal
 * functions (`ValidationUtils.replaceMessageSpecialTokens`, `constraintToString`) into
 * `src/core/common/helpers/validation-message.helper.ts`.
 *
 * A port is correct on the day it is written. What makes this one worth guarding is that
 * VENDOR-MODE CONSUMERS RESOLVE THEIR OWN class-validator: `package.json` pins the version for
 * this repo, but the copy of `src/core/` in a consumer's tree can meet 0.16 without anyone here
 * touching anything. The failure is quiet by construction — the consumer's own `validate()` and
 * the pipe render the SAME decorator differently, and only one of the two is under test anywhere.
 *
 * So this file asserts the invariant rather than the crash: for one fixture table, the mirror and
 * the installed implementation must produce identical strings. It deep-imports
 * `class-validator/cjs/validation/ValidationUtils`, which is not public API — normally a smell,
 * here the entire point. `tests/` is never vendored and never shipped, so the deep import stays
 * out of consumer trees. Precedent: `tests/unit/import-cycle-invariants.spec.ts`.
 *
 * @regression   11.34.1 — the pipe rendered messages from `defaultMessage()` alone and replaced
 *   only `$property`, so custom messages were dropped and `$constraint1` leaked raw. The port that
 *   fixed it is only as good as its agreement with upstream, which is what this file pins.
 * @seen-failing Delete the `$target` replacement from `replaceMessageSpecialTokens()` in
 *   src/core/common/helpers/validation-message.helper.ts — registered as mutation
 *   `validation-mirror-drops-target-token` in tests/regression-mutations.json. That token is
 *   reached by NO e2e case, so this mutation goes red here and nowhere else: it demonstrates the
 *   coverage this file adds rather than merely re-proving the pipe spec.
 */
import { ValidationArguments } from 'class-validator';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { constraintToString, replaceMessageSpecialTokens } from '../../src/core/common/helpers/validation-message.helper';

/**
 * The internals under comparison. Loaded through `createRequire` rather than an `import`, because
 * class-validator ships type declarations under `types/` and runtime under `cjs/` — the deep
 * runtime path has no `.d.ts` beside it and would not resolve as a typed ESM import.
 */
const requireCjs = createRequire(__filename);
const upstream = requireCjs('class-validator/cjs/validation/ValidationUtils') as {
  constraintToString: (constraint: unknown) => string;
  ValidationUtils: {
    replaceMessageSpecialTokens: (
      message: ((args: ValidationArguments) => string) | string,
      validationArguments: ValidationArguments,
    ) => string;
  };
};

function args(partial: Partial<ValidationArguments> = {}): ValidationArguments {
  return {
    constraints: [],
    object: {},
    property: 'roles',
    targetName: 'UserInput',
    value: undefined,
    ...partial,
  };
}

/**
 * Every case declares its `expected` string, so the table doubles as documentation AND as a
 * vacuity guard: a fixture that exercises no interpolation would show up here as an `expected`
 * identical to its `message`, instead of hiding behind a trivially satisfied `mirror === upstream`.
 */
const CASES: { expected: string; message: ((args: ValidationArguments) => string) | string; name: string; validationArguments: ValidationArguments }[] = [
  {
    expected: 'must be one of the following values: alpha, beta',
    message: 'must be one of the following values: $constraint1',
    name: 'an array constraint renders comma-separated',
    validationArguments: args({ constraints: [['alpha', 'beta']] }),
  },
  {
    expected: 'must be between 1 and 10',
    message: 'must be between $constraint1 and $constraint2',
    name: 'multiple constraints are numbered in order',
    validationArguments: args({ constraints: [1, 10] }),
  },
  {
    expected: 'scope tenant',
    message: 'scope $constraint1',
    name: 'a symbol constraint renders its description',
    validationArguments: args({ constraints: [Symbol('tenant')] }),
  },
  {
    expected: 'scope undefined',
    message: 'scope $constraint1',
    name: 'a symbol constraint without a description renders "undefined"',
    validationArguments: args({ constraints: [Symbol()] }),
  },
  {
    expected: 'shape [object Object]',
    message: 'shape $constraint1',
    name: 'an object constraint falls back to string coercion (the shape a 0.16 could change)',
    validationArguments: args({ constraints: [{ a: 1 }] }),
  },
  {
    expected: 'got gamma',
    message: 'got $value',
    name: 'a string $value is echoed',
    validationArguments: args({ value: 'gamma' }),
  },
  {
    expected: 'got 7',
    message: 'got $value',
    name: 'a numeric $value is echoed',
    validationArguments: args({ value: 7 }),
  },
  {
    expected: 'got false',
    message: 'got $value',
    name: 'a boolean $value is echoed, false included',
    validationArguments: args({ value: false }),
  },
  {
    expected: 'got $value',
    message: 'got $value',
    name: 'a non-primitive $value is NOT echoed',
    validationArguments: args({ value: { secret: 'x' } }),
  },
  {
    expected: 'got $value',
    message: 'got $value',
    name: 'a null $value is NOT echoed',
    validationArguments: args({ value: null }),
  },
  {
    expected: 'got $value',
    message: 'got $value',
    name: 'an undefined $value is NOT echoed',
    validationArguments: args({ value: undefined }),
  },
  {
    expected: 'x a$valueb y',
    message: 'x $value y',
    name: 'a $value carrying a replacement pattern ($&) is inserted by the same rules on both sides',
    validationArguments: args({ value: 'a$&b' }),
  },
  {
    expected: 'roles is invalid',
    message: '$property is invalid',
    name: '$property is replaced',
    validationArguments: args(),
  },
  {
    expected: 'UserInput is invalid',
    message: '$target is invalid',
    name: '$target is replaced',
    validationArguments: args(),
  },
  {
    expected: 'roles roles roles',
    message: '$property $property $property',
    name: 'a repeated token is replaced everywhere, not just once',
    validationArguments: args(),
  },
  {
    expected: 'UserInput.roles rejected admin (allowed: a, b)',
    message: '$target.$property rejected $value (allowed: $constraint1)',
    name: 'all four token kinds in one message',
    validationArguments: args({ constraints: [['a', 'b']], value: 'admin' }),
  },
  {
    expected: 'roles must be one of: a, b',
    message: (a: ValidationArguments) => `${a.property} must be one of: $constraint1`,
    name: 'a function-form message is invoked and its result is then interpolated',
    validationArguments: args({ constraints: [['a', 'b']] }),
  },
  {
    expected: 'each value in roles must be one of the following values: alpha, beta',
    message: 'each value in $property must be one of the following values: $constraint1',
    name: 'the "each value in" prefix of a per-item default message survives interpolation',
    validationArguments: args({ constraints: [['alpha', 'beta']] }),
  },
  {
    expected: 'nothing to interpolate',
    message: 'nothing to interpolate',
    name: 'a message without tokens passes through unchanged',
    validationArguments: args({ constraints: [['a']], value: 'x' }),
  },
  {
    expected: '',
    message: '',
    name: 'an empty message stays empty',
    validationArguments: args({ constraints: [['a']], value: 'x' }),
  },
  {
    expected: 'unknown $constraint1',
    message: 'unknown $constraint1',
    name: 'a missing constraints array leaves $constraint tokens raw',
    validationArguments: args({ constraints: undefined as unknown as any[] }),
  },
];

describe('validation message mirror', () => {
  describe('replaceMessageSpecialTokens matches the installed class-validator', () => {
    it.each(CASES.map(entry => [entry.name, entry] as const))('%s', (_name, entry) => {
      const mine = replaceMessageSpecialTokens(entry.message, entry.validationArguments);
      const theirs = upstream.ValidationUtils.replaceMessageSpecialTokens(entry.message, entry.validationArguments);

      // Both must render the DECLARED string. Asserting only `mine === theirs` would let a fixture
      // that exercises nothing pass while proving nothing.
      expect(theirs).toEqual(entry.expected);
      expect(mine).toEqual(entry.expected);
    });
  });

  describe('constraintToString matches the installed class-validator', () => {
    const CONSTRAINTS: [string, unknown][] = [
      ['an array', ['alpha', 'beta']],
      ['an empty array', []],
      ['a nested array', [['a', 'b'], 'c']],
      ['a symbol', Symbol('tenant')],
      ['a symbol without description', Symbol()],
      ['a number', 42],
      ['a string', 'plain'],
      ['a boolean', true],
      ['null', null],
      ['undefined', undefined],
      ['an object', { a: 1 }],
    ];

    it.each(CONSTRAINTS)('%s', (_name, constraint) => {
      expect(constraintToString(constraint)).toEqual(upstream.constraintToString(constraint));
    });
  });

  it('documents the one deliberate divergence, which no call site can reach', () => {
    // Upstream initializes its accumulator as `undefined` and returns it untouched when the message
    // is neither a string nor a function; the mirror initializes to '' and returns ''. Inert,
    // because upstream's executor pre-normalizes (`metadata.message || ''`) and BOTH call sites in
    // MapAndValidatePipe are guarded by a truthiness check on the template — so the argument is
    // always a non-empty string or a function. Asserted rather than omitted: a divergence nobody
    // writes down is indistinguishable from one nobody noticed.
    const unreachable = undefined as unknown as string;

    expect(upstream.ValidationUtils.replaceMessageSpecialTokens(unreachable, args())).toBeUndefined();
    expect(replaceMessageSpecialTokens(unreachable, args())).toEqual('');
  });
});
