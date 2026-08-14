import { ValidationArguments } from 'class-validator';

/**
 * Renders a single constraint for use in an error message.
 *
 * Mirror of class-validator's internal `constraintToString`
 * (`class-validator/cjs/validation/ValidationUtils`), which is NOT part of its public API.
 *
 * See {@link replaceMessageSpecialTokens} for why this lives here and what holds it in sync.
 */
export function constraintToString(constraint: unknown): string {
  if (Array.isArray(constraint)) {
    return constraint.join(', ');
  }
  if (typeof constraint === 'symbol') {
    constraint = constraint.description;
  }
  return `${constraint}`;
}

/**
 * Resolves a message (string or function) and interpolates the special tokens
 * $constraint1..N, $value, $property and $target.
 *
 * Mirror of class-validator's internal `ValidationUtils.replaceMessageSpecialTokens`
 * (`class-validator/cjs/validation/ValidationUtils`), which is NOT part of its public API.
 * `MapAndValidatePipe` re-implements the validation executor and therefore has to render messages
 * exactly the way class-validator's own `validate()` would — otherwise the same decorator produces
 * two different strings depending on which of the two ran.
 *
 * WHY IT IS NOT BARREL-EXPORTED
 * Deliberately absent from `src/index.ts`. It exists to reproduce a dependency's internal
 * behaviour, so it has to stay free to follow that dependency; exporting it would owe consumers
 * backward compatibility for a surface we do not control. Vendor-mode consumers resolve their own
 * class-validator, so the copy in `src/core/` can meet a version this repo never installed —
 * `tests/unit/validation-message-mirror.spec.ts` compares it against the INSTALLED implementation
 * over a fixture table so a divergence surfaces as a failing test rather than as two renderers of
 * one contract.
 *
 * SECURITY — `$value` echoes the SUBMITTED value back to the client, and validation errors are
 * never scrubbed: `security.secretFields` is applied by `CheckSecurityInterceptor` on the RESPONSE
 * path, whereas the `BadRequestException` raised from the pipe goes to the exception filter and is
 * forwarded verbatim. The check below is a TYPE guard (boolean | number | string), not a secrecy
 * guard — it happily admits a password or a token. No built-in message uses `$value`, so reaching
 * it is opt-in: never put `$value` in a custom message on a sensitive field.
 */
export function replaceMessageSpecialTokens(
  message: ((args: ValidationArguments) => string) | string,
  validationArguments: ValidationArguments,
): string {
  let messageString = '';
  if (typeof message === 'function') {
    messageString = message(validationArguments);
  } else if (typeof message === 'string') {
    messageString = message;
  }

  if (messageString && Array.isArray(validationArguments.constraints)) {
    validationArguments.constraints.forEach((constraint, index) => {
      messageString = messageString.replace(
        new RegExp(`\\$constraint${index + 1}`, 'g'),
        constraintToString(constraint),
      );
    });
  }

  if (
    messageString &&
    validationArguments.value !== undefined &&
    validationArguments.value !== null &&
    ['boolean', 'number', 'string'].includes(typeof validationArguments.value)
  ) {
    messageString = messageString.replace(/\$value/g, `${validationArguments.value}`);
  }
  if (messageString) {
    messageString = messageString.replace(/\$property/g, validationArguments.property);
  }
  if (messageString) {
    messageString = messageString.replace(/\$target/g, validationArguments.targetName);
  }

  return messageString;
}
