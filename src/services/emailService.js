// src/services/emailService.js
//
// Mail delivery for the Hualink Distribution backend.
//
// The SMTP transport is configured exclusively from the environment so the same
// build runs locally and in production without code changes:
//
//   SMTP_HOST    smtp.gmail.com        - the SMTP server to talk to
//   SMTP_PORT    465 | 587             - 465 = implicit TLS, 587 = STARTTLS
//   SMTP_SECURE  true | false          - true when the port is implicit TLS
//   SMTP_USER    mailbox@gmail.com     - the authenticated mailbox
//   SMTP_PASS    xxxx xxxx xxxx xxxx   - the Gmail App Password for that box
//   SMTP_FROM    optional              - display name / alias override
//
// Two rules drive the design of this module:
//
//   1. Gmail only relays mail whose From address belongs to the authenticated
//      account, so the sender defaults to SMTP_USER.
//   2. A mail server that is down, throttling, or dropping packets must never
//      take the Express server with it. Every send therefore resolves to a
//      result object instead of throwing, and the transport carries a
//      top-level `error` listener so a socket level glitch is logged rather
//      than raised as an unhandled 'error' event (which would kill Node).

import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

// The transport is built lazily, but the environment has to be readable when
// that happens — so the .env file is loaded here as well. (ESM evaluates
// imported modules before the importing module's body runs, which means the
// `dotenv.config()` call in server.js has not executed yet while this module
// is being evaluated.)
dotenv.config();

/** Parses a boolean-ish environment value. */
const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
};

/**
 * Reads the live SMTP configuration from the environment.
 *
 * Exposed separately from the transport so tests (and the CLI diagnostics
 * script) can assert exactly which variables the mailer is using.
 */
export const smtpConfig = () => {
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER || '';

  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    // Port 465 negotiates TLS implicitly; 587 upgrades with STARTTLS.
    secure: toBool(process.env.SMTP_SECURE, port === 465),
    auth: {
      user,
      pass: process.env.SMTP_PASS || '',
    },
    // The sender has to be the authenticated mailbox, otherwise Gmail rejects
    // the message with "550-5.7.26 Sender address not authenticated".
    from: process.env.SMTP_FROM || (user ? `"Hualink Distribution" <${user}>` : undefined),
  };
};

/**
 * Builds a nodemailer transport from the SMTP environment variables.
 *
 * Timeouts are deliberately short: a request must not hang for minutes
 * waiting on an unreachable mail server.
 */
export const createSmtpTransporter = (config = {}) => {
  const resolved = { ...smtpConfig(), ...config };

  return nodemailer.createTransport({
    host: resolved.host,
    port: resolved.port,
    secure: resolved.secure,
    auth: resolved.auth,
    // Reuse a single authenticated connection instead of re-handshaking for
    // every OTP the platform sends.
    pool: true,
    maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS) || 3,
    maxMessages: Number(process.env.SMTP_MAX_MESSAGES) || 100,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT) || 10000,
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT) || 10000,
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT) || 20000,
    tls: {
      // Self-signed certificates are only tolerated outside production.
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  });
};

/**
 * The shared transport used by every helper in this module.
 *
 * It is created on first use rather than at import time: ES module imports are
 * evaluated before the body of the importing module, so a transport built
 * during import would capture an environment that `dotenv.config()` has not
 * populated yet — Gmail would then be handed empty credentials and reject
 * every message with "530 Authentication Required".
 */
let transporterInstance = null;

export const getTransporter = () => {
  if (!transporterInstance) {
    transporterInstance = createSmtpTransporter();

    // A pooled transport reports connection level problems through an
    // `error` event. Without a listener Node treats that as an unhandled
    // 'error' event and terminates the process — exactly the crash this
    // module has to prevent.
    transporterInstance.on('error', (error) => {
      logger.warn(
        `📧 SMTP transport error (non-fatal): ${error?.message || String(error)}`
      );
    });
  }

  return transporterInstance;
};

