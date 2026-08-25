import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import dotenv from 'dotenv';
import { validateOrderPayload } from '../middleware/orderValidation.js';
import { verifyToken } from '../middleware/auth.js';
import { sendSMS } from '../utils/smsService.js';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const router = Router();
const paymentClients = new Map();

/**
 * Helper to format phone number to international format (255XXXXXXXXX)
 */
const formatTanzaniaPhone = (phone) => {
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '255' + cleaned.substring(1);
  }
  return cleaned;
};

/**
 * Map frontend payment method strings AND phone number prefixes to AzamPay Provider codes
 */
const getAzamPayProvider = (method, phoneNumber = '') => {
  const normalized = String(method || '').toUpperCase();
  const cleanedPhone = formatTanzaniaPhone(phoneNumber);

  // 1. Check explicit provider string from frontend
  if (normalized.includes('AIRTEL')) return 'AIRTEL';
  if (normalized.includes('MPESA') || normalized.includes('M-PESA') || normalized.includes('VODACOM')) return 'M-PESA';
  if (normalized.includes('HALO') || normalized.includes('HALOPESA')) return 'HALOPESA';
  if (normalized.includes('TIGO') || normalized.includes('YAS') || normalized.includes('MIXX')) return 'TIGO';
  if (normalized.includes('AZAM')) return 'AZAMPAY';

  // 2. Fallback: Auto-detect provider directly from Tanzanian phone prefixes
  if (/^255(78|68|69)/.test(cleanedPhone)) return 'AIRTEL';
  if (/^255(74|75|76)/.test(cleanedPhone)) return 'M-PESA';
  if (/^255(65|67|71|77)/.test(cleanedPhone)) return 'TIGO';
  if (/^25562/.test(cleanedPhone)) return 'HALOPESA';

  return 'M-PESA';
};

/**
 * Helper function to trigger AzamPay Sandbox payment gateway USSD push API
 */
const initiateMobileMoneyPush = async ({ phoneNumber, amount, orderNumber, paymentMethod }) => {
  const formattedPhone = formatTanzaniaPhone(phoneNumber);
  const provider = getAzamPayProvider(paymentMethod, phoneNumber);

  console.log(`[AZAMPAY SANDBOX] Initiating ${provider} push to ${formattedPhone} for ${amount} TZS`);

  if (process.env.AZAMPAY_AUTH_TOKEN) {
    const response = await fetch('https://sandbox.azampay.co.tz/azampay/mno/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AZAMPAY_AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        accountNumber: formattedPhone,
        amount: amount.toString(),
        currency: 'TZS',
        externalId: orderNumber,
        provider: provider,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `AzamPay push failed for provider ${provider}`);
    }

    return { ...data, resolvedProvider: provider };
  }

  console.warn('[PAYMENT GATEWAY] Missing AZAMPAY_AUTH_TOKEN in .env file.');
  return { success: true, message: 'Mock USSD prompt dispatched', resolvedProvider: provider };
};

/**
 * Create a new order using Prisma Client
 */
export const createOrder = async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const {
      customerName,
      customerPhone,
      deliveryRegion,
      deliveryAddress,
      paymentMethod,
      totalAmount,
      items,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Cart items are required.' });
    }

    const calculatedTotal = Number(totalAmount);
    if (calculatedTotal <= 0) {
      return res.status(400).json({ message: 'Order total amount must be greater than 0 TZS.' });
    }

    const orderNumber = `HL-${Date.now().toString().slice(-6)}`;
    const resolvedProvider = getAzamPayProvider(paymentMethod, customerPhone);

    // Verify user exists in database
    let validUserId = null;
    if (userId) {
      const existingUser = await prisma.user.findUnique({ where: { id: userId } });
      if (existingUser) validUserId = existingUser.id;
    }

    // 1. Create Order in database
    const newOrder = await prisma.order.create({
      data: {
        orderNumber,
        ...(validUserId && { userId: validUserId }),
        customerName: customerName || 'Valued Customer',
        customerPhone,
        region: deliveryRegion || 'Dar es Salaam',
        shippingAddress: deliveryAddress || 'N/A',
        paymentMethod: resolvedProvider,
        totalAmount: calculatedTotal,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: Number(item.unitPrice ?? item.price),
          })),
        },
      },
      include: { items: true },
    });

    // 2. Trigger USSD push to customer's phone
    try {
      await initiateMobileMoneyPush({
        phoneNumber: customerPhone,
        amount: calculatedTotal,
        orderNumber: newOrder.orderNumber,
        paymentMethod: resolvedProvider,
      });
    } catch (payErr) {
      console.error('Failed to dispatch payment prompt:', payErr.message || payErr);

      await prisma.order.update({
        where: { id: newOrder.id },
        data: { status: 'CANCELLED', paymentStatus: 'FAILED' },
      });

      return res.status(400).json({
        success: false,
        message: `Failed to dispatch ${resolvedProvider} payment prompt: ${payErr.message}`,
      });
    }

    // 3. Send Order Confirmation via NextSMS (Non-blocking)
    if (customerPhone) {
      const smsMessage = `Habari ${newOrder.customerName}, oda yako #${newOrder.orderNumber} ya TSH ${calculatedTotal.toLocaleString()} imepokelewa. Tafadhali thibitisha malipo kwenye simu yako. Hualink.`;
      sendSMS(customerPhone, smsMessage).catch((err) =>
        console.error('[SMS Dispatch Error]:', err.message || err)
      );
    }

    res.status(201).json({
      success: true,
      message: `Order placed successfully. Please check your ${resolvedProvider} phone for the payment prompt.`,
      data: {
        id: newOrder.id,
        orderId: newOrder.id,
        orderNumber: newOrder.orderNumber,
        paymentMethod: resolvedProvider,
        status: newOrder.status,
        totalAmount: newOrder.totalAmount,
      },
    });
  } catch (error) {
    console.error('Prisma Error (Create Order):', error);
    res.status(500).json({ message: 'Internal server error while placing order.' });
  }
};

