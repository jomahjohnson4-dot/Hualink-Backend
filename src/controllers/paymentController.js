import {
  initiatePaymentService,
  processPaymentWebhookService,
} from '../services/paymentService.js';
import { sendOrderReceiptEmail } from '../utils/notificationService.js';
import { notifyPaymentUpdate } from '../services/sseService.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// Initialize PostgreSQL connection pool and adapter for Prisma v7+
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * Initiate Mobile Money USSD Push (M-Pesa, Airtel Money, AzamPay)
 */
export const initiatePayment = async (req, res) => {
  // Force JSON headers to resolve "Unexpected end of JSON input" errors
  res.setHeader('Content-Type', 'application/json');

  try {
    const { orderId, phone, amount, provider } = req.body || {};

    // 1. Input Validation
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: orderId is required.',
      });
    }

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: phone number is required for USSD push.',
      });
    }

    // 2. Sanitize and normalize inputs
    const sanitizedPhone = String(phone).trim().replace(/\s+/g, '');
    const sanitizedProvider = String(provider || 'AIRTEL').trim().toUpperCase();
    const parsedAmount = amount ? parseFloat(amount) : undefined;

    // 3. Invoke Payment Gateway Service
    const result = await initiatePaymentService({
      orderId,
      phone: sanitizedPhone,
      amount: parsedAmount,
      provider: sanitizedProvider,
    });

    // 4. Guaranteed JSON payload structure sent back to frontend
    return res.status(200).json({
      success: true,
      message: result?.message || `Payment prompt dispatched successfully via ${sanitizedProvider}.`,
      data: result?.data || result || {},
    });

  } catch (error) {
    console.error('INITIATE PAYMENT CONTROLLER ERROR:', error.message || error);

    // Guaranteed JSON error object structure
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to dispatch payment prompt. Please verify your payment setup.',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};

/**
 * Handle Webhook Notifications from Payment Gateways
 */
export const handlePaymentWebhook = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    const signature =
      req.headers['x-signature'] ||
      req.headers['x-selcom-signature'] ||
      req.headers['x-azampay-signature'];

    const webhookPayload = req.body || {};

    // Process gateway callback payload
    const updatedOrder = await processPaymentWebhookService(webhookPayload, signature);

    if (updatedOrder && updatedOrder.id) {
      const isPaid = ['COMPLETED', 'PAID', 'SUCCESS'].includes(
        (updatedOrder.paymentStatus || '').toUpperCase()
      );

      // 1. Real-Time SSE notification to frontend client
      try {
        notifyPaymentUpdate(updatedOrder.id, {
          orderId: updatedOrder.id,
          status: updatedOrder.paymentStatus,
          orderStatus: updatedOrder.status,
          message: isPaid
            ? 'Payment processed successfully!'
            : 'Payment failed or was cancelled.',
        });
      } catch (sseErr) {
        console.error('SSE Notification Dispatch Error:', sseErr.message);
      }

      // 2. Non-blocking email receipt dispatch
      if (isPaid) {
        setImmediate(async () => {
          try {
            let recipientEmail = updatedOrder.user?.email || webhookPayload?.customerEmail;

            if (!recipientEmail && updatedOrder.userId) {
              const user = await prisma.user.findUnique({
                where: { id: updatedOrder.userId },
                select: { email: true },
              });
              recipientEmail = user?.email;
            }

            if (recipientEmail) {
              await sendOrderReceiptEmail(recipientEmail, {
                id: updatedOrder.id,
                orderNumber: updatedOrder.orderNumber || updatedOrder.id,
                totalAmount: updatedOrder.totalAmount,
                paymentStatus: updatedOrder.paymentStatus,
              });
            }
          } catch (emailErr) {
            console.error('Email Receipt Dispatch Error:', emailErr.message);
          }
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Payment webhook notification processed successfully.',
      data: updatedOrder
        ? {
            orderId: updatedOrder.id,
            paymentStatus: updatedOrder.paymentStatus,
            orderStatus: updatedOrder.status,
          }
        : null,
    });
  } catch (error) {
    console.error('PAYMENT WEBHOOK CONTROLLER ERROR:', error.message || error);

    return res.status(400).json({
      success: false,
      message: error.message || 'Error processing payment webhook notification.',
    });
  }
};