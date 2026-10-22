// tests/emailService.test.js
//
// Unit tests for the mail transport. They cover the two guarantees the
// platform depends on:
//
//   1. The transport is built from the SMTP environment variables.
//   2. A network glitch is logged as a warning and never propagates as an
//      exception, so the Express server keeps serving requests.

import { jest } from '@jest/globals';

const sendMailMock = jest.fn();
const verifyMock = jest.fn();
const closeMock = jest.fn();
const onMock = jest.fn();

const createTransportMock = jest.fn((options) => ({
  options,
  sendMail: sendMailMock,
  verify: verifyMock,
  close: closeMock,
  on: onMock,
}));

jest.unstable_mockModule('nodemailer', () => ({
  default: { createTransport: createTransportMock },
}));

const emailService = await import('../src/services/emailService.js');

/** A transport that always fails the way an unreachable mail server does. */
const failingTransport = (error) => ({ sendMail: jest.fn().mockRejectedValue(error) });

describe('HUALINK SMTP transport configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SMTP_HOST = 'smtp.test.local';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_USER = 'mailer@test.local';
    process.env.SMTP_PASS = 'app-password';
    delete process.env.SMTP_FROM;
    createTransportMock.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('creates the transport from the SMTP environment variables', () => {
    emailService.createSmtpTransporter();

    const options = createTransportMock.mock.calls.at(-1)[0];

    expect(options.host).toBe('smtp.test.local');
    expect(options.port).toBe(465);
    expect(options.secure).toBe(true);
    expect(options.auth).toEqual({ user: 'mailer@test.local', pass: 'app-password' });
  });

  it('uses STARTTLS on port 587 when SMTP_SECURE is not set', () => {
    process.env.SMTP_PORT = '587';
    delete process.env.SMTP_SECURE;

    expect(emailService.smtpConfig().secure).toBe(false);
  });

  it('sends from the authenticated mailbox so Gmail accepts the message', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: 'test-1' });

    await emailService.sendPasswordResetEmail('customer@example.com', '123456');

    const options = sendMailMock.mock.calls.at(-1)[0];
    expect(options.from).toContain('mailer@test.local');
    expect(options.to).toBe('customer@example.com');
  });

  it('never mails a passcode that is not a 6-digit number', async () => {
    sendMailMock.mockClear();

    const result = await emailService.sendPasswordResetEmail('customer@example.com', '1234');

    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/6-digit/);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('registers an error listener so a socket glitch cannot crash Node', () => {
    emailService.getTransporter();

    expect(onMock).toHaveBeenCalledWith('error', expect.any(Function));

    // The handler has to swallow the error instead of re-throwing it.
    const handler = onMock.mock.calls.find(([event]) => event === 'error')[1];
    expect(() => handler(new Error('socket hang up'))).not.toThrow();
  });
});

describe('HUALINK mail delivery resilience', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
  });

  it('reports a failed delivery instead of throwing', async () => {
    const transport = failingTransport(
      Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:465'), { code: 'ETIMEDOUT' })
    );

    const result = await emailService.dispatchMail(
      { to: 'customer@example.com' },
      { transport, attempts: 1 }
    );

    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/ETIMEDOUT/);
  });

  it('retries a transient network glitch once before giving up', async () => {
    const sendMail = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('socket hang up'), { code: 'ESOCKET' })
      )
      .mockResolvedValueOnce({ messageId: 'recovered' });

    const result = await emailService.dispatchMail(
      { to: 'customer@example.com' },
      { transport: { sendMail }, attempts: 2 }
    );

    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe('recovered');
  });

  it('keeps the password reset flow alive when the mail server is down', async () => {
    const transport = failingTransport(
      Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
    );

    await expect(
      emailService.dispatchMail({ to: 'customer@example.com' }, { transport, attempts: 1 })
    ).resolves.toMatchObject({ delivered: false });
  });
});

describe('HUALINK mail content', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ messageId: 'test-2' });
    process.env.SMTP_USER = 'mailer@test.local';
    delete process.env.SMTP_FROM;
  });

  it('includes the sign-up verification code', async () => {
    await emailService.sendVerificationEmail('customer@example.com', '123456', 'SIGNUP');

    const options = sendMailMock.mock.calls.at(-1)[0];
    expect(options.subject).toMatch(/Verification Code/i);
    expect(options.html).toContain('123456');
  });

  it('includes the order value in the high-value PIN email', async () => {
    await emailService.sendVerificationEmail('customer@example.com', '1234', 'ORDER', {
      amount: 1250000,
    });

    const options = sendMailMock.mock.calls.at(-1)[0];
    expect(options.subject).toMatch(/Order Confirmation PIN/i);
    expect(options.html).toContain('1234');
    expect(options.html).toContain('1,250,000');
  });

  it('sends the order alert to the operations mailbox', async () => {
    await emailService.sendHighValueOrderAlert({
      email: 'customer@example.com',
      name: 'Jane Doe',
      amount: 1250000,
      code: '1234',
    });

    const options = sendMailMock.mock.calls.at(-1)[0];
    expect(options.to).toBe('mailer@test.local');
    expect(options.html).toContain('1,250,000');
    expect(options.html).toContain('Jane Doe');
  });
});
