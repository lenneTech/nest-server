---
name: brevo-sdk-v6
description: Brevo SDK v3→v6 — the awaited data shape is identical, so BrevoService's contract is NOT breaking; what breaks is removed SDK symbols, the thrown error type, and new default retries.
metadata:
  type: project
---

Verified against both tarballs (2026-07-22, `@getbrevo/brevo` 3.0.4 vs 6.0.2):

- v3: `sendTransacEmail()` → `Promise<{ response: http.IncomingMessage, body: CreateSmtpEmail }>`;
  `CreateSmtpEmail = { messageId?, messageIds? }`.
- v6: `sendTransacEmail()` → `HttpResponsePromise<SendTransacEmailResponse>`, and
  `HttpResponsePromise<T> extends Promise<T>` — so `await` yields `T` directly.
  `SendTransacEmailResponse = { messageId?, messageIds? }`.

**So dropping `.body` is correct and the consumer-visible data shape is unchanged.** The HTTP
envelope v3 exposed as `result.response` is still reachable via `.withRawResponse()`.

What *is* breaking / new:
- `SendSmtpEmail`, `TransactionalEmailsApi`, `TransactionalEmailsApiApiKeys` no longer exist.
- Thrown error changed from an axios-shaped `{response, body}` to
  `BrevoError { statusCode, body, rawResponse, requestId }`. Verified it does **not** carry
  request headers — `console.error(error)` cannot leak the `xkeysib-` key.
- v6 retries by default: `DEFAULT_MAX_RETRIES = 2` on 408/429/5xx, backoff honours
  `Retry-After`/`X-RateLimit-Reset`, capped 60 s per delay. v3/axios did not retry.
  No default timeout in either. Set `timeoutInSeconds` + `maxRetries` on `new BrevoClient()`.
- v6 has zero runtime dependencies (axios gone) — the `axios@<1.18.0` override now only
  covers `node-mailjet`.

**How to apply:** when someone claims the v6 upgrade is a breaking change for `BrevoService`
consumers, it is not — grade the SDK-symbol removal and the error-type change instead.