/**
 * Error codes that describe a transient network condition rather than a
 * rejected message. Those are worth one more attempt.
 */
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EDNS',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
]);

/** True when the failure looks like a network glitch worth retrying. */
export const isTransientMailError = (error) => {
  if (!error) return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  return /timeout|timed out|socket hang up|ECONNRESET|network/i.test(
    error.message || ''
  );
};

/** True when Gmail rejected the credentials. */
export const isAuthError = (error) => {
  if (!error) return false;
  if (error.responseCode === 535 || error.code === 'EAUTH') return true;
  return /535|bad credentials|invalid login|authentication failed|unauthorized/i.test(
    error.message || ''
  );
};

/** Sleeps for the given number of milliseconds. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one message.
 *
 * The function never throws and never rejects: a delivery problem is reported
 * through the returned result so the calling controller can keep serving
 * requests (and the OTP stays usable through the other delivery channels).
 *
 * @param {object} mailOptions nodemailer message options
 * @param {object} [options]
 * @param {object} [options.transport] transport override (used by the tests)
 * @param {number} [options.attempts]   how many delivery attempts to make
 * @param {string} [options.label]      label used in the log lines
 * @returns {Promise<{delivered: boolean, messageId: string|null, error: string|null, attempts: number}>}
 */
export const dispatchMail = async (mailOptions, options = {}) => {
  const transport = options.transport || getTransporter();
  const maxAttempts = Math.max(1, Number(options.attempts) || 2);
  const label = options.label || 'email';

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const info = await transport.sendMail(mailOptions);
      logger.info(
        `📧 ${label} dispatched to ${mailOptions.to} (message id ${info?.messageId || 'n/a'})`
      );
      return {
        delivered: true,
        messageId: info?.messageId || null,
        error: null,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;

      const message = error?.message || String(error);
      const retryable = isTransientMailError(error) && attempt < maxAttempts;

      if (retryable) {
        logger.warn(
          `📧 ${label} to ${mailOptions.to} hit a network glitch (${message}). Retrying in 1s...`
        );
        await delay(1000);
        continue;
      }

      break;
    }
  }

  const message = lastError?.message || String(lastError);
  logger.warn(
    `📧 ${label} to ${mailOptions.to} could not be delivered: ${message}`
  );

  return {
    delivered: false,
    messageId: null,
    error: message,
    attempts: maxAttempts,
  };
};

/**
 * Verifies that the SMTP credentials are usable.
 *
 * @returns {Promise<{connected: boolean, error: string|null}>}
 */
export const verifySmtpConnection = async () => {
  try {
    await getTransporter().verify();
    logger.info(
      `📧 SMTP connection verified (${smtpConfig().host}:${smtpConfig().port})`
    );
    return { connected: true, error: null };
  } catch (error) {
    const message = error?.message || String(error);
    logger.warn(`📧 SMTP connection could not be verified: ${message}`);
    return { connected: false, error: message };
  }
};

/** Closes the connection pool (used by scripts and graceful shutdown). */
export const closeSmtpPool = () => {
  try {
    if (transporterInstance) {
      transporterInstance.close();
      transporterInstance = null;
    }
  } catch {
    // Nothing to close — the pool was never opened.
  }
};

/* ------------------------------------------------------------------ */
/* Templates                                                          */
/* ------------------------------------------------------------------ */

/**
 * Wraps the shared visual shell every Hualink email uses.
 */
