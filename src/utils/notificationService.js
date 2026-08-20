import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const sendOrderReceiptEmail = async (userEmail, orderDetails) => {
  try {
    const mailOptions = {
      from: `"HUALINK Logistics" <${process.env.SMTP_USER}>`,
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

    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Email dispatch failed:', error.message);
  }
};