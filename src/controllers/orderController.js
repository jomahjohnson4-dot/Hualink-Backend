import crypto from 'crypto';
import { prisma } from '../utils/prismaClient.js';

/**
 * Create a new order tied to an authenticated user
 */
export const createOrder = async (req, res, next) => {
  try {
    const rawUserId = req.user?.id;

    // Reject request if user is not authenticated
    if (!rawUserId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in to place an order.',
      });
    }

    const {
      items,
      totalAmount,
      customerDetails,
      shippingDetails,
      paymentMethod,
      customerPhone,
      phone,
      shippingAddress,
      deliveryAddress,
      region,
      deliveryRegion,
      customerName,
    } = req.body;

    // 1. Guard against empty items array
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Order must contain at least one valid item.',
      });
    }

    // 2. Resolve field naming variations between frontend payload and backend schema
    const finalPhone = customerPhone || phone || customerDetails?.phone || 'N/A';
    const finalAddress =
      deliveryAddress || shippingAddress || shippingDetails?.address || customerDetails?.address || 'Default Address';
    const finalRegion = deliveryRegion || region || shippingDetails?.region || 'Dar es Salaam';
    const finalCustomerName = customerName || customerDetails?.name || req.user?.name || 'Customer';

    // 3. Verify user exists in User table
    const userExists = await prisma.user.findUnique({
      where: { id: rawUserId },
      select: { id: true },
    });

    if (!userExists) {
      return res.status(404).json({
        success: false,
        message: 'User account not found. Please log in again.',
      });
    }

    // 4. Extract product IDs and fetch prices from Database if not provided
    const productIds = items.map((i) => i.productId || i.id).filter(Boolean);
    const dbProducts = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, price: true },
    });

    const productMap = new Map(dbProducts.map((p) => [p.id, Number(p.price)]));

    // Construct item payloads safely
    const orderItemsData = items.map((item) => {
      const pid = item.productId || item.id;
      const dbPrice = productMap.get(pid);
      const fallbackPrice = item.unitPrice ?? item.price ?? 0;
      const finalUnitPrice = dbPrice !== undefined ? dbPrice : parseFloat(fallbackPrice);

      return {
        productId: pid,
        quantity: parseInt(item.quantity || 1, 10),
        unitPrice: finalUnitPrice,
      };
    });

    // 5. Compute total order amount safely
    const computedSubtotal = orderItemsData.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0
    );
    const parsedTotal = totalAmount ? parseFloat(totalAmount) : computedSubtotal;

    // 6. Database record creation
    const newOrder = await prisma.order.create({
      data: {
        userId: userExists.id,
        orderNumber: `ORD-${Date.now()}`,
        totalAmount: parsedTotal,
        customerName: finalCustomerName,
        customerPhone: finalPhone,
        paymentMethod: paymentMethod || 'M-PESA',
        shippingAddress: finalAddress,
        region: finalRegion,
        status: 'PENDING',
        items: {
          create: orderItemsData,
        },
      },
      include: { items: true },
    });

    return res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: newOrder,
    });
  } catch (error) {
    console.error('CREATE ORDER ERROR DETAILED:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error while placing order.',
      code: error.code || null,
      meta: error.meta || null,
    });
  }
};

/**
 * Retrieve user orders (Restricted by User Role)
 */
export const getOrders = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const userRole = (req.user?.role || '').toUpperCase();

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

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

export const getAllOrders = getOrders;

/**
 * Get order by ID with ownership check
 */
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

/**
 * Update order status
 */
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

/**
 * Secure Payment Webhook Handler
 */
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