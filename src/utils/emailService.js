// backend/utils/sendEmail.js
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
  port: Number(process.env.SMTP_PORT) || 2525,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const sendResetEmail = async (email, otp) => {
  const mailOptions = {
    from: '"Hualink Support" <no-reply@hualink.com>',
    to: email,
    subject: 'Password Reset Verification Code',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f8fafc;">
        <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 24px; border: 1px solid #e2e8f0;">
          <h2 style="color: #0f172a; margin-top: 0;">Password Reset Request</h2>
          <p style="color: #475569; font-size: 14px;">Use the following 6-digit verification code to reset your password. This code expires in 15 minutes:</p>
          <div style="text-align: center; margin: 24px 0;">
            <span style="font-size: 32px; font-weight: bold; color: #ef4444; letter-spacing: 6px; background: #fef2f2; padding: 12px 24px; border-radius: 8px; border: 1px solid #fecaca; display: inline-block;">${otp}</span>
          </div>
          <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">If you did not request this, please ignore this email.</p>
        </div>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};