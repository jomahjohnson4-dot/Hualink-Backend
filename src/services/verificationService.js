// src/services/verificationService.js
import { randomInt } from 'node:crypto';
import prisma from '../utils/prismaClient.js';
import logger from '../utils/logger.js';
import { sendVerificationEmail } from './emailService.js';
import { sendSMS } from '../utils/smsService.js';
import { notifyAdmins, notifyUser } from './notificationService.js';

/**
 * Verification Code (OTP / PIN) engine.
 *
 * Two flows share the same storage:
 *
 *  - `SIGNUP` — a 6-digit code proving the customer owns the email/phone they
 *    registered with. The verified state is persisted on the `User` row
 *    (`email_verified`) and mirrored in `verification_codes`.
 *  - `ORDER`  — a 4-digit PIN confirming a high-value wholesale purchase
 *    request before the order is written to the database.
 *
 * Every issued and verified code leaves an audit row behind, which the admin
 * console surfaces as the "Notifications & Audit Log" panel.
 */

/** How long a code stays usable, per purpose (minutes). */
const TTL_MINUTES = {
  SIGNUP: 10,
  ORDER: 5,
};

/** How many digits each purpose uses. */
const CODE_LENGTH = {
  SIGNUP: 6,
  ORDER: 4,
};

/** The purposes this engine understands. */
export const VERIFICATION_PURPOSES = ['SIGNUP', 'ORDER'];

/**
 * Demo mode keeps the flows testable without a live SMTP/SMS provider.
 *
 * It is strictly opt-in: only `ALLOW_DEMO_OTP=true` switches it on. Running
 * the server with `NODE_ENV=development` no longer pins the codes — every
 * request issues a fresh, randomly generated code that is emailed for real.
 *
 * When demo mode is on, the code is echoed back to the client so the UI can
 * offer a one-click autofill helper.
 */
export const isDemoMode = () =>
  String(process.env.ALLOW_DEMO_OTP || '').trim().toLowerCase() === 'true';

/**
 * The demo codes surfaced by the UI helper.
 *
 * They only exist when an operator configured them explicitly (for example
 * `DEMO_OTP_CODE=123456`); the platform never falls back to a well-known
 * value on its own. The getters read the environment on every access so a
 * changed variable takes effect without a restart of the module.
 */
export const DEMO_CODES = {
  get SIGNUP() {
    return process.env.DEMO_OTP_CODE || null;
  },
  get ORDER() {
    return process.env.DEMO_PIN_CODE || null;
  },
};

/** Normalises a raw purpose into a valid enum value. */
export const resolvePurpose = (raw, fallback = 'SIGNUP') => {
  const value = String(raw || '').trim().toUpperCase();
  if (VERIFICATION_PURPOSES.includes(value)) return value;
  return fallback;
};

/**
 * Generates a cryptographically random numeric code of the requested length.
 *
 * `crypto.randomInt` is used instead of `Math.random()` because these codes
 * are the only thing standing between a mailbox and a customer account.
 */
const generateNumericCode = (length) => {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
};

/**
 * Builds the code an account sign-up / order confirmation should use.
 *
 * A pinned demo code is only used when demo mode is switched on *and* an
 * operator configured one for that purpose. In every other case a fresh
 * random code is issued and mailed to the customer.
 */
const buildCode = (purpose) => {
  const demoCode = DEMO_CODES[purpose];
  if (isDemoMode() && demoCode) return demoCode;
  return generateNumericCode(CODE_LENGTH[purpose]);
};

/** The human readable label used in notifications and emails. */
const purposeLabel = (purpose) =>
  purpose === 'ORDER' ? 'order confirmation' : 'account verification';

/**
 * Issues a verification code and stores it as PENDING.
 *
 * @param {object} params
 * @param {string} [params.email]     recipient email (required for SIGNUP)
 * @param {string} [params.phone]     recipient phone (optional)
 * @param {string} [params.purpose]   SIGNUP | ORDER
 * @param {string} [params.userId]    the signed-in customer (ORDER flows)
 * @param {string} [params.orderId]   the order the code guards
 * @param {number} [params.amount]    order value (TZS)
 * @returns {Promise<object>} the persisted row plus the delivery metadata
 */
