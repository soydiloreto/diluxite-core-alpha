import { describe, it, expect, vi } from 'vitest';
import {
  NoopEmailProvider,
  SmtpEmailProvider,
  type NodemailerLikeTransport,
} from './email';

describe('NoopEmailProvider', () => {
  it('logs the message + does not throw', async () => {
    const logs: string[] = [];
    const p = new NoopEmailProvider((m) => logs.push(m));

    await expect(
      p.send({ to: 'a@x.com', subject: 'hi', text: 'hello world' }),
    ).resolves.toBeUndefined();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('to=a@x.com');
    expect(logs[0]).toContain('subject="hi"');
    expect(logs[0]).toContain('hello world');
  });

  it('truncates long text in the log to keep stdout readable', async () => {
    const logs: string[] = [];
    const p = new NoopEmailProvider((m) => logs.push(m));
    const longText = 'x'.repeat(500);

    await p.send({ to: 'a@x.com', subject: 's', text: longText });

    // Substring of original text up to 200 chars, no more.
    expect(logs[0].length).toBeLessThan(400);
    expect(logs[0]).toContain('xxx');
  });

  it('exposes a stable `name` for diagnostics in /api/info', () => {
    expect(new NoopEmailProvider().name).toBe('noop');
  });
});

describe('SmtpEmailProvider', () => {
  function makeTransport(): NodemailerLikeTransport & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async sendMail(options) {
        calls.push(options);
        return { messageId: 'test' };
      },
    };
  }

  it('passes message fields to the transport with the configured default from', async () => {
    const transport = makeTransport();
    const p = new SmtpEmailProvider({
      transport,
      defaultFrom: 'noreply@diluxite.test',
    });

    await p.send({
      to: 'user@x.com',
      subject: 'Reset your password',
      text: 'Click here: https://...',
      html: '<a href="https://...">Click here</a>',
    });

    expect(transport.calls).toEqual([
      {
        from: 'noreply@diluxite.test',
        to: 'user@x.com',
        subject: 'Reset your password',
        text: 'Click here: https://...',
        html: '<a href="https://...">Click here</a>',
      },
    ]);
  });

  it('lets the caller override the from address per-message', async () => {
    const transport = makeTransport();
    const p = new SmtpEmailProvider({
      transport,
      defaultFrom: 'noreply@diluxite.test',
    });

    await p.send({
      to: 'user@x.com',
      subject: 'Test',
      text: 'body',
      from: 'admin@diluxite.test',
    });

    expect((transport.calls[0] as { from: string }).from).toBe(
      'admin@diluxite.test',
    );
  });

  it('propagates transport errors so callers can surface or retry', async () => {
    const transport: NodemailerLikeTransport = {
      async sendMail() {
        throw new Error('SMTP 550 user unknown');
      },
    };
    const p = new SmtpEmailProvider({
      transport,
      defaultFrom: 'noreply@diluxite.test',
    });

    await expect(
      p.send({ to: 'bad@x.com', subject: 's', text: 't' }),
    ).rejects.toThrow(/SMTP 550/);
  });

  it('exposes a stable `name` for diagnostics in /api/info', () => {
    const fake: NodemailerLikeTransport = { sendMail: vi.fn() };
    expect(
      new SmtpEmailProvider({ transport: fake, defaultFrom: 'x@y' }).name,
    ).toBe('smtp');
  });
});
