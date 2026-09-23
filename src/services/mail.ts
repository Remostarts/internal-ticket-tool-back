import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../logging/logger.js';

/**
 * Outbound mail (R014, and the delivery half of R015's recovery story).
 *
 * The reset flow needs exactly one thing from mail: a way to hand a message
 * over and be told whether it left. Two transports implement that - `smtp`
 * sends through the configured server, `outbox` writes the message to a file
 * so a developer (or the end-to-end suite) can read it without an SMTP account.
 *
 * Three rules hold this module together:
 *
 *   - **Nothing is sent from a call site.** `Mailer` is the whole surface, so
 *     M002's notifications can take the same interface later.
 *   - **An unconfigured mailer never silently succeeds.** A mailer that has no
 *     transport reports `transport: 'none'` and its `send` rejects with a
 *     message naming the variable that is missing (or the configuration that
 *     was refused). A caller that ignores the answer would otherwise believe a
 *     reset link was delivered.
 *   - **No secret reaches a log.** `maskEmail` is the only way an address is
 *     written down, and a reset URL or token is never logged at all - the call
 *     site owns the message body, this module only moves it.
 *
 * Importing this module performs no I/O: the SMTP transport is constructed on
 * the first `send`, so a process that never sends mail never opens a socket.
 *
 * `from` is deliberately not part of the JSON written to the outbox: the
 * envelope sender is configuration (`MAIL_FROM`), not message content.
 */

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SentMail {
  /** The provider's message id for SMTP, the outbox file name for the outbox. */
  id: string | null;
  transport: 'smtp' | 'outbox';
}

export interface Mailer {
  readonly transport: 'smtp' | 'outbox' | 'none';
  send(mail: OutboundMail): Promise<SentMail>;
}

export interface MailerOptions {
  /** Overrides `MAIL_TRANSPORT`. */
  transport?: 'smtp' | 'outbox';
  /** Overrides `MAIL_OUTBOX_DIR`. */
  outboxDir?: string;
  /** Overrides `SMTP_URL`. */
  smtpUrl?: string;
  /** Overrides `MAIL_FROM`. */
  from?: string;
  /** Injected clock for `sentAt`, so a test can write a deterministic file. */
  now?: () => Date;
}

/**
 * `NODE_ENV` read at call time rather than captured from `env`, so a test can
 * prove the production refusal without spawning a second process. In a real
 * process the two are the same value.
 */
function nodeEnv(): string {
  return process.env.NODE_ENV ?? env.NODE_ENV;
}

interface ResolvedTransport {
  kind: 'smtp' | 'outbox' | 'none';
  /** Why nothing can be sent; only set when `kind` is `none`. */
  reason: string | null;
}

function resolveTransport(options: MailerOptions): ResolvedTransport {
  const requested = options.transport ?? env.MAIL_TRANSPORT;

  // Outbox mode is a local-development affordance: it writes message content to
  // disk instead of delivering it, which must never be what a deployment does.
  // `.env.example` promises this refusal, so it is enforced here rather than
  // left as a sentence in the documentation.
  if (requested === 'outbox' && nodeEnv() === 'production') {
    return {
      kind: 'none',
      reason:
        'MAIL_TRANSPORT=outbox is refused in production; set SMTP_URL so reset links can be delivered',
    };
  }

  if (requested === 'smtp') {
    const smtpUrl = options.smtpUrl ?? env.SMTP_URL;
    if (!smtpUrl) {
      return { kind: 'none', reason: 'SMTP_URL is not set, so no mail can be sent' };
    }
    return { kind: 'smtp', reason: null };
  }

  const outboxDir = options.outboxDir ?? env.MAIL_OUTBOX_DIR;
  if (!outboxDir) {
    return {
      kind: 'none',
      reason: 'MAIL_OUTBOX_DIR is not set, so the outbox transport has nowhere to write',
    };
  }
  return { kind: 'outbox', reason: null };
}

/** True when `candidate` is inside `directory` (and not the directory itself). */
function isInsideDirectory(directory: string, candidate: string): boolean {
  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return candidate.startsWith(prefix);
}

/** One message id per message; also the outbox file name. */
function outboxFileName(sentAt: Date): string {
  return `${sentAt.getTime()}-${randomBytes(6).toString('hex')}.json`;
}