export const requestVerificationCode = async ({
  email,
  phone,
  purpose = 'SIGNUP',
  userId = null,
  orderId = null,
  amount = null,
} = {}) => {
  const resolvedPurpose = resolvePurpose(purpose);
  const emailValue = email ? String(email).trim().toLowerCase() : null;
  const phoneValue = phone ? String(phone).trim() : null;

  if (!emailValue && !phoneValue && !userId) {
    throw Object.assign(new Error('An email address or phone number is required.'), {
      status: 400,
    });
  }

  const code = buildCode(resolvedPurpose);
  const expiresAt = new Date(
    Date.now() + (TTL_MINUTES[resolvedPurpose] || 10) * 60 * 1000
  );

  // Only one live code per recipient + purpose — older ones are retired so a
  // leaked/expired code can never be replayed.
  await prisma.verificationCode.updateMany({
    where: {
      purpose: resolvedPurpose,
      status: 'PENDING',
      ...(emailValue ? { email: emailValue } : { userId: userId || null }),
    },
    data: { status: 'EXPIRED' },
  });

  const record = await prisma.verificationCode.create({
    data: {
      code,
      purpose: resolvedPurpose,
      status: 'PENDING',
      email: emailValue,
      phone: phoneValue,
      userId: userId || null,
      orderId: orderId || null,
      amount: amount === null || amount === undefined ? null : Number(amount),
      expiresAt,
    },
  });

  // Deliver the code. Delivery failures are never fatal — the code stays
  // persisted so the flow can still be completed (and inspected in dev mode).
  const channel = [];
  const delivered = {};

  if (emailValue) {
    channel.push('email');
    try {
      const result = await sendVerificationEmail(emailValue, code, resolvedPurpose, {
        amount,
        orderId,
      });
      delivered.email = result?.delivered ?? null;
    } catch (emailError) {
      delivered.email = false;
      logger.warn(
        `⚠️  Verification email failed for ${emailValue}: ${emailError.message}`
      );
    }
  }

  if (phoneValue) {
    channel.push('sms');
    try {
      await sendSMS(
        phoneValue,
        `Your Hualink ${purposeLabel(resolvedPurpose)} code is ${code}. It expires in ${
          TTL_MINUTES[resolvedPurpose]
        } minutes.`
      );
      delivered.sms = true;
    } catch (smsError) {
      delivered.sms = false;
      logger.warn(
        `⚠️  Verification SMS failed for ${phoneValue}: ${smsError.message}`
      );
    }
  }

  if (isDemoMode()) {
    logger.info(
      `🔐 DEMO ${resolvedPurpose} CODE for ${emailValue || phoneValue || userId}: ${code}`
    );
  }

  // The audit trail: the admin console watches this bucket live.
  await notifyAdmins({
    type: 'VERIFY',
    title:
      resolvedPurpose === 'ORDER'
        ? 'Order Verification Code Issued'
        : 'Sign-up Verification Code Issued',
    message: `A ${CODE_LENGTH[resolvedPurpose]}-digit ${purposeLabel(
      resolvedPurpose
    )} code was sent to ${emailValue || phoneValue || 'a customer'}${
      amount ? ` for an order worth TSh ${Number(amount).toLocaleString()}` : ''
    }.`,
  }).catch((error) =>
    console.error('[Verification] Admin notification failed:', error?.message)
  );

  return {
    id: record.id,
    purpose: resolvedPurpose,
    channel,
    expiresAt,
    length: CODE_LENGTH[resolvedPurpose],
    // Per-channel delivery report so the API can tell the client whether the
    // code actually reached the customer.
    delivered,
    // Only surfaced in demo mode so the UI can offer an autofill helper.
    demoCode: isDemoMode() ? code : null,
    isDemo: isDemoMode(),
  };
};

/**
 * Verifies a submitted code against the stored record.
 *
 * The verified state is persisted in PostgreSQL: the `verification_codes` row
 * flips to VERIFIED and — for sign-ups — the owning `User` row is stamped
 * with `email_verified = true`.
 *
 * @param {object} params
 * @param {string} params.code       the code the customer typed
 * @param {string} [params.email]    the recipient email
 * @param {string} [params.phone]    the recipient phone
 * @param {string} [params.purpose]  SIGNUP | ORDER
 * @param {string} [params.userId]   the signed-in customer
 * @returns {Promise<object>} the verified row
 * @throws {Error} with `status` set to 400/404 when the code is not valid
 */
