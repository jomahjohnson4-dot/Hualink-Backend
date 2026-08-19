import crypto from 'crypto';
import { prisma } from '../prismaClient.js';

// Create a new order safely
export const createOrder = async (req, res, next) => {
  try {
    const rawUserId = req.user?.id;
    const {
      items,
      totalAmount,
      customerDetails,
      shippingDetails,
      paymentMethod,
      customerPhone,
      phone,
      shippingAddress,
      region,
    } = req.body;

    // 1. Guard against empty items array
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Order must contain at least one valid item.',
      });
    }

    // 2. Resolve field naming variations
    const finalPhone = customerPhone || phone || customerDetails?.phone || 'N/A';
    const finalAddress =
      shippingAddress || shippingDetails?.address || customerDetails?.address || 'Default Address';
    const finalRegion = region || shippingDetails?.region || 'Dar es Salaam';

    // 3. Compute total order amount safely
    const parsedTotal = totalAmount
      ? parseFloat(totalAmount)
      : items.reduce(
          (sum, item) =>
            sum +
            parseInt(item.quantity || 1, 10) *
              parseFloat(item.price || item.unitPrice || 0),
          0
        );

    // 4. Verify user exists in User table to prevent P2003 foreign key crash
    let validUserId = null;
    if (rawUserId) {
      const userExists = await prisma.user.findUnique({
        where: { id: rawUserId },
        select: { id: true },
      });
      if (userExists) {
        validUserId = userExists.id;
      }
    }

    // 5. Construct item payloads safely
    const orderItemsData = items.map((item) => ({
      productId: item.productId || item.id,
      quantity: parseInt(item.quantity || 1, 10),
      unitPrice: parseFloat(item.price || item.unitPrice || 0),
    }));

    // 6. Database record creation
    const newOrder = await prisma.order.create({
      data: {
        ...(validUserId && { userId: validUserId }),
        totalAmount: parsedTotal,
        customerPhone: finalPhone,
        paymentMethod: paymentMethod || 'CASH',
        shippingAddress: finalAddress,
        region: finalRegion,
        items: {
          create: orderItemsData,
        },
      },
      include: { items: true },
    });

    return res.status(201).json({ success: true, data: newOrder });
  } catch (error) {
    console.error('CREATE ORDER ERROR DETAILED:', error);

    // Provide explicit error payload for rapid debugging
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error while placing order.',
      code: error.code || null,
      meta: error.meta || null,
    });
  }
};

// Get all orders (Restricted by User Role)
export const getOrders = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const userRole = (req.user?.role || '').toUpperCase();

    // Standard users retrieve their own orders; admins retrieve all
    const whereClause = userRole === 'ADMIN' ? {} : { userId };

    const orders = await prisma.order.findMany({
      where: whereClause,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    next(error);
  }
};

// Backwards compatibility alias
export const getAllOrders = getOrders;

// Get order by ID
export const getOrderById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const userRole = (req.user?.role || '').toUpperCase();

    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Access control: allow owner or admin only
    if (order.userId && order.userId !== userId && userRole !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

// Update order status
export const updateOrderStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus } = req.body;

    const updatedOrder = await prisma.order.update({
      where: { id },
      data: {
        ...(status && { status }),
        ...(paymentStatus && { paymentStatus }),
      },
      include: { items: true },
    });

    return res.status(200).json({ success: true, data: updatedOrder });
  } catch (error) {
    next(error);
  }
};

// Secure Payment Webhook Handler
export const handlePaymentWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-signature'];
    const webhookSecret = process.env.WEBHOOK_SECRET;

    // HMAC Signature Validation
    if (webhookSecret) {
      if (!signature) {
        return res
          .status(401)
          .json({ success: false, message: 'Missing webhook signature header' });
      }

      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (signature !== expectedSignature) {
        return res
          .status(401)
          .json({ success: false, message: 'Invalid payload signature' });
      }
    }

    const { orderId, status, transactionId, transactionRef } = req.body;

    if (!orderId || !status) {
      return res.status(400).json({
        success: false,
        message: 'Missing required orderId or status parameter',
      });
    }

    const ref = transactionRef || transactionId;

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: status,
        ...(ref && { transactionRef: ref }),
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Payment status verified and updated successfully',
      data: updatedOrder,
    });
  } catch (error) {
    next(error);
  }
};