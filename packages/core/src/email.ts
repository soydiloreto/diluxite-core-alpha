/**
 * Email provider — pluggable transport for transactional emails.
 *
 * Today this is the backbone for forgot-password reset; in roadmap it also
 * powers SSO invites, audit log alerting webhooks (transport agnostic) and
 * any operational notification.
 *
 * Two providers ship in Core:
 *   - `NoopEmailProvider` — logs the rendered message + returns success. Used
 *     in tests, in dev (no SMTP config), and as a fail-safe so the app boots
 *     even when the operator hasn't configured email yet.
 *   - `SmtpEmailProvider` — thin adapter over `nodemailer`. Used when the
 *     installer or operator sets `DILUXITE_SMTP_HOST` + friends.
 *
 * Cloud edition can ship its own (e.g. Azure Communication Services or
 * SendGrid) by implementing the same interface and registering it in
 * `services.ts`'s `pickEmailProvider()`.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body (always required — used as fallback when html is missing). */
  text: string;
  /** Optional HTML body (most modern clients prefer it). */
  html?: string;
  /** Optional override of the default `from` configured at provider level. */
  from?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * NoopEmailProvider — never throws, never sends. Logs the rendered message to
 * stdout so devs can copy the reset link from terminal output without setting
 * up SMTP. Default when no provider is configured.
 */
export class NoopEmailProvider implements EmailProvider {
  readonly name = 'noop';
  // Logger is injected so tests can capture without polluting stdout.
  constructor(private readonly logger: (msg: string) => void = console.log) {}

  async send(message: EmailMessage): Promise<void> {
    this.logger(
      `[email:noop] to=${message.to} subject=${JSON.stringify(message.subject)} text=${JSON.stringify(message.text.slice(0, 200))}`,
    );
  }
}

/**
 * Minimal shape of a `nodemailer` transport that we depend on. Keeping this
 * narrow lets us unit-test the adapter without pulling nodemailer into
 * @diluxite/core's dep graph (it lives in apps/api).
 */
export interface NodemailerLikeTransport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

export interface SmtpEmailProviderOptions {
  /** Transport built by the caller (so the caller controls dep version + pool config). */
  transport: NodemailerLikeTransport;
  /** Default `From:` address (override per-message via `EmailMessage.from`). */
  defaultFrom: string;
}

/**
 * SmtpEmailProvider — wraps a nodemailer-like transport. The transport itself
 * is built outside Core (in apps/api) so we keep this package free of the
 * nodemailer dep.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  constructor(private readonly opts: SmtpEmailProviderOptions) {}

  async send(message: EmailMessage): Promise<void> {
    await this.opts.transport.sendMail({
      from: message.from ?? this.opts.defaultFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