const emailShell = ({
  heading,
  intro,
  code,
  codeLabel = 'Your verification code',
  codeLength = 6,
  footnote = 'If you did not request this email, you can safely ignore it.',
  accent = '#ef4444',
} = {}) => `
  <div style="font-family: Arial, Helvetica, sans-serif; padding: 20px; background-color: #f8fafc;">
    <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0;">
      <div style="font-size: 18px; font-weight: bold; color: #0f172a; letter-spacing: 0.5px;">HUALINK <span style="color: #64748b; font-weight: normal;">DISTRIBUTION</span></div>
      <h2 style="color: #0f172a; margin-top: 24px;">${heading}</h2>
      <p style="color: #475569; font-size: 14px; line-height: 1.5;">${intro}</p>
      <div style="text-align: center; margin: 24px 0;">
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; margin-bottom: 8px;">${codeLabel}</div>
        <span style="font-size: 32px; font-weight: bold; color: ${accent}; letter-spacing: 6px; background: #fef2f2; padding: 12px 24px; border-radius: 8px; border: 1px solid #fecaca; display: inline-block;">${code}</span>
        <div style="font-size: 12px; color: #94a3b8; margin-top: 8px;">${codeLength} digits</div>
      </div>
      <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">${footnote}</p>
    </div>
  </div>
`;

/**
 * Sends the password reset passcode.
 *
 * Used by POST /api/auth/forgot-password and the legacy /api/auth/request-otp
 * — the endpoint the "Resend passcode" button calls. Every call mails a fresh,
 * randomly generated 6-digit passcode to the account owner.
 *
 * @param {string} email    recipient address
 * @param {string} passcode the code the customer has to type
 * @returns {Promise<{delivered: boolean, messageId: string|null, error: string|null}>}
 */
export const sendPasswordResetEmail = async (email, passcode) => {
  const code = String(passcode || '').trim();

  // The reset email only ever carries a real 6-digit passcode. Anything else
  // is a programming error and is reported instead of being mailed out.
  if (!/^\d{6}$/.test(code)) {
    const error = 'The password reset passcode must be a 6-digit number.';
    logger.error(`❌ Password reset passcode for ${email} rejected: ${error}`);
    return { delivered: false, messageId: null, error, attempts: 0 };
  }

  const mailOptions = {
    from: smtpConfig().from,
    to: email,
    subject: 'Hualink Password Reset Passcode',
    text: `Your Hualink password reset passcode is ${code}. It expires in 10 minutes. If you did not request a password reset, ignore this email.`,
    html: emailShell({
      heading: 'Password Reset Request',
      intro:
        'Use the following 6-digit passcode to reset your Hualink password. It expires in 10 minutes:',
      code,
      codeLabel: 'Password reset passcode',
      codeLength: 6,
    }),
  };

  const result = await dispatchMail(mailOptions, {
    label: 'Password reset passcode',
  });

  if (!result.delivered && isAuthError({ message: result.error })) {
    logger.warn(
      `⚠️  SMTP authentication failed (535 Bad Credentials) for ${email}. ` +
        `DEV PASSCODE: ${code}. Configure SMTP_USER/SMTP_PASS (Gmail App Password) in .env to send real emails.`
    );
  }

  return result;
};

/**
 * Backwards-compatible alias for `sendPasswordResetEmail`.
 *
 * @deprecated Use `sendPasswordResetEmail` instead.
 */
export const sendResetEmail = sendPasswordResetEmail;

/**
 * Sends a verification code (sign-up OTP or order confirmation PIN).
 *
 * @param {string} email   recipient address
 * @param {string} code    the code the customer has to type
 * @param {string} purpose SIGNUP | ORDER
 * @param {object} [details]
 * @param {number} [details.amount]  order value (TSh) for the ORDER flow
 * @param {string} [details.orderId] order reference for the ORDER flow
 * @returns {Promise<{delivered: boolean, messageId: string|null, error: string|null}>}
 */
