import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/logging/logger.js';
import {
  buildPasswordResetUrl,
  createMailer,
  maskEmail,
  renderPasswordResetEmail,
  type OutboundMail,
} from '../src/services/mail.js';

/**
 * Outbound mail: the outbox transport, the reset message, and the refusals.
 *
 * Every case here runs without a network and without a database. The outbox
 * transport is proved against a real temporary directory (exactly one file per
 * message, inside the configured directory, containing the link), and the
 * failure paths are proved by construction: an unconfigured mailer must reject
 * with a message naming the variable that is missing rather than resolving and
 * letting a caller believe a reset link was delivered.
 */

let root = '';

const SENT_AT = new Date('2026-01-02T03:04:05.678Z');

function tempDir(name: string): string {
  return join(root, name);
}

function resetMail(url = 'https://desk.example.com/reset-password?token=abc'): OutboundMail {
  return {
    to: 'jane.doe@example.com',
    subject: 'Reset your Claim Desk password',
    text: `Hello Jane,\n\n${url}\n\nClaim Desk`,
  };
}

async function outboxFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'claimdesk-mail-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the outbox transport', () => {
  it('writes exactly one file per message, inside the configured directory', async () => {
    const directory = tempDir('one-message');
    const mailer = createMailer({
      transport: 'outbox',
      outboxDir: directory,
      now: () => SENT_AT,
    });
    expect(mailer.transport).toBe('outbox');

    const sent = await mailer.send(resetMail('https://desk.example.com/reset-password?token=t0k3n'));

    const files = await outboxFiles(directory);
    expect(files).toHaveLength(1);
    expect(sent.transport).toBe('outbox');
    expect(sent.id).toBe(files[0]);

    const written = JSON.parse(await readFile(join(directory, files[0] ?? ''), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written.to).toBe('jane.doe@example.com');
    expect(written.subject).toBe('Reset your Claim Desk password');
    expect(String(written.text)).toContain('https://desk.example.com/reset-password?token=t0k3n');
    expect(written.sentAt).toBe(SENT_AT.toISOString());
    // The envelope sender is configuration, not message content.
    expect(written).not.toHaveProperty('from');
  });

  it('creates the directory when it does not exist yet', async () => {
    const directory = tempDir(join('nested', 'outbox'));
    const mailer = createMailer({ transport: 'outbox', outboxDir: directory, now: () => SENT_AT });

    await mailer.send(resetMail());

    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(await outboxFiles(directory)).toHaveLength(1);
  });

  it('keeps a hostile recipient out of the file path', async () => {
    const directory = tempDir('traversal');
    const mailer = createMailer({ transport: 'outbox', outboxDir: directory, now: () => SENT_AT });

    await mailer.send({ ...resetMail(), to: '../../../evil@example.com' });

    const files = await outboxFiles(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-[0-9a-f]{12}\.json$/);
    // Nothing appeared next to the configured directory either.
    expect((await readdir(root)).filter((name) => name.includes('evil'))).toEqual([]);
  });

  it('rejects when the configured directory cannot be created', async () => {
    const asFile = tempDir('not-a-directory');
    await writeFile(asFile, 'this path is a file, not a directory\n', 'utf8');
    const mailer = createMailer({ transport: 'outbox', outboxDir: asFile, now: () => SENT_AT });

    await expect(mailer.send(resetMail())).rejects.toThrow();
  });

  it('never logs the full address or the reset link', async () => {
    const directory = tempDir('log-safety');
    const mailer = createMailer({ transport: 'outbox', outboxDir: directory, now: () => SENT_AT });
    const url = 'https://desk.example.com/reset-password?token=super-secret-token';
    const debug = vi.spyOn(logger, 'debug');

    await mailer.send(resetMail(url));

    const logged = debug.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(logged).not.toContain('jane.doe@example.com');
    expect(logged).not.toContain('jane.doe');
    expect(logged).not.toContain('super-secret-token');
    expect(logged).toContain('example.com');
  });
});

