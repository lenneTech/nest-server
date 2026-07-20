import { describe, expect, it } from 'vitest';

import { CoreHubMailboxService } from './core-hub-mailbox.service';
import { ResolvedHubConfig } from '../interfaces/hub-config.interface';

function makeConfig(overrides: Partial<ResolvedHubConfig> = {}): ResolvedHubConfig {
  return {
    actions: true,
    allowPublicAccessInProduction: false,
    collectors: { logs: false, queries: false, traces: false },
    db: false,
    emailPreview: true,
    env: 'local',
    links: {},
    loginEndpoint: '/iam/sign-in/email',
    logoutEndpoint: '/iam/sign-out',
    mailbox: { capacity: 3, maxMailSize: 100, mode: 'capture' },
    migrations: false,
    path: 'hub',
    pollIntervalMs: 5000,
    roles: ['admin'],
    version: '1.0.0',
    ...overrides,
  };
}

describe('CoreHubMailboxService', () => {
  it('captures a mail and returns true to skip transport in capture mode', () => {
    const service = new CoreHubMailboxService(makeConfig());
    const skip = service.capture({ html: '<b>hi</b>', subject: 'Hello', to: 'a@b.com' });

    expect(skip).toBe(true);
    const data = service.getMailbox();
    expect(data.mode).toBe('capture');
    expect(data.mails).toHaveLength(1);
    expect(data.mails[0].subject).toBe('Hello');
    expect(data.mails[0].to).toBe('a@b.com');
    expect(data.mails[0].hasHtml).toBe(true);
  });

  it('returns false in copy mode (mail is still sent)', () => {
    const service = new CoreHubMailboxService(makeConfig({ mailbox: { capacity: 3, maxMailSize: 100, mode: 'copy' } }));
    const skip = service.capture({ subject: 'Copy', to: 'a@b.com' });

    expect(skip).toBe(false);
    expect(service.getMailbox().mails).toHaveLength(1);
  });

  it('redacts tokens from the stored body in COPY mode (the real mail was still delivered)', () => {
    const service = new CoreHubMailboxService(
      makeConfig({ mailbox: { capacity: 3, maxMailSize: 5000, mode: 'copy' } }),
    );
    const seq = service.captureAndGetSeq({
      html: '<a href="https://app.example.com/reset?token=SUPERSECRETVALUE123">Reset</a>',
      subject: 'Reset',
      to: 'a@b.com',
    });
    const html = service.getMailHtml(seq);
    expect(html).toBeDefined();
    // The captured audit copy must not expose a replayable reset token.
    expect(html).not.toContain('SUPERSECRETVALUE123');
  });

  it('keeps the raw body in CAPTURE mode (dev/test needs the clickable link; nothing was sent)', () => {
    const service = new CoreHubMailboxService(makeConfig());
    const seq = service.captureAndGetSeq({
      html: '<a href="https://app.example.com/reset?token=SUPERSECRETVALUE123">Reset</a>',
      subject: 'Reset',
      to: 'a@b.com',
    });
    expect(service.getMailHtml(seq)).toContain('SUPERSECRETVALUE123');
  });

  it('evicts old mails beyond capacity (ring buffer)', () => {
    const service = new CoreHubMailboxService(makeConfig());
    for (const n of [1, 2, 3, 4, 5]) {
      service.capture({ subject: `Mail ${n}`, to: 'a@b.com' });
    }
    const data = service.getMailbox();
    expect(data.mails).toHaveLength(3);
    expect(data.mails.map((m) => m.subject)).toEqual(['Mail 3', 'Mail 4', 'Mail 5']);
  });

  it('truncates oversized bodies to the per-mail cap', () => {
    const service = new CoreHubMailboxService(makeConfig());
    const big = 'x'.repeat(500);
    const seq = service.captureAndGetSeq({ html: big, subject: 'Big', to: 'a@b.com' });
    const html = service.getMailHtml(seq);
    expect(html).toBeDefined();
    expect((html as string).length).toBeLessThanOrEqual(100 + 40); // cap + truncation marker
  });

  it('serves stored HTML by seq for the preview iframe', () => {
    const service = new CoreHubMailboxService(makeConfig());
    const seq = service.captureAndGetSeq({ html: '<p>Body</p>', subject: 'S', to: 'a@b.com' });
    expect(service.getMailHtml(seq)).toContain('<p>Body</p>');
    expect(service.getMailHtml(9999)).toBeUndefined();
  });

  it('clear() empties the mailbox', () => {
    const service = new CoreHubMailboxService(makeConfig());
    service.capture({ subject: 'S', to: 'a@b.com' });
    service.clear();
    expect(service.getMailbox().mails).toHaveLength(0);
  });

  it('supports cursor-based polling via since', () => {
    const service = new CoreHubMailboxService(makeConfig());
    service.capture({ subject: 'A', to: 'a@b.com' });
    const first = service.getMailbox();
    service.capture({ subject: 'B', to: 'a@b.com' });
    const next = service.getMailbox(first.cursor);
    expect(next.mails).toHaveLength(1);
    expect(next.mails[0].subject).toBe('B');
  });
});