function messageIdFrom(info: unknown): string | null {
  const candidate = (info as { messageId?: unknown } | null)?.messageId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * Builds the mailer the API uses.
 *
 * Nothing here touches the network or the filesystem until `send` is called -
 * construction only decides which transport is configured, so a misconfigured
 * deployment is refused at the point a message is attempted (and turns into a
 * plain refusal at the route) rather than at import time.
 */
export function createMailer(options: MailerOptions = {}): Mailer {
  const resolved = resolveTransport(options);
  const from = options.from ?? env.MAIL_FROM;
  const now = options.now ?? (() => new Date());

  if (resolved.kind === 'none') {
    const reason = resolved.reason ?? 'mail is not configured';
    return {
      transport: 'none',
      send: async () => {
        throw new Error(`Mail is not configured: ${reason}.`);
      },
    };
  }

  if (resolved.kind === 'outbox') {
    const directory = resolve(options.outboxDir ?? env.MAIL_OUTBOX_DIR ?? '');
    return {
      transport: 'outbox',
      async send(mail: OutboundMail): Promise<SentMail> {
        const sentAt = now();
        const fileName = outboxFileName(sentAt);
        const filePath = resolve(directory, fileName);

        // The file name is generated above, so this cannot fail today; it is
        // here so that a future call site which lets a message influence the
        // path is stopped rather than trusted.
        if (!isInsideDirectory(directory, filePath)) {
          throw new Error('Refusing to write a mail file outside MAIL_OUTBOX_DIR.');
        }

        await mkdir(directory, { recursive: true });
        await writeFile(
          filePath,
          `${JSON.stringify(
            {
              to: mail.to,
              subject: mail.subject,
              text: mail.text,
              html: mail.html ?? null,
              sentAt: sentAt.toISOString(),
            },
            null,
            2,
          )}\n`,
          'utf8',
        );

        logger.debug(
          { transport: 'outbox', to: maskEmail(mail.to), id: fileName },
          'mail written to the outbox',
        );
        return { id: fileName, transport: 'outbox' };
      },
    };
  }

  // `smtp`: one transport for the life of the mailer, built on first use so
  // importing this module never connects and a process that sends no mail
  // opens no socket.
  let transporter: Transporter | null = null;
  const connectionUrl = options.smtpUrl ?? env.SMTP_URL ?? '';
  const getTransporter = (): Transporter => {
    transporter ??= createTransport(connectionUrl);
    return transporter;
  };

  return {
    transport: 'smtp',
    async send(mail: OutboundMail): Promise<SentMail> {
      const info: unknown = await getTransporter().sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
      });
      const id = messageIdFrom(info);
      logger.debug({ transport: 'smtp', to: maskEmail(mail.to), id }, 'mail handed to SMTP');
      return { id, transport: 'smtp' };
    },
  };
}

export interface PasswordResetEmail {
  fullName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The password-reset message.
 *
 * Plain language, the link on a line of its own, and the expiry stated in
 * minutes. No emoji, no tracking pixel, no click-through button: the visible
 * text of the link *is* the URL, so a reader can see (and copy) where it goes
 * even when the mail client refuses to open it - an HTML mail that hides its
 * destination behind "Reset your password" is exactly what this avoids.
 */
export function renderPasswordResetEmail(input: PasswordResetEmail): RenderedEmail {
  const minutes = Math.max(1, Math.trunc(input.expiresInMinutes));
  const minutesText = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const text = [
    `Hello ${input.fullName},`,
    '',
    'Somebody asked to reset the password for your Claim Desk account. If that was you, open this link to choose a new password:',
    '',
    input.resetUrl,
    '',
    `The link stops working in ${minutesText}, and it can only be used once.`,
    '',
    'If you did not ask for this, you can ignore this message. Your password has not changed.',
    '',
    'Claim Desk',
  ].join('\n');

  const html = [
    '<p>Hello ' + escapeHtml(input.fullName) + ',</p>',
    '<p>Somebody asked to reset the password for your Claim Desk account. If that was you, open this link to choose a new password:</p>',
    `<p><a href="${escapeHtml(input.resetUrl)}">${escapeHtml(input.resetUrl)}</a></p>`,
    `<p>The link stops working in ${minutesText}, and it can only be used once.</p>`,
    '<p>If you did not ask for this, you can ignore this message. Your password has not changed.</p>',
    '<p>Claim Desk</p>',
  ].join('\n');

  return {
    subject: 'Reset your Claim Desk password',
    text,
    html,
  };
}

/** The link a person clicks, with the token encoded as an opaque URL parameter. */
export function buildPasswordResetUrl(rawToken: string, webOrigin?: string): string {
  const origin = (webOrigin ?? env.WEB_ORIGIN).replace(/\/+$/, '');
  return `${origin}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/**
 * An address safe to write into a log line: the first character of the local
 * part, a fixed-width mask, and the domain. Never the whole address, and the
 * mask does not leak the length of the local part either.
 */
export function maskEmail(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) {
    return '•••';
  }
  const domain = address
    .slice(at + 1)
    .replace(/[\s\u0000-\u001f\u007f]/g, '')
    .trim();
  if (domain.length === 0) {
    return '•••';
  }
  const first = address.slice(0, 1).replace(/[\s\u0000-\u001f\u007f]/g, '');
  return `${first || '•'}•••@${domain}`;
}
