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

export const initiatePayment = async (req, res, next) => {
  try {
    const { orderId, phone, amount, provider } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId is required.' });
    }

    const result = await initiatePaymentService({ orderId, phone, amount, provider });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const handlePaymentWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-signature'] || req.headers['x-selcom-signature'];
    const updatedOrder = await processPaymentWebhookService(req.body, signature);

    if (updatedOrder) {
      // 1. Emit instant SSE notification to frontend client streaming this order
      notifyPaymentUpdate(updatedOrder.id, {
        orderId: updatedOrder.id,
        status: updatedOrder.paymentStatus,
        orderStatus: updatedOrder.status,
        message: ['COMPLETED', 'PAID'].includes(updatedOrder.paymentStatus)
          ? 'Payment processed successfully!'
          : 'Payment failed or declined.',
      });

      // 2. Dispatch email receipt non-blockingly if payment was marked COMPLETED or PAID
      if (['COMPLETED', 'PAID'].includes(updatedOrder.paymentStatus)) {
        (async () => {
          try {
            // Fetch customer email via relation if not present directly on order object
            let recipientEmail = updatedOrder.user?.email || req.body?.customerEmail;

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
                totalAmount: updatedOrder.totalAmount,
                paymentStatus: updatedOrder.paymentStatus,
              });
            }
          } catch (emailErr) {
            console.error('Email dispatch notification error:', emailErr.message);
          }
        })();
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Payment notification processed successfully.',
      data: {
        orderId: updatedOrder.id,
        paymentStatus: updatedOrder.paymentStatus,
        orderStatus: updatedOrder.status,
      },
    });
  } catch (error) {
    console.error('PAYMENT WEBHOOK ERROR:', error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};