export const sendVerificationEmail = async (
  email,
  code,
  purpose = 'SIGNUP',
  details = {}
) => {
  const isOrder = purpose === 'ORDER';
  const { amount, orderId } = details;

  const amountLabel =
    amount === undefined || amount === null || amount === ''
      ? ''
      : ` for a purchase worth TSh ${Number(amount).toLocaleString()}`;

  const heading = isOrder
    ? 'Confirm Your Purchase Request'
    : 'Verify Your Hualink Account';
  const intro = isOrder
    ? `Use the following ${code.length}-digit PIN to confirm your wholesale purchase request${amountLabel}. It expires in 5 minutes:`
    : 'Use the following 6-digit verification code to confirm your email address and activate your Hualink account. It expires in 10 minutes:';

  const mailOptions = {
    from: smtpConfig().from,
    to: email,
    subject: isOrder
      ? 'Your Hualink Order Confirmation PIN'
      : 'Your Hualink Verification Code',
    text: isOrder
      ? `Your Hualink order confirmation PIN is ${code}${amountLabel}. It expires in 5 minutes.`
      : `Your Hualink verification code is ${code}. It expires in 10 minutes.`,
    html: emailShell({
      heading,
      intro,
      code,
      codeLabel: isOrder ? 'Order confirmation PIN' : 'Account verification code',
      codeLength: code.length,
      footnote: isOrder
        ? `Hualink will never ask you to forward this PIN to anyone. Order reference: ${
            orderId || 'pending'
          }`
        : 'If you did not request this email, you can safely ignore it.',
    }),
  };

  const result = await dispatchMail(mailOptions, {
    label: `${purpose} verification code`,
  });

  if (!result.delivered) {
    logger.warn(
      `⚠️  Verification email delivery failed for ${email} (${purpose}). DEV CODE: ${code}`
    );
  }

  return result;
};

/**
 * Sends the internal alert for a high-value order that required a PIN.
 *
 * The alert goes to the operations mailbox (the SMTP user by default) so the
 * team knows a large purchase is waiting for its PIN confirmation.
 *
 * @param {object} details
 * @param {string} details.email   the customer who requested the PIN
 * @param {string} [details.name]  the customer name
 * @param {number} [details.amount] the order value
 * @param {string} [details.code]  the issued PIN
 * @returns {Promise<{delivered: boolean, messageId: string|null, error: string|null}>}
 */
export const sendHighValueOrderAlert = async (details = {}) => {
  const { email, name, amount, code } = details;
  const recipient = process.env.ADMIN_ALERT_EMAIL || smtpConfig().auth.user;

  if (!recipient) {
    logger.warn('⚠️  High-value order alert skipped — no admin alert address configured.');
    return { delivered: false, messageId: null, error: 'No admin alert address configured.' };
  }

  const amountLabel =
    amount === undefined || amount === null
      ? 'an unspecified amount'
      : `TSh ${Number(amount).toLocaleString()}`;

  const mailOptions = {
    from: smtpConfig().from,
    to: recipient,
    subject: `⚠️ High-value order confirmation PIN issued — ${amountLabel}`,
    text: `A high-value purchase request for ${amountLabel} from ${name || email || 'a customer'} generated a confirmation PIN (${code || 'n/a'}). The order is on hold until the customer confirms it.`,
    html: `
      <div style="font-family: Arial, Helvetica, sans-serif; padding: 20px; background-color: #f8fafc;">
        <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0;">
          <h2 style="color: #0f172a; margin-top: 0;">High-value order awaiting confirmation</h2>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #475569;">
            <tr><td style="padding: 6px 0; color: #94a3b8;">Customer</td><td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${name || email || 'Unknown'}</td></tr>
            <tr><td style="padding: 6px 0; color: #94a3b8;">Contact</td><td style="padding: 6px 0;">${email || 'n/a'}</td></tr>
            <tr><td style="padding: 6px 0; color: #94a3b8;">Order value</td><td style="padding: 6px 0; font-weight: bold; color: #0f172a;">${amountLabel}</td></tr>
            <tr><td style="padding: 6px 0; color: #94a3b8;">Confirmation PIN</td><td style="padding: 6px 0; font-weight: bold; color: #ef4444; letter-spacing: 3px;">${code || 'n/a'}</td></tr>
          </table>
          <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">The order stays on hold until the customer submits the PIN.</p>
        </div>
      </div>
    `,
  };

  return dispatchMail(mailOptions, { label: 'High-value order alert' });
};
