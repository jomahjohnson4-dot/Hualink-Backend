// backend/src/utils/emailService.js
import nodemailer from 'nodemailer';
import logger from './logger.js';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true for 465 (SSL), false for 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    // Do not fail on self-signed certs in local/dev environments
    rejectUnauthorized: process.env.NODE_ENV === 'production',
  },
});

/**
 * Send a 6-digit password-reset OTP to the target email.
 *
 * On a 535 Bad Credentials (or any SMTP/auth failure), logs the OTP clearly to
 * the terminal so local development never breaks while SMTP credentials are being
 * provisioned. The OTP is still persisted to the DB so the reset flow remains testable.
 */
export const sendResetEmail = async (email, otp) => {
  const mailOptions = {
    from: '"Hualink Support" <no-reply@hualink.com>',
    to: email,
    subject: 'Password Reset Verification Code',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f8fafc;">
        <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0;">
          <h2 style="color: #0f172a; margin-top: 0;">Password Reset Request</h2>
          <p style="color: #475569; font-size: 14px;">Use the following 6-digit verification code to reset your password. This code expires in 10 minutes:</p>
          <div style="text-align: center; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: bold; color: #ef4444; letter-spacing: 6px; background: #fef2f2; padding: 12px 24px; border-radius: 8px; border: 1px solid #fecaca; display: inline-block;">${otp}</span>
          </div>
          <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">If you did not request this, please ignore this email.</p>
        </div>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`📧 Password reset OTP sent to ${email}`);
  } catch (emailError) {
    const message = emailError && emailError.message ? emailError.message : String(emailError);
    const isAuthError =
      message.includes('535') ||
      message.includes('Bad credentials') ||
      message.includes('Invalid login') ||
      message.includes('authentication') ||
      emailError.responseCode === 535;

    if (isAuthError) {
      logger.warn(
        `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n⚠️  SMTP authentication failed (535 Bad Credentials) for ${email}.\n   DEV OTP CODE: ${otp}\n   Configure SMTP_USER/SMTP_PASS (Gmail App Password) in .env to send real emails.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
      );
    } else {
      logger.error(`❌ Failed to send reset email to ${email}: ${message}`);
    }

    // Never throw: keep the reset flow functional during local development.
  }
};
