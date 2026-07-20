import { Inject, Injectable } from '@nestjs/common';

import { redactSensitiveText } from '../../../common/helpers/logging.helper';
import { HUB_CONFIG } from '../hub.constants';
import { HubRingBuffer } from '../hub-ring-buffer';
import { HubMailboxData, HubMailboxEntry } from '../interfaces/hub-panels.interface';
import { IHubCapturedMailInput, IHubEmailCapture, ResolvedHubConfig } from '../interfaces/hub-config.interface';

/** A captured mail: the list metadata plus the (truncated) bodies kept for the preview iframe. */
interface StoredMail extends HubMailboxEntry {
  html?: string;
  text?: string;
}

const TRUNCATION_MARKER = '… [truncated]';

/**
 * The built-in mailbox — a Mailpit-style capture of outgoing mail for local/test use.
 *
 * Implements {@link IHubEmailCapture}: `EmailService` calls `capture()` before the transport. In
 * `mode: 'capture'` the mail is recorded and NOT sent (`capture()` returns true); in `mode: 'copy'`
 * it is recorded and still sent (returns false). Bodies are capped per mail and the buffer is a fixed
 * ring, so memory stays bounded.
 */
@Injectable()
export class CoreHubMailboxService implements IHubEmailCapture {
  protected readonly buffer: HubRingBuffer<StoredMail>;
  protected readonly mode: 'capture' | 'copy';

  constructor(@Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig) {
    const mailbox =
      config.mailbox === false ? { capacity: 100, maxMailSize: 262144, mode: 'capture' as const } : config.mailbox;
    this.mode = mailbox.mode;
    this.buffer = new HubRingBuffer<StoredMail>(mailbox.capacity);
  }

  /** Record a mail. Returns true when the caller should SKIP the transport (capture mode). */
  capture(mail: IHubCapturedMailInput): boolean {
    this.store(mail);
    return this.mode === 'capture';
  }

  /** Convenience for tests/actions: capture and return the assigned seq. */
  captureAndGetSeq(mail: IHubCapturedMailInput): number {
    return this.store(mail).seq;
  }

  /** Drop all captured mails. */
  clear(): void {
    this.buffer.clear();
  }

  /** Stored HTML (or text fallback) for a mail, for the sandboxed preview iframe. */
  getMailHtml(seq: number): string | undefined {
    const mail = this.buffer.recent().find((m) => m.seq === seq);
    if (!mail) {
      return undefined;
    }
    return mail.html ?? (mail.text ? `<pre>${escapeForPre(mail.text)}</pre>` : undefined);
  }

  /** Mailbox listing (metadata only), oldest→newest, optionally since a cursor. */
  getMailbox(since?: number): HubMailboxData {
    const entries = since === undefined ? this.buffer.recent() : this.buffer.since(since);
    return {
      cursor: this.buffer.lastSeq,
      dropped: this.buffer.firstRetainedSeq,
      mails: entries.map(toEntry),
      mode: this.mode,
    };
  }

  protected store(mail: IHubCapturedMailInput): StoredMail {
    const cap = this.config.mailbox === false ? 262144 : this.config.mailbox.maxMailSize;
    // 'copy' mode: the real mail is delivered to the recipient and the stored copy is only an
    // admin-facing audit view — best-effort redact tokens/links (JWTs, Bearer, `?token=`/`password=`
    // query values) so a captured reset/verification link can't be replayed from the mailbox by an
    // admin. 'capture' mode (dev/test only, never sent, blocked in prod/staging) keeps the raw body so
    // the link stays clickable.
    const redact = (value?: string): string | undefined =>
      this.mode === 'copy' && value ? redactSensitiveText(value) : value;
    return this.buffer.add({
      bcc: mail.bcc,
      cc: mail.cc,
      from: mail.from,
      hasHtml: !!mail.html,
      hasText: !!mail.text,
      html: truncate(redact(mail.html), cap),
      subject: mail.subject,
      templateName: mail.templateName,
      text: truncate(redact(mail.text), cap),
      to: mail.to,
    } as Omit<StoredMail, 'seq' | 'timestamp'>);
  }
}

function escapeForPre(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toEntry(mail: StoredMail): HubMailboxEntry {
  return {
    bcc: mail.bcc,
    cc: mail.cc,
    from: mail.from,
    hasHtml: mail.hasHtml,
    hasText: mail.hasText,
    seq: mail.seq,
    subject: mail.subject,
    templateName: mail.templateName,
    timestamp: mail.timestamp,
    to: mail.to,
  };
}

function truncate(value: string | undefined, cap: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length > cap ? value.slice(0, cap) + TRUNCATION_MARKER : value;
}