/**
 * Retrieve user orders (or all orders if admin)
 */
export const getOrders = async (req, res) => {
  try {
    const userId = req.user?.id;
    const userRole = req.user?.role;
    const userPhone = req.user?.phone;

    let where = {};

    if (userRole !== 'ADMIN' && userRole !== 'admin') {
      const conditions = [];
      if (userId) conditions.push({ userId });
      if (userPhone) conditions.push({ customerPhone: userPhone });
      where = conditions.length > 0 ? { OR: conditions } : {};
    }

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });

    res.status(200).json({ data: orders });
  } catch (error) {
    console.error('Fetch Orders Error:', error);
    res.status(500).json({ message: 'Error retrieving orders.' });
  }
};

/**
 * Retrieve specific order by ID
 */
export const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const userRole = req.user?.role;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (order.userId && order.userId !== userId && userRole !== 'ADMIN' && userRole !== 'admin') {
      return res.status(403).json({ message: 'Access denied.' });
    }

    res.status(200).json({ data: order });
  } catch (error) {
    console.error('Fetch Order Error:', error);
    res.status(500).json({ message: 'Error retrieving order details.' });
  }
};

/**
 * SSE Endpoint for streaming payment updates to the frontend
 */
export const streamPaymentStatus = (req, res) => {
  const { orderId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  paymentClients.set(String(orderId), res);

  req.on('close', () => {
    paymentClients.delete(String(orderId));
  });
};

/**
 * Payment gateway callback handler (updates DB & notifies SSE clients)
 */
export const handlePaymentWebhook = async (req, res) => {
  try {
    const payload = req.body || {};

    const targetIdentifier = payload.orderId || payload.externalId || payload.utilityref;
    const rawStatus = String(payload.status || payload.transactionstatus || 'PAID').toUpperCase();

    if (!targetIdentifier) {
      return res.status(400).json({ message: 'Invalid webhook payload. Missing order identifier.' });
    }

    let existingOrder = await prisma.order.findFirst({
      where: {
        OR: [
          { id: targetIdentifier },
          { orderNumber: targetIdentifier },
        ],
      },
    });

    if (!existingOrder) {
      return res.status(404).json({ message: `Order '${targetIdentifier}' not found in database.` });
    }

    const isSuccess = ['COMPLETED', 'SUCCESS', 'PAID', 'SUCCESSFUL'].includes(rawStatus);
    const newStatus = isSuccess ? 'PAID' : 'FAILED';

    const updatedOrder = await prisma.order.update({
      where: { id: existingOrder.id },
      data: {
        status: isSuccess ? 'PROCESSING' : 'CANCELLED',
        paymentStatus: newStatus,
      },
    });

    // Send payment outcome SMS to customer via NextSMS
    if (updatedOrder.customerPhone) {
      const smsMessage = isSuccess
        ? `Habari ${updatedOrder.customerName}, malipo ya oda yako #${updatedOrder.orderNumber} yamefanikiwa! Oda yako inashughulikiwa. Hualink.`
        : `Habari ${updatedOrder.customerName}, malipo ya oda yako #${updatedOrder.orderNumber} yameshindikana. Tafadhali jaribu tena. Hualink.`;

      sendSMS(updatedOrder.customerPhone, smsMessage).catch((err) =>
        console.error('[SMS Webhook Notification Error]:', err.message || err)
      );
    }

    // Notify active SSE stream connections
    const clientRes = paymentClients.get(String(updatedOrder.id));
    if (clientRes) {
      clientRes.write(`data: ${JSON.stringify({ orderId: updatedOrder.id, status: newStatus })}\n\n`);
    }

    res.status(200).json({
      message: 'Webhook processed successfully',
      data: { orderId: updatedOrder.id, paymentStatus: updatedOrder.paymentStatus },
    });
  } catch (error) {
    console.error('Webhook Error Details:', error);
    res.status(500).json({ message: 'Error processing webhook.', error: error.message });
  }
};

// -----------------------------------------------------------------------------
// ROUTE DEFINITIONS
// -----------------------------------------------------------------------------

router.post('/payment-webhook', handlePaymentWebhook);
router.get('/payments/stream/:orderId', streamPaymentStatus);

router.use(verifyToken);

router.post('/', validateOrderPayload, createOrder);
router.get('/', getOrders);
router.get('/:id', getOrderById);

export default router;