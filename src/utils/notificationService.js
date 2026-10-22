import nodemailer from 'nodemailer';

const createTransporter = () => {
  const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
  const SMTP_SECURE =
    process.env.SMTP_SECURE !== undefined
      ? String(process.env.SMTP_SECURE).trim().toLowerCase() === 'true'
      : SMTP_PORT === 465;

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: SMTP_PORT,
    secure: SMTP_SECURE, // true for 465 (SSL), false for 587 (STARTTLS)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  });

  // Connection level problems are reported through this event. Without a
  // listener Node would treat it as an unhandled 'error' event and stop.
  transport.on('error', (error) => {
    console.warn('SMTP transport error (non-fatal):', error?.message || error);
  });

  return transport;
};

// The transport is built on first use: ES module imports are evaluated before
// the body of the importing module, so a transport created at import time
// would capture an environment that `dotenv.config()` has not loaded yet and
// Gmail would reject every message with "530 Authentication Required".
let transporter = null;
const getTransporter = () => {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
};

export const sendOrderReceiptEmail = async (userEmail, orderDetails) => {
  try {
    const mailOptions = {
      from: process.env.SMTP_FROM || `"HUALINK Logistics" <${process.env.SMTP_USER}>`,
      to: userEmail,
      subject: `Order Receipt - #${orderDetails.id}`,
      html: `
        <h2>Order Confirmation</h2>
        <p>Thank you for your order with HUALINK!</p>
        <p><strong>Order ID:</strong> ${orderDetails.id}</p>
        <p><strong>Total Paid:</strong> TSH ${orderDetails.totalAmount}</p>
        <p><strong>Status:</strong> ${orderDetails.paymentStatus}</p>
      `,
    };

    await getTransporter().sendMail(mailOptions);
  } catch (error) {
    console.error('Email dispatch failed:', error.message);
  }
};