#!/usr/bin/env node
/**
 * scripts/verify-email-flows.js
 *
 * End-to-end check of the three flows that depend on the mailer:
 *
 *   1. POST /api/auth/forgot-password   -> password reset passcode
 *   2. POST /api/auth/request-signup-otp -> sign-up verification code
 *   3. POST /api/orders/request-pin      -> high-value order confirmation PIN
 *
 * Every message has to be accepted by Gmail, which proves the platform sends
 * "from" the configured mailbox. The script creates a throwaway account, runs
 * the flows and removes its artefacts again.
 *
 * Usage:  node scripts/verify-email-flows.js [baseUrl]
 */

import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

dotenv.config();

const BASE_URL = process.argv[2] || `http://localhost:${process.env.PORT || 5000}`;
const MAILBOX = process.env.SMTP_USER;
const TEST_PASSWORD = 'HualinkMailTest!2026';
const HIGH_VALUE_AMOUNT = 1_250_000;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const stamp = Date.now();
const aliasEmail = `${MAILBOX.split('@')[0]}+e2e-${stamp}@gmail.com`;

const line = (label, ok, extra = '') =>
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);

const api = async (path, { method = 'POST', body, token } = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { status: response.status, body: payload };
};

/**
 * Creates (or temporarily takes over) the account used by the run.
 *
 * The original password hash is kept so the account can be restored exactly
 * as it was once the verification is finished.
 */
const ensureTestUser = async () => {
  const password = await bcrypt.hash(TEST_PASSWORD, 10);

  const existing = await prisma.user.findUnique({
    where: { email: MAILBOX },
  });

  if (existing) {
    await prisma.user.update({
      where: { email: MAILBOX },
      data: { password, emailVerified: true },
    });
    return { user: existing, originalPassword: existing.password, created: false };
  }

  const created = await prisma.user.create({
    data: {
      email: MAILBOX,
      name: 'Hualink Mail Test',
      password,
      role: 'CUSTOMER',
      emailVerified: true,
    },
  });

  return { user: created, originalPassword: null, created: true };
};

/** Puts the account back the way the run found it. */
const restoreTestUser = async ({ user, originalPassword, created }) => {
  if (created) {
    await prisma.user.deleteMany({ where: { email: MAILBOX } });
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: originalPassword,
      resetOtp: null,
      resetOtpExpires: null,
    },
  });
};

const run = async () => {
  console.log('\n🧪 Hualink mail flow verification');
  console.log('─────────────────────────────────');
  console.log(`   API       : ${BASE_URL}`);
  console.log(`   Mailbox   : ${MAILBOX}`);
  console.log('─────────────────────────────────\n');

  const account = await ensureTestUser();
  const user = account.user;
  let ok = true;

  // ---- 1. Forgot password passcode -------------------------------------
  const forgot = await api('/api/auth/forgot-password', {
    body: { email: MAILBOX },
  });

  const forgotDelivered = forgot.body?.data?.delivered === true;
  const passcodeStored = await prisma.user.findUnique({
    where: { email: MAILBOX },
    select: { resetOtp: true, resetOtpExpires: true },
  });

  line(
    'POST /api/auth/forgot-password',
    forgot.status === 200 && forgotDelivered && Boolean(passcodeStored?.resetOtp),
    `status ${forgot.status}, delivered=${forgotDelivered}, passcode persisted=${Boolean(
      passcodeStored?.resetOtp
    )}`
  );
  ok = ok && forgot.status === 200 && forgotDelivered && Boolean(passcodeStored?.resetOtp);

  // ---- 2. Sign-up verification code ------------------------------------
  const signup = await api('/api/auth/request-signup-otp', {
    body: { email: aliasEmail },
  });

  const signupDelivered = signup.body?.data?.delivered?.email === true;
  const signupRow = await prisma.verificationCode.findFirst({
    where: { email: aliasEmail, purpose: 'SIGNUP' },
    orderBy: { createdAt: 'desc' },
  });

  line(
    'POST /api/auth/request-signup-otp',
    signup.status === 200 && signupDelivered && Boolean(signupRow),
    `status ${signup.status}, delivered=${signupDelivered}, verification row=${
      signupRow?.status || 'none'
    }`
  );
  ok = ok && signup.status === 200 && signupDelivered && Boolean(signupRow);

  // ---- 3. High-value order confirmation PIN ----------------------------
  const login = await api('/api/auth/login', {
    body: { email: MAILBOX, password: TEST_PASSWORD },
  });
  const token = login.body?.token;

  if (!token) {
    line('POST /api/auth/login', false, `status ${login.status}`);
    ok = false;
  } else {
    line('POST /api/auth/login', true);

    const pin = await api('/api/orders/request-pin', {
      token,
      body: { amount: HIGH_VALUE_AMOUNT },
    });

    const pinDelivered = pin.body?.data?.delivered?.email === true;
    const pinRow = await prisma.verificationCode.findFirst({
      where: { userId: user.id, purpose: 'ORDER' },
      orderBy: { createdAt: 'desc' },
    });

    line(
      'POST /api/orders/request-pin',
      pin.status === 200 && pinDelivered && Boolean(pinRow),
      `status ${pin.status}, delivered=${pinDelivered}, amount recorded=${
        pinRow?.amount ?? 'none'
      }`
    );
    ok = ok && pin.status === 200 && pinDelivered && Boolean(pinRow);
  }

  // ---- Cleanup ----------------------------------------------------------
  await prisma.verificationCode.deleteMany({ where: { email: aliasEmail } });
  await prisma.user.deleteMany({ where: { email: aliasEmail } });
  await prisma.verificationCode.deleteMany({
    where: { userId: user.id, purpose: 'ORDER' },
  });
  await restoreTestUser(account);

  console.log(`\n${ok ? '✅ All mail flows verified.' : '❌ Some mail flows failed.'}\n`);
  return ok;
};

run()
  .then(async (ok) => {
    await prisma.$disconnect();
    await pool.end();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (error) => {
    console.error('❌ Verification run crashed:', error?.message || error);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
