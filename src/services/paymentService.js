import crypto from 'crypto';
import https from 'https';
import axios from 'axios';
import { prisma } from '../utils/prismaClient.js';

// HTTPS Agent configured to prevent connection resets
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true,
});

// Axios instance configured for AzamPay requirements
const azamClient = axios.create({
  httpsAgent,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Hualink/1.0',
    'Accept': 'application/json',
  },
});

/**
 * Fetch AzamPay Bearer Token
 */
const getAzamPayToken = async () => {
  const appName = process.env.AZAMPAY_APP_NAME;
  const clientId = process.env.AZAMPAY_CLIENT_ID;
  const clientSecret = process.env.AZAMPAY_CLIENT_SECRET;

  if (!appName || !clientId || !clientSecret) {
    throw new Error('AzamPay credentials missing in .env (AZAMPAY_APP_NAME, AZAMPAY_CLIENT_ID, AZAMPAY_CLIENT_SECRET)');
  }

  try {
    // Corrected URL path with /azampay/ prefix
    const response = await azamClient.post('https://sandbox.azampay.co.tz/azampay/momo/v1/gettoken', {
      appName,
      clientId,
      clientSecret,
    });

    const token = response.data?.data?.accessToken || response.data?.accessToken;

    if (!token) {
      throw new Error(response.data?.message || 'AzamPay auth succeeded but no token returned.');
    }

    return token;
  } catch (err) {
    const apiError = err.response?.data?.message || err.response?.data?.error || err.message;
    throw new Error(`AzamPay Auth Error: ${apiError}`);
  }
};

/**
 * Initiate payment push (AzamPay Gateway)
 */
export const initiatePaymentService = async ({ orderId, phone, amount, provider }) => {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    throw new Error('Order not found');
  }

  if (order.paymentStatus === 'PAID') {
    throw new Error('Order is already paid');
  }

  const transactionRef = `HL-TX-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

  await prisma.order.update({
    where: { id: orderId },
    data: { transactionRef },
  });

  const formattedPhone = (phone || order.customerPhone).replace(/^\+/, '');
  const paymentAmount = amount || order.totalAmount;

  const rawProvider = (provider || '').toUpperCase();
  let azamOperator = 'Airtel';

  if (rawProvider.includes('MPESA') || rawProvider.includes('M-PESA') || rawProvider.includes('VODACOM')) {
    azamOperator = 'Mpesa';
  } else if (rawProvider.includes('TIGO')) {
    azamOperator = 'Tigo';
  } else if (rawProvider.includes('HALO')) {
    azamOperator = 'Halopesa';
  }

  try {
    console.log(`[AZAMPAY SANDBOX] Initiating ${azamOperator} push to ${formattedPhone} for ${paymentAmount} TZS`);

    const token = await getAzamPayToken();

    const azamPayload = {
      accountNumber: formattedPhone,
      amount: String(paymentAmount),
      currency: 'TZS',
      externalId: transactionRef,
      provider: azamOperator,
    };

    const response = await azamClient.post(
      'https://sandbox.azampay.co.tz/azampay/momo/v1/checkout',
      azamPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return {
      success: true,
      message: `${azamOperator} payment prompt dispatched successfully.`,
      transactionRef,
      data: response.data,
    };

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message || `Failed to dispatch ${azamOperator} payment prompt.`;
    throw new Error(errorMsg);
  }
};

/**
 * Process incoming payment gateway webhooks safely
 */
export const processPaymentWebhookService = async (payload, rawSignature) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && rawSignature) {
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    if (rawSignature !== expectedSignature) {
      throw new Error('Invalid webhook payload signature.');
    }
  }

  const { orderId, transactionRef, externalId, status } = payload;
  const refIdentifier = transactionRef || externalId;

  if (!orderId && !refIdentifier) {
    throw new Error('Webhook missing required order identifiers.');
  }

  const order = await prisma.order.findFirst({
    where: {
      OR: [{ id: orderId || '' }, { transactionRef: refIdentifier || '' }],
    },
  });

  if (!order) {
    throw new Error('Associated order record not found.');
  }

  let updatedPaymentStatus = 'PENDING';
  let updatedOrderStatus = order.status;

  if (['SUCCESS', 'COMPLETED', 'PAID', 'SUCCESSFUL'].includes(status?.toUpperCase())) {
    updatedPaymentStatus = 'PAID';
    updatedOrderStatus = 'CONFIRMED';
  } else if (['FAILED', 'CANCELLED', 'REJECTED'].includes(status?.toUpperCase())) {
    updatedPaymentStatus = 'FAILED';
  }

  const updatedOrder = await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: updatedPaymentStatus,
      status: updatedOrderStatus,
      ...(refIdentifier && { transactionRef: refIdentifier }),
    },
  });

  return updatedOrder;
};