export const verifyVerificationCode = async ({
  code,
  email,
  phone,
  purpose = 'SIGNUP',
  userId = null,
} = {}) => {
  const submitted = String(code || '').trim();
  const resolvedPurpose = resolvePurpose(purpose);
  const emailValue = email ? String(email).trim().toLowerCase() : null;

  if (!submitted) {
    throw Object.assign(new Error('The verification code is required.'), {
      status: 400,
    });
  }

  // Find the newest live code for this recipient + purpose.
  const record = await prisma.verificationCode.findFirst({
    where: {
      purpose: resolvedPurpose,
      status: 'PENDING',
      ...(emailValue
        ? { email: emailValue }
        : userId
          ? { userId }
          : phone
            ? { phone: String(phone).trim() }
            : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    throw Object.assign(
      new Error('No verification code was found for this request. Please request a new code.'),
      { status: 400 }
    );
  }

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    await prisma.verificationCode.update({
      where: { id: record.id },
      data: { status: 'EXPIRED' },
    });
    throw Object.assign(new Error('The verification code has expired.'), {
      status: 400,
    });
  }

  // The pinned demo code is only accepted when demo mode is switched on
  // explicitly *and* an operator configured one for this purpose. Without
  // that, only the code that was actually issued is ever accepted.
  const demoCode = DEMO_CODES[resolvedPurpose];
  const demoAccepted = isDemoMode() && Boolean(demoCode) && submitted === demoCode;

  if (record.code !== submitted && !demoAccepted) {
    // Count the failed attempt so brute forcing leaves a trail.
    await prisma.verificationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw Object.assign(new Error('The verification code is incorrect.'), {
      status: 400,
    });
  }

  const verified = await prisma.verificationCode.update({
    where: { id: record.id },
    data: { status: 'VERIFIED', verifiedAt: new Date() },
  });

  // Store the verified status on the account itself.
  if (resolvedPurpose === 'SIGNUP' && record.userId) {
    await prisma.user.update({
      where: { id: record.userId },
      data: { emailVerified: true, verifiedAt: new Date() },
    });
  }

  await notifyAdmins({
    type: 'VERIFY',
    title:
      resolvedPurpose === 'ORDER'
        ? 'Order Verification Confirmed'
        : 'Account Verification Confirmed',
    message: `The ${purposeLabel(
      resolvedPurpose
    )} code for ${emailValue || record.phone || 'a customer'} was confirmed successfully.`,
  }).catch((error) =>
    console.error('[Verification] Admin notification failed:', error?.message)
  );

  return verified;
};

/**
 * Confirms a wholesale purchase request with a 4-digit PIN.
 *
 * @param {object} params
 * @param {string} params.userId  the signed-in customer
 * @param {string} params.code    the PIN the customer typed
 * @param {number} [params.amount] the order value being authorised
 */
export const verifyOrderPin = async ({ userId, code, amount = null } = {}) => {
  const owner = userId || null;

  const verified = await verifyVerificationCode({
    code,
    purpose: 'ORDER',
    userId: owner,
  });

  // When the order value is known, make sure the PIN was issued for it.
  if (amount !== null && verified.amount !== null && Number(verified.amount) !== Number(amount)) {
    throw Object.assign(
      new Error('This verification code was issued for a different order value.'),
      { status: 400 }
    );
  }

  return verified;
};

/**
 * Notifies a customer that their account has been verified.
 */
export const notifyVerificationSuccess = (userId, { email, purpose = 'SIGNUP' } = {}) =>
  notifyUser(userId, {
    type: 'VERIFY',
    title:
      purpose === 'ORDER'
        ? 'Order Verification Successful'
        : 'Account Verified Successfully',
    message:
      purpose === 'ORDER'
        ? `Your order request for ${email || 'this purchase'} was confirmed with a valid PIN.`
        : `Your Hualink account (${email || 'your details'}) has been verified. Welcome aboard!`,
  });

/**
 * Recent verification events — used by the admin audit log panel.
 */
export const getVerificationAuditTrail = async ({ limit = 50 } = {}) => {
  const records = await prisma.verificationCode.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(parseInt(limit, 10) || 50, 200),
  });

  return records;
};