describe('the reset message', () => {
  it('states the expiry in minutes and carries the link on its own line', () => {
    const url = 'https://desk.example.com/reset-password?token=t0k3n';
    const rendered = renderPasswordResetEmail({
      fullName: 'Jane Doe',
      resetUrl: url,
      expiresInMinutes: 60,
    });

    expect(rendered.text.split('\n')).toContain(url);
    expect(rendered.text).toContain('60 minutes');
    expect(rendered.text).toContain('Jane Doe');
    expect(rendered.html).toContain(url);
    expect(rendered.subject.length).toBeGreaterThan(0);
  });

  it('says one minute rather than one minutes', () => {
    const rendered = renderPasswordResetEmail({
      fullName: 'Jane Doe',
      resetUrl: 'https://desk.example.com/reset-password?token=t0k3n',
      expiresInMinutes: 1,
    });

    expect(rendered.text).toContain('1 minute,');
    expect(rendered.text).not.toContain('1 minutes');
  });

  it('shows the URL as the visible link text, with no pixel and no emoji', () => {
    const url = 'https://desk.example.com/reset-password?token=t0k3n';
    const rendered = renderPasswordResetEmail({
      fullName: 'Jane Doe',
      resetUrl: url,
      expiresInMinutes: 15,
    });

    expect(rendered.html).toContain(`>${url}</a>`);
    expect(rendered.html).not.toMatch(/<img/i);
    expect(`${rendered.subject}\n${rendered.text}\n${rendered.html}`).not.toMatch(
      /\p{Extended_Pictographic}/u,
    );
  });

  it('escapes a display name that contains markup', () => {
    const rendered = renderPasswordResetEmail({
      fullName: '<script>alert(1)</script>',
      resetUrl: 'https://desk.example.com/reset-password?token=t0k3n',
      expiresInMinutes: 15,
    });

    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

describe('the reset link', () => {
  it('is absolute against WEB_ORIGIN by default', () => {
    const url = buildPasswordResetUrl('t0k3n');

    expect(url).toBe('http://localhost:3000/reset-password?token=t0k3n');
  });

  it('uses a given origin, without doubling the slash', () => {
    const url = buildPasswordResetUrl('t0k3n', 'https://desk.example.com/');

    expect(url).toBe('https://desk.example.com/reset-password?token=t0k3n');
  });

  it('URL-encodes the token so a reserved character cannot change the query', () => {
    const token = 'a+b/c==d?e&f#g';
    const url = buildPasswordResetUrl(token, 'https://desk.example.com');

    expect(url).toBe(
      `https://desk.example.com/reset-password?token=${encodeURIComponent(token)}`,
    );
    expect(url).not.toContain('token=a+b');
  });
});

describe('masking an address for a log line', () => {
  it('hides the local part and keeps the domain', () => {
    const masked = maskEmail('jane.doe@example.com');

    expect(masked).not.toContain('jane.doe');
    expect(masked).not.toContain('jane');
    expect(masked.endsWith('@example.com')).toBe(true);
    expect(masked.length).toBeLessThan('jane.doe@example.com'.length);
  });

  it('never returns the whole address, however short it is', () => {
    expect(maskEmail('a@b.com')).not.toBe('a@b.com');
    expect(maskEmail('a@b.com')).toContain('@b.com');
  });

  it('does not leak the length of the local part', () => {
    expect(maskEmail('averyveryverylonglocalpart@example.com')).toBe(maskEmail('a@example.com'));
  });

  it('returns a mask rather than the input when there is nothing to mask', () => {
    for (const input of ['', 'not-an-address', 'a@', '@example.com', '   @   ']) {
      const masked = maskEmail(input);
      expect(masked).not.toBe(input);
      expect(() => maskEmail(input)).not.toThrow();
    }
  });
});

describe('a mailer that is not configured', () => {
  it('reports transport none and rejects naming SMTP_URL, rather than resolving', async () => {
    const mailer = createMailer({ transport: 'smtp', smtpUrl: '' });

    expect(mailer.transport).toBe('none');
    await expect(mailer.send(resetMail())).rejects.toThrow(/SMTP_URL/);
  });

  it('is what the default configuration produces when SMTP_URL is unset', async () => {
    const mailer = createMailer();

    expect(mailer.transport).toBe('none');
    await expect(mailer.send(resetMail())).rejects.toThrow(/Mail is not configured/);
  });

  it('rejects naming MAIL_OUTBOX_DIR when outbox mode has no directory', async () => {
    const mailer = createMailer({ transport: 'outbox', outboxDir: '' });

    expect(mailer.transport).toBe('none');
    await expect(mailer.send(resetMail())).rejects.toThrow(/MAIL_OUTBOX_DIR/);
  });

  it('refuses outbox mode in production instead of writing a file', async () => {
    const directory = tempDir('production-outbox');
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const mailer = createMailer({ transport: 'outbox', outboxDir: directory });

      expect(mailer.transport).toBe('none');
      await expect(mailer.send(resetMail())).rejects.toThrow(/production/);
      await expect(mailer.send(resetMail())).rejects.toThrow(/SMTP_URL/);
      // Nothing was written, not even the outbox directory.
      await expect(stat(directory)).rejects.toThrow(/ENOENT/);
    } finally {
      if (saved === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = saved;
      }
    }
  });
});

describe('the SMTP transport', () => {
  it('reports smtp and rejects when the server cannot be reached', async () => {
    // Port 1 on the loopback interface has no listener: the connection is
    // refused locally, which is the connection-failure path a deployment hits
    // when the mail server is down or unreachable.
    const mailer = createMailer({ transport: 'smtp', smtpUrl: 'smtp://127.0.0.1:1' });
    expect(mailer.transport).toBe('smtp');

    await expect(mailer.send(resetMail())).rejects.toThrow();
  }, 20_000);
});
