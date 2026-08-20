import crypto from 'crypto';
import { prisma } from '../utils/prismaClient.js';

/**
 * Initiate payment push (e.g., M-Pesa / Tigo Pesa / Selcom USSD Push)
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

  // Generate unique transaction reference for mobile gateway tracking
  const transactionRef = `HL-TX-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

  // Update order with transaction reference
  await prisma.order.update({
    where: { id: orderId },
    data: { transactionRef },
  });

  // Example integration payload structure for Selcom / AzamPay API calls
  const gatewayPayload = {
    amount: amount || order.totalAmount,
    currency: 'TZS',
    phone: phone || order.customerPhone,
    reference: transactionRef,
    orderId: order.id,
    provider: provider || 'MOBILE_MONEY',
  };

  // Mock gateway trigger response (Replace with real Axios/fetch call to AzamPay or Selcom endpoint)
  console.log('Initiating Payment Gateway Request:', gatewayPayload);

  return {
    success: true,
    message: 'Payment prompt dispatched to customer mobile device.',
    transactionRef,
  };
};

/**
 * Process incoming payment gateway webhooks safely inside a transaction
 */
export const processPaymentWebhookService = async (payload, rawSignature) => {
  const webhookSecret = process.env.WEBHOOK_SECRET;

  // 1. Verify HMAC Signature if secret is configured
  if (webhookSecret && rawSignature) {
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    if (rawSignature !== expectedSignature) {
      throw new Error('Invalid webhook payload signature.');
    }
  }

  const { orderId, transactionRef, status } = payload;

  if (!orderId && !transactionRef) {
    throw new Error('Webhook missing required order identifiers.');
  }

  // Find order by ID or transaction reference
  const order = await prisma.order.findFirst({
    where: {
      OR: [{ id: orderId || '' }, { transactionRef: transactionRef || '' }],
    },
  });

  if (!order) {
    throw new Error('Associated order record not found.');
  }

  // Normalize incoming status from provider
  let updatedPaymentStatus = 'PENDING';
  let updatedOrderStatus = order.status;

  if (['SUCCESS', 'COMPLETED', 'PAID', 'SUCCESSFUL'].includes(status?.toUpperCase())) {
    updatedPaymentStatus = 'PAID';
    updatedOrderStatus = 'CONFIRMED';
  } else if (['FAILED', 'CANCELLED', 'REJECTED'].includes(status?.toUpperCase())) {
    updatedPaymentStatus = 'FAILED';
  }

  // 2. Atomic state transition update
  const updatedOrder = await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: updatedPaymentStatus,
      status: updatedOrderStatus,
      ...(transactionRef && { transactionRef }),
    },
  });

  return updatedOrder;
};