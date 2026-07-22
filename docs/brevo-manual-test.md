# Brevo: manual test against the real API

> **Framework repo only.** This page ships inside the npm package (because `docs/**` is in
> `package.json` `files`), but the things it tells you to run do **not**: `scripts/` and
> `.env.example` are excluded from the tarball, and `src/config.env.ts` is a path that only exists
> in this repository. If you are reading this from
> `node_modules/@lenne.tech/nest-server/docs/`, clone
> [lenneTech/nest-server](https://github.com/lenneTech/nest-server) to follow along. For configuring
> Brevo in *your* project, see the `brevo` block in `FRAMEWORK-API.md` instead.

The unit spec (`src/core/common/services/brevo.service.spec.ts`) covers `BrevoService` against a
mocked SDK. That proves the logic, not the wire format. This guide is the one-off manual check
against the **live** Brevo endpoint — worth running once after an SDK upgrade, and any time you
suspect a credential or sender problem.

> Every send here costs one transactional email from your Brevo quota and really lands in a mailbox.

## 1. Get the credentials

| What                | Where to get it                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| **API key**         | <https://app.brevo.com/settings/keys/api> → *Generate a new API key*. Starts with `xkeysib-`.              |
| **Verified sender** | <https://app.brevo.com/senders/list> → *Add a sender*, then confirm the mail Brevo sends to that address.  |
| **Template ID**     | *(optional)* <https://app.brevo.com/templates/listing> → open a template, the numeric ID is in the URL.    |

Two pitfalls, both of which produce a confusing failure:

- **Use the API v3 key, not the SMTP key.** Brevo issues two kinds of credential on neighbouring
  settings pages. The REST API — which `BrevoService` talks to — only accepts a key starting with
  **`xkeysib-`**. A key starting with `xsmtpsib-` is the SMTP password for `smtp-relay.brevo.com`
  and is rejected by every `api.brevo.com/v3/*` endpoint with `401 {"message":"Key not found"}`.
- **The sender address must be verified in Brevo.** An unverified sender is the most common cause
  of a send that fails with HTTP 400 despite a valid key.

To check a key in isolation before spending a send, hit an endpoint that takes no payload:

```bash
curl -s -w '\nHTTP %{http_code}\n' -H "api-key: $BREVO_API_KEY" https://api.brevo.com/v3/account
```

`HTTP 200` plus your account JSON means the key is good; `401 "Key not found"` means it is the
wrong kind of key or belongs to a deleted account.

## 2. Put them in `.env`

`src/config.env.ts` calls `dotenv.config()` at import time, so a `.env` in the repo root is picked
up by both the server and the smoke script. There is no `.env` in the repo — create one from the
template:

```bash
cp .env.example .env
```

Then set these four keys in `.env`. `EMAIL_DEFAULT_SENDER` is already an **active** line in the
template; `EMAIL_DEFAULT_SENDER_NAME`, `BREVO_API_KEY`, `BREVO_SMOKE_TO` and
`BREVO_SMOKE_TEMPLATE_ID` are there as comments — uncomment and fill them in:

```dotenv
# API key from app.brevo.com/settings/keys/api
BREVO_API_KEY=xkeysib-your-real-key

# Sender - must be a VERIFIED sender in Brevo
EMAIL_DEFAULT_SENDER=noreply@your-verified-domain.tld
EMAIL_DEFAULT_SENDER_NAME=Nest Server Manual Test

# Recipient for the smoke script - a mailbox you can actually open
BREVO_SMOKE_TO=you@your-mailbox.tld

# Optional: only needed for the template send in step 3b
# BREVO_SMOKE_TEMPLATE_ID=12
```

`.env` is git-ignored — never commit real keys.

Config-wise this is all that is needed: `config.env.ts` only builds the `brevo` block **when
`BREVO_API_KEY` is set** (`...(process.env.BREVO_API_KEY ? { brevo: {...} } : {})`). Without the
key there is no `brevo` config, `BrevoService` refuses to construct, and everything falls back to
SMTP.

## 3. Run the smoke script

```bash
pnpm exec tsx scripts/brevo-smoke.ts
```

It builds a real `ConfigService` + `BrevoService` (no mocks, no Nest bootstrap) and sends through
the same code path the server uses.

### 3a. What you should see

```
[brevo-smoke] sender:    Nest Server Manual Test <noreply@your-verified-domain.tld>
[brevo-smoke] recipient: you@your-mailbox.tld
[brevo-smoke] sending HTML mail via sendHtmlMail() ...
[brevo-smoke] sendHtmlMail result: { messageId: '<2026...@smtp-relay.mailin.fr>' }
[brevo-smoke] OK - check the recipient mailbox and https://app.brevo.com/transactional/email/logs.
```

A `messageId` means Brevo accepted the mail. Confirm it twice:

1. The mail arrives in the recipient mailbox (check spam on the first run).
2. It shows up under **Transactional → Logs**: <https://app.brevo.com/transactional/email/logs>.

### 3b. Also test a template (optional)

Templates are what `sendMail()` uses in production (e.g. BetterAuth email verification via
`betterAuth.emailVerification.brevoTemplateId`). Set `BREVO_SMOKE_TEMPLATE_ID` in `.env` and re-run
— the script then additionally calls `sendMail(to, templateId, { smokeTestStamp })`. Put
`{{ params.smokeTestStamp }}` somewhere in the template body to see the parameter substitution
land.

Note: template parameters only substitute when the template uses Brevo's **New Template Language**.
Old-language templates silently ignore `params`.

### 3c. Reading a failure

`BrevoService` catches SDK errors, logs them and returns `null` — so the script prints the full
error object above a `result: null`. The status code tells you which knob is wrong:

| Status                       | Cause                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- |
| **401 Unauthorized**         | `BREVO_API_KEY` wrong, revoked, or from a different Brevo account.            |
| **400 Bad Request**          | Usually an unverified sender, or an invalid/foreign `templateId`.            |
| **402 Payment Required**     | Free-plan daily quota exhausted.                                              |
| **`result: 'TEST_USER!'`**   | The recipient matched `config.brevo.exclude` — nothing was sent (see step 5). |

A quick way to confirm the wiring without spending a send: run it with a bogus key. You should get
a clean 401 from `https://api.brevo.com/v3/smtp/email` — which proves client construction, request
build and error handling all work:

```bash
BREVO_API_KEY=xkeysib-invalid BREVO_SMOKE_TO=smoke@test.com \
  EMAIL_DEFAULT_SENDER=noreply@test.com pnpm exec tsx scripts/brevo-smoke.ts
```

## 4. End-to-end through the server (optional)

To test the path a real feature takes rather than the service in isolation, use BetterAuth's email
verification, which is the framework's built-in `BrevoService` consumer
(`core-better-auth-email-verification.service.ts:180`):

1. In `src/config.env.ts`, set `betterAuth.emailVerification.brevoTemplateId` to your template ID
   for the `local` environment.
2. Start the server: `pnpm run start:local`.
3. Sign up a user with an address you can read — the verification mail is sent through Brevo
   instead of SMTP.

If `brevoTemplateId` is unset or `BrevoService` is unavailable, the flow silently uses the SMTP
transport instead — so seeing an SMTP mail is the expected signal that the Brevo overlay is *not*
active.

## 5. The `exclude` guard

`config.brevo.exclude` is a `RegExp` that suppresses sends to matching addresses (returns the
string `'TEST_USER!'` instead). It is unset by default and the smoke script deliberately does not
set one. If you add one to `config.env.ts` for local work, remember the recipient you are testing
with must **not** match it, or nothing will be sent.

Note for maintainers: the guard is read from `configService.config`, never from
`configFastButReadOnly`. A deep-frozen `RegExp` carrying the `g` flag throws on `.test()` because
the call assigns `lastIndex`. The unit spec pins this behaviour.

## 6. Clean up

Remove the real key from `.env` when you are done, or delete the file. Revoke the key in Brevo if
it was created only for this test.
