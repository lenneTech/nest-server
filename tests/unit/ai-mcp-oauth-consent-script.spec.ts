/**
 * The client script of the built-in MCP OAuth consent page's sign-in view.
 *
 * It is plain ES5 embedded in the page, so nothing type-checks or bundles it. These cases run it in
 * a minimal DOM stand-in and pin what it does against Better-Auth: which endpoint, which body, the
 * two-factor step, and that it reloads — the unchanged `/authorize` request is then answered with a
 * session — only on success.
 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import {
  MCP_OAUTH_CONSENT_GUARD_SCRIPT,
  MCP_OAUTH_CONSENT_SCRIPT,
} from '../../src/core/modules/ai/helpers/ai-mcp-oauth-consent.helper';

type Listener = (event: { preventDefault: () => void }) => void;

function element(
  attributes: Record<string, string> = {},
  fields: Record<string, { checked?: boolean; value?: string }> = {},
) {
  const listeners: Record<string, Listener> = {};
  return {
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    elements: fields,
    getAttribute: (name: string) => attributes[name] ?? null,
    hidden: false,
    submit: () => listeners.submit?.({ preventDefault: () => undefined }),
    textContent: '',
  };
}

/** Runs the script against a stand-in DOM; `responses` answer the fetch calls in order. */
function runScript(responses: { body?: unknown; ok: boolean }[]) {
  const root = element({
    'data-auth-base': '/iam',
    'data-code-failed': 'CODE FAILED',
    'data-sign-in-failed': 'SIGN-IN FAILED',
  });
  const passwordForm = element({}, { email: { value: 'ada@example.com' }, password: { value: 'secret' } });
  passwordForm.hidden = true;
  const factorForm = element({}, { backup: { checked: false }, code: { value: '123456' } });
  factorForm.hidden = true;
  const error = element();
  error.hidden = true;
  const byId: Record<string, unknown> = {
    'lt-mcp-error': error,
    'lt-mcp-password': passwordForm,
    'lt-mcp-second-factor': factorForm,
    'lt-mcp-signin': root,
  };
  const queue = [...responses];
  const fetch = vi.fn(async () => {
    const next = queue.shift() ?? { ok: false };
    return { json: async () => next.body ?? {}, ok: next.ok };
  });
  const reload = vi.fn();
  runInNewContext(MCP_OAUTH_CONSENT_SCRIPT, {
    document: { getElementById: (id: string) => byId[id] ?? null },
    fetch,
    location: { reload },
  });
  return { error, factorForm, fetch, passwordForm, reload };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MCP OAuth consent page — sign-in script', () => {
  it('signs in with e-mail and password against Better-Auth on this origin, then reloads', async () => {
    const { fetch, passwordForm, reload } = runScript([{ body: { success: true }, ok: true }]);
    // Rendered hidden (no form without the script); the script reveals it.
    expect(passwordForm.hidden).toBe(false);

    passwordForm.submit();
    await settle();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('/iam/sign-in/email');
    expect(init).toMatchObject({ credentials: 'same-origin', method: 'POST' });
    expect(JSON.parse(init.body)).toEqual({ email: 'ada@example.com', password: 'secret' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('asks for the second factor when Better-Auth requires it, verifies the TOTP code, then reloads', async () => {
    const { factorForm, fetch, passwordForm, reload } = runScript([
      { body: { requiresTwoFactor: true, success: false }, ok: true },
      { body: { status: true }, ok: true },
    ]);

    passwordForm.submit();
    await settle();
    expect(passwordForm.hidden).toBe(true);
    expect(factorForm.hidden).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    factorForm.submit();
    await settle();
    const [url, init] = fetch.mock.calls[1] as unknown as [string, any];
    expect(url).toBe('/iam/two-factor/verify-totp');
    expect(JSON.parse(init.body)).toEqual({ code: '123456' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('uses the backup-code endpoint when the user chose it', async () => {
    const { factorForm, fetch, passwordForm } = runScript([
      { body: { twoFactorRedirect: true }, ok: true },
      { ok: true },
    ]);
    passwordForm.submit();
    await settle();

    factorForm.elements.backup.checked = true;
    factorForm.submit();
    await settle();

    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe('/iam/two-factor/verify-backup-code');
  });

  it('shows the failure and does not reload when Better-Auth refuses', async () => {
    const { error, passwordForm, reload } = runScript([{ ok: false }]);

    passwordForm.submit();
    await settle();

    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('SIGN-IN FAILED');
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload on a refused second factor', async () => {
    const { error, factorForm, passwordForm, reload } = runScript([
      { body: { requiresTwoFactor: true }, ok: true },
      { ok: false },
    ]);
    passwordForm.submit();
    await settle();

    factorForm.submit();
    await settle();

    expect(error.textContent).toBe('CODE FAILED');
    expect(reload).not.toHaveBeenCalled();
  });
});

/**
 * The consent view's guard: Allow counts only after intent on THIS page — visible, focused, and a
 * pointer move / key / touch at least 600 ms after it got there. Against double-clickjacking.
 */
describe('MCP OAuth consent page — Allow guard', () => {
  type Handler = (event: any) => void;

  function runGuard() {
    let now = 1_000_000;
    let focused = true;
    const docListeners: Record<string, Handler[]> = {};
    const winListeners: Record<string, Handler[]> = {};
    const clickListeners: Handler[] = [];
    const allow = {
      addEventListener: (type: string, handler: Handler) => type === 'click' && clickListeners.push(handler),
      disabled: true,
    };
    const document = {
      addEventListener: (type: string, handler: Handler) => (docListeners[type] ??= []).push(handler),
      getElementById: (id: string) => (id === 'lt-mcp-allow' ? allow : null),
      hasFocus: () => focused,
      visibilityState: 'visible',
    };
    runInNewContext(MCP_OAUTH_CONSENT_GUARD_SCRIPT, {
      Date: { now: () => now },
      document,
      fetch: vi.fn(),
      location: { reload: vi.fn() },
      window: { addEventListener: (type: string, handler: Handler) => (winListeners[type] ??= []).push(handler) },
    });
    const fire = (type: string, event: any = {}) => (docListeners[type] ?? []).forEach((h) => h({ type, ...event }));
    const fireWindow = (type: string) => (winListeners[type] ?? []).forEach((h) => h({ type }));
    /** Clicks Allow; true when the submission went through (the click was not prevented). */
    const click = () => {
      let prevented = false;
      clickListeners.forEach((h) => h({ preventDefault: () => (prevented = true) }));
      return !prevented;
    };
    return {
      advance: (ms: number) => (now += ms),
      allow,
      blur: () => {
        focused = false;
        fireWindow('blur');
      },
      click,
      fire,
      focus: () => {
        focused = true;
        fireWindow('focus');
      },
    };
  }

  /**
   * @regression   11.43.0 (pre-release review) — without the guard, Allow was clickable the moment
   *   the page loaded: a hostile page could open a popup, send this window to /authorize behind it
   *   and let the second click of a "double-click" land on Allow.
   * @seen-failing Registered as `mcp-oauth-consent-double-clickjacking` in
   *   tests/regression-mutations.json.
   */
  it('ignores a click that arrives right after the window got focus, as in double-clickjacking', () => {
    const guard = runGuard();
    expect(guard.allow.disabled).toBe(false); // the script enables the button, the guard decides
    guard.blur();
    guard.focus(); // the popup closed: this window is in front again
    guard.advance(80);
    guard.fire('pointermove');
    expect(guard.click()).toBe(false);
  });

  it('counts a click after the user moved the pointer on the visible page for a moment', () => {
    const guard = runGuard();
    guard.advance(700);
    guard.fire('pointermove');
    expect(guard.click()).toBe(true);
  });

  it('does not count a stationary mouse press as intent, but a key or a touch', () => {
    const mouse = runGuard();
    mouse.advance(700);
    mouse.fire('pointerdown', { pointerType: 'mouse' });
    expect(mouse.click()).toBe(false);

    const keyboard = runGuard();
    keyboard.advance(700);
    keyboard.fire('keydown');
    expect(keyboard.click()).toBe(true);

    const touch = runGuard();
    touch.advance(700);
    touch.fire('pointerdown', { pointerType: 'touch' });
    expect(touch.click()).toBe(true);
  });

  it('forgets earlier intent when the window loses focus', () => {
    const guard = runGuard();
    guard.advance(700);
    guard.fire('pointermove');
    guard.blur();
    guard.focus();
    expect(guard.click()).toBe(false);
  });
});
