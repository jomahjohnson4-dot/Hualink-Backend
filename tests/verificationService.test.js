// tests/verificationService.test.js
//
// The verification engine must never hand out a fixed passcode.
//
// These tests pin that behaviour down:
//   1. Demo mode is opt-in — a development server issues real codes.
//   2. The demo codes only exist when an operator configures them.
//   3. Every issued code is a real, random 6-digit number.
//   4. The verifier only accepts the code that was actually issued.

import { jest } from '@jest/globals';

const verificationCodeCreate = jest.fn(async ({ data }) => ({ id: 'v1', ...data }));
const verificationCodeUpdateMany = jest.fn(async () => ({ count: 0 }));
const verificationCodeUpdate = jest.fn(async ({ data }) => ({ id: 'v1', ...data }));
const verificationCodeFindFirst = jest.fn(async () => null);
const notificationCreate = jest.fn(async ({ data }) => ({ id: 'n1', ...data }));

jest.unstable_mockModule('../src/utils/prismaClient.js', () => ({
  default: {
    verificationCode: {
      create: verificationCodeCreate,
      updateMany: verificationCodeUpdateMany,
      update: verificationCodeUpdate,
      findFirst: verificationCodeFindFirst,
    },
    notification: { create: notificationCreate },
    user: { update: jest.fn(async () => ({})) },
  },
}));

const sendVerificationEmail = jest.fn(async () => ({
  delivered: true,
  messageId: 'm1',
}));

jest.unstable_mockModule('../src/services/emailService.js', () => ({
  sendVerificationEmail,
}));

const verificationService = await import('../src/services/verificationService.js');

const { isDemoMode, DEMO_CODES, requestVerificationCode, verifyVerificationCode } =
  verificationService;

describe('HUALINK demo mode is opt-in', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // A development server must behave exactly like a production one.
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_DEMO_OTP;
    delete process.env.DEMO_OTP_CODE;
    delete process.env.DEMO_PIN_CODE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('is off while the server runs in development mode', () => {
    expect(isDemoMode()).toBe(false);
  });

  it('is switched on only by an explicit ALLOW_DEMO_OTP flag', () => {
    process.env.ALLOW_DEMO_OTP = 'true';

    expect(isDemoMode()).toBe(true);
  });

  it('ships no built-in demo code', () => {
    expect(DEMO_CODES.SIGNUP).toBeNull();
    expect(DEMO_CODES.ORDER).toBeNull();
  });

  it('uses the demo code only when one is configured explicitly', () => {
    process.env.ALLOW_DEMO_OTP = 'true';
    process.env.DEMO_OTP_CODE = '654321';

    expect(DEMO_CODES.SIGNUP).toBe('654321');
  });
});

describe('HUALINK issued codes are random', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_DEMO_OTP;
    delete process.env.DEMO_OTP_CODE;
    delete process.env.DEMO_PIN_CODE;
    verificationCodeCreate.mockClear();
    sendVerificationEmail.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('issues a random 6-digit code instead of the fixed 123456', async () => {
    await requestVerificationCode({ email: 'customer@example.com', purpose: 'SIGNUP' });

    const issued = verificationCodeCreate.mock.calls.at(-1)[0].data.code;

    expect(issued).toMatch(/^\d{6}$/);
    expect(issued).not.toBe('123456');
  });

  it('issues a new code on every request', async () => {
    await requestVerificationCode({ email: 'customer@example.com', purpose: 'SIGNUP' });
    await requestVerificationCode({ email: 'customer@example.com', purpose: 'SIGNUP' });

    const first = verificationCodeCreate.mock.calls.at(-2)[0].data.code;
    const second = verificationCodeCreate.mock.calls.at(-1)[0].data.code;

    expect(first).not.toBe(second);
  });

  it('emails the code that was actually issued', async () => {
    await requestVerificationCode({ email: 'customer@example.com', purpose: 'SIGNUP' });

    const issued = verificationCodeCreate.mock.calls.at(-1)[0].data.code;

    expect(sendVerificationEmail).toHaveBeenCalledWith(
      'customer@example.com',
      issued,
      'SIGNUP',
      expect.anything()
    );
  });

  it('pins the code only when demo mode is switched on explicitly', async () => {
    process.env.ALLOW_DEMO_OTP = 'true';
    process.env.DEMO_OTP_CODE = '654321';

    await requestVerificationCode({ email: 'customer@example.com', purpose: 'SIGNUP' });

    expect(verificationCodeCreate.mock.calls.at(-1)[0].data.code).toBe('654321');
  });
});

describe('HUALINK verification only accepts an issued code', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_DEMO_OTP;
    delete process.env.DEMO_OTP_CODE;
    verificationCodeFindFirst.mockReset();
    verificationCodeUpdate.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects the old fixed passcode', async () => {
    verificationCodeFindFirst.mockResolvedValueOnce({
      id: 'v1',
      code: '918273',
      purpose: 'SIGNUP',
      status: 'PENDING',
      email: 'customer@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      verifyVerificationCode({
        code: '123456',
        email: 'customer@example.com',
        purpose: 'SIGNUP',
      })
    ).rejects.toThrow(/incorrect/i);
  });

  it('accepts the code that was issued', async () => {
    verificationCodeFindFirst.mockResolvedValueOnce({
      id: 'v1',
      code: '918273',
      purpose: 'SIGNUP',
      status: 'PENDING',
      email: 'customer@example.com',
      expiresAt: new Date(Date.now() + 60_000),
    });
    verificationCodeUpdate.mockResolvedValueOnce({ id: 'v1', status: 'VERIFIED' });

    const verified = await verifyVerificationCode({
      code: '918273',
      email: 'customer@example.com',
      purpose: 'SIGNUP',
    });

    expect(verified.status).toBe('VERIFIED');
  });
});
