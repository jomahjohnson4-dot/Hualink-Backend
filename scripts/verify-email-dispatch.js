#!/usr/bin/env node
/**
 * scripts/verify-email-dispatch.js
 *
 * Live smoke test for the Hualink mail pipeline.
 *
 * It opens the SMTP connection configured through the environment and sends
 * one real message for each flow the platform relies on:
 *
 *   1. Sign-up verification code   (account activation)
 *   2. Password reset passcode     (POST /api/auth/forgot-password)
 *   3. Order confirmation PIN      (high-value purchase alerts)
 *
 * Every message is delivered to the mailbox configured in SMTP_USER so the
 * run doubles as proof that the platform sends "from" that address.
 *
 * Usage:  node scripts/verify-email-dispatch.js [recipient@example.com]
 */

import dotenv from 'dotenv';
import { randomInt } from 'node:crypto';
import {
  smtpConfig,
  verifySmtpConnection,
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendHighValueOrderAlert,
  closeSmtpPool,
} from '../src/services/emailService.js';

dotenv.config();

const config = smtpConfig();
const recipient =
  process.argv[2] || process.env.ADMIN_ALERT_EMAIL || config.auth.user;

const line = (label, ok, extra = '') =>
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);

const run = async () => {
  console.log('\n📨 Hualink SMTP dispatch verification');
  console.log('────────────────────────────────────────');
  console.log(`   Host      : ${config.host}:${config.port} (secure=${config.secure})`);
  console.log(`   Sender    : ${config.from}`);
  console.log(`   Recipient : ${recipient}`);
  console.log('────────────────────────────────────────\n');

  const connection = await verifySmtpConnection();
  if (!connection.connected) {
    line('SMTP connection', false, connection.error);
    return false;
  }
  line('SMTP connection', true);

  const results = [];

  // 1. Sign-up verification code
  const signupCode = String(randomInt(100000, 1000000));
  results.push({
    name: 'Sign-up verification code',
    ...(await sendVerificationEmail(recipient, signupCode, 'SIGNUP')),
  });

  // 2. Password reset passcode
  const passcode = String(randomInt(100000, 1000000));
  results.push({
    name: 'Password reset passcode',
    ...(await sendPasswordResetEmail(recipient, passcode)),
  });

  // 3. High-value order confirmation PIN
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  results.push({
    name: 'Order confirmation PIN',
    ...(await sendVerificationEmail(recipient, pin, 'ORDER', {
      amount: 1250000,
      orderId: 'SMOKE-TEST',
    })),
  });

  // 4. Internal high-value order alert
  results.push({
    name: 'High-value order alert',
    ...(await sendHighValueOrderAlert({
      email: recipient,
      name: 'Hualink Smoke Test',
      amount: 1250000,
      code: pin,
    })),
  });

  console.log('');
  for (const result of results) {
    line(
      result.name,
      result.delivered,
      result.delivered
        ? `message id ${result.messageId}`
        : result.error
    );
  }

  const delivered = results.filter((result) => result.delivered).length;

  console.log(
    `\n${delivered}/${results.length} messages delivered to ${recipient}\n`
  );

  return delivered === results.length;
};

run()
  .then(async (ok) => {
    await closeSmtpPool();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (error) => {
    console.error('\n❌ Verification run crashed:', error?.message || error);
    await closeSmtpPool();
    process.exit(1);
  });
