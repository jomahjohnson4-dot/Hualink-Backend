import crypto from 'crypto';
import { prisma } from '../utils/prismaClient.js';
import { sendSMS } from '../utils/smsService.js';
import { initiatePaymentService } from '../services/paymentService.js';
import { broadcastOrderStatus } from '../services/sseService.js';
import { notifyAdmins, notifyUser } from '../services/notificationService.js';

/**
 * Standard relation include configuration for fetching readable product details inside items.
 * Supports both `items` and `orderItems` schema variants dynamically.
 */
const orderIncludeWithProducts = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          image: true,
          sku: true,
          category: true,
          basePrice: true,
        },
      },
    },
  },
};

const orderIncludeWithOrderItems = {
  orderItems: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          image: true,
          sku: true,
          category: true,
          basePrice: true,
        },
      },
    },
  },
};

/**
 * Helper to execute Prisma queries supporting both `items` and `orderItems` relation names
 */
const queryWithFallback = async (primaryFn, fallbackFn) => {
  try {
    return await primaryFn();
  } catch (err) {
    // If Prisma error indicates missing relation field 'items', fallback to 'orderItems'
    if (err.message && (err.message.includes('items') || err.code === 'P2002' || err.code === 'P2009')) {
      return await fallbackFn();
    }
    throw err;
  }
};

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

    // 4. Extract product IDs cleanly
    const productIds = items
      .map((i) => i.productId || i.id)
      .filter((id) => id !== null && id !== undefined && id !== '');

    // 5. Execute DB Transaction (Create Order + Deduct Inventory Stock)
    let newOrder;
    try {
      newOrder = await prisma.$transaction(async (tx) => {
        // Fetch matching database products
        const dbProducts = productIds.length > 0 
          ? await tx.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, basePrice: true, stockCount: true, name: true, image: true },
            })
          : [];

        const productMap = new Map(
          dbProducts.map((p) => [
            p.id, 
            { 
              basePrice: Number(p.basePrice || 0), 
              stockCount: p.stockCount || 0, 
              name: p.name || 'Unknown Item',
              image: p.image || null
            }
          ])
        );

        // Construct order item payloads & check stock availability
        const orderItemsData = [];
        for (const item of items) {
          const pid = item.productId || item.id;
          const dbProduct = productMap.get(pid);
          
          const fallbackPrice = item.unitPrice ?? item.price ?? item.basePrice ?? 0;
          const finalUnitPrice = dbProduct ? dbProduct.basePrice : parseFloat(fallbackPrice);
          const qty = Math.max(1, parseInt(item.quantity || 1, 10));
          
          // Resolve product name string explicitly
          const resolvedName = dbProduct?.name || item.name || item.productName || 'Order Item';

          const orderItemPayload = {
            quantity: qty,
            unitPrice: finalUnitPrice,
            price: finalUnitPrice, // Backwards compatibility field
            name: resolvedName,
            productName: resolvedName, // Backwards compatibility field
            ...(pid ? { productId: pid } : {}),
          };

          orderItemsData.push(orderItemPayload);

          // Deduct inventory stock if product exists in Database
          if (dbProduct && pid) {
            await tx.product.update({
              where: { id: pid },
              data: { stockCount: { decrement: qty } },
            });
          }
        }

        // Compute total order amount safely
        const computedSubtotal = orderItemsData.reduce(
          (sum, item) => sum + item.quantity * item.unitPrice,
          0
        );
        const parsedTotal = totalAmount ? parseFloat(totalAmount) : computedSubtotal;

        const orderBaseData = {
          userId: userExists.id,
          orderNumber: `ORD-${Date.now()}`,
          totalAmount: parsedTotal,
          customerName: finalCustomerName,
          customerPhone: finalPhone,
          paymentMethod: paymentMethod || 'AIRTEL-MONEY',
          shippingAddress: finalAddress,
          region: finalRegion,
          status: 'PENDING',
          paymentStatus: 'PENDING',
        };

        // Attempt creation using `items` first, falling back to `orderItems` relation
        return await queryWithFallback(
          () =>
            tx.order.create({
              data: {
                ...orderBaseData,
                items: { create: orderItemsData },
              },
              include: orderIncludeWithProducts,
            }),
          () =>
            tx.order.create({
              data: {
                ...orderBaseData,
                orderItems: { create: orderItemsData },
              },
              include: orderIncludeWithOrderItems,
            })
        );
      });
    } catch (dbErr) {
      console.error('DATABASE TRANSACTION FAILED:', dbErr);
      return res.status(500).json({
        success: false,
        message: 'Failed to record order into database.',
        error: dbErr.message,
      });
    }

    // 6. Attempt Payment Initiation
    let paymentInitiated = false;
    let paymentWarning = null;

    if (finalPhone && finalPhone !== 'N/A') {
      try {
        await initiatePaymentService({
          orderId: newOrder.id,
          phone: finalPhone,
          amount: newOrder.totalAmount,
          provider: paymentMethod || 'AIRTEL-MONEY',
        });
        paymentInitiated = true;
      } catch (payErr) {
        console.warn('[PAYMENT INITIATION WARNING]:', payErr.message);
        paymentWarning = payErr.message;
      }
    }

    // 7. Send NextSMS confirmation asynchronously
    if (finalPhone && finalPhone !== 'N/A') {
      const smsMessage = `Habari ${finalCustomerName}, oda yako #${newOrder.orderNumber} ya TSH ${Number(
        newOrder.totalAmount
      ).toLocaleString()} imepokelewa. Hali: PENDING. Hualink.`;

      sendSMS(finalPhone, smsMessage).catch((err) =>
        console.error('SMS notification error:', err.message)
      );
    }

    // Normalize returned object so frontend always receives an `items` array
    const responseData = {
      ...newOrder,
      items: newOrder.items || newOrder.orderItems || [],
    };

    // 8. Return 201 Created Response
    return res.status(201).json({
      success: true,
      message: paymentInitiated
        ? 'Order created and payment prompt dispatched successfully.'
        : 'Order created successfully.',
      data: responseData,
      ...(paymentWarning && { paymentWarning }),
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
 * Retrieve user orders (Restricted by User Role, Includes Product Names)
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

    const rawOrders = await queryWithFallback(
      () =>
        prisma.order.findMany({
          where: whereClause,
          include: orderIncludeWithProducts,
          orderBy: { createdAt: 'desc' },
        }),
      () =>
        prisma.order.findMany({
          where: whereClause,
          include: orderIncludeWithOrderItems,
          orderBy: { createdAt: 'desc' },
        })
    );

    // Normalize response array so `items` is populated even if database uses `orderItems`
    const normalizedOrders = rawOrders.map((order) => ({
      ...order,
      items: order.items || order.orderItems || [],
    }));

    return res.status(200).json({ success: true, data: normalizedOrders });
  } catch (error) {
    next(error);
  }
};

export const getAllOrders = getOrders;

/**
 * Get order by ID with ownership check (Includes Detailed Product Names)
 */
export const getOrderById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const userRole = (req.user?.role || '').toUpperCase();

    const order = await queryWithFallback(
      () =>
        prisma.order.findUnique({
          where: { id },
          include: orderIncludeWithProducts,
        }),
      () =>
        prisma.order.findUnique({
          where: { id },
          include: orderIncludeWithOrderItems,
        })
    );

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Access control: allow owner or admin only
    if (order.userId && order.userId !== userId && userRole !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const normalizedOrder = {
      ...order,
      items: order.items || order.orderItems || [],
    };

    return res.status(200).json({ success: true, data: normalizedOrder });
  } catch (error) {
    next(error);
  }
};

/**
 * Canonical order lifecycle stages, plus the friendly aliases the admin
 * dashboard uses ("Dispatched", "In Transit", ...).
 */
const ORDER_STATUS_ALIASES = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PROCESSING: 'PROCESSING',
  DISPATCHED: 'SHIPPED',
  SHIPPED: 'SHIPPED',
  'IN TRANSIT': 'OUT_FOR_DELIVERY',
  'OUT FOR DELIVERY': 'OUT_FOR_DELIVERY',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  CANCELED: 'CANCELLED',
  PAID: 'PAID',
  FAILED: 'FAILED',
};

/**
 * Human readable labels for the lifecycle stages. These are the names the
 * customer sees in the notification bell and the live route tracking.
 */
const ORDER_STATUS_LABELS = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  SHIPPED: 'Dispatched',
  OUT_FOR_DELIVERY: 'In Transit',
  DELIVERED: 'Delivered',
  PAID: 'Delivered',
  CANCELLED: 'Cancelled',
  FAILED: 'Cancelled',
};

/** Resolves a lifecycle stage to its customer-facing label. */
export const orderStatusLabel = (status) =>
  ORDER_STATUS_LABELS[String(status || '').toUpperCase()] ||
  String(status || '').replace(/_/g, ' ');

/**
 * Resolves a user supplied status label to a valid Prisma enum value.
 * Returns `null` when the label is unknown.
 */
export const resolveOrderStatus = (raw) => {
  const key = String(raw || '')
    .trim()
    .toUpperCase();
  return ORDER_STATUS_ALIASES[key] || null;
};

/**
 * Update order status & send SMS update notification
 */
export const updateOrderStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus } = req.body;

    const resolvedStatus = resolveOrderStatus(status);
    if (!resolvedStatus) {
      return res.status(400).json({
        success: false,
        message: `Invalid order status. Expected one of: ${Object.keys(ORDER_STATUS_ALIASES).join(', ')}.`,
      });
    }

    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const updatedOrder = await queryWithFallback(
      () =>
        prisma.order.update({
          where: { id },
          data: {
            status: resolvedStatus,
            ...(paymentStatus && { paymentStatus }),
          },
          include: orderIncludeWithProducts,
        }),
      () =>
        prisma.order.update({
          where: { id },
          data: {
            status: resolvedStatus,
            ...(paymentStatus && { paymentStatus }),
          },
          include: orderIncludeWithOrderItems,
        })
    );

    // Push the new stage to any client watching live route tracking.
    broadcastOrderStatus(updatedOrder);

    // Log the status change for the customer and in the admin activity stream.
    const statusLabel = orderStatusLabel(resolvedStatus);
    const previousLabel = orderStatusLabel(existing.status);
    const orderRef = updatedOrder.orderNumber || updatedOrder.id;

    await notifyUser(updatedOrder.userId, {
      type: 'ORDER',
      title: `Order ${orderRef} is now ${statusLabel}`,
      message: `Your order #${orderRef} moved from ${previousLabel} to ${statusLabel}. Track it live from the Orders page.`,
    }).catch((error) =>
      console.error('[Notification] Order customer event failed:', error?.message)
    );

    await notifyAdmins({
      type: 'ORDER',
      title: 'Order Status Updated',
      message: `Order #${orderRef} was moved from ${previousLabel} to ${statusLabel}.`,
    }).catch((error) =>
      console.error('[Notification] Order admin event failed:', error?.message)
    );

    // Send Status Update Notification via NextSMS
    if (updatedOrder.customerPhone && updatedOrder.customerPhone !== 'N/A') {
      const smsMessage = `Habari ${updatedOrder.customerName}, hali ya oda yako #${updatedOrder.orderNumber} imebadilishwa kuwa: ${resolvedStatus}. Ahsante kwa kutumia Hualink!`;
      sendSMS(updatedOrder.customerPhone, smsMessage).catch((err) =>
        console.error('SMS notification error:', err.message)
      );
    }

    const normalizedOrder = {
      ...updatedOrder,
      items: updatedOrder.items || updatedOrder.orderItems || [],
    };

    return res.status(200).json({
      success: true,
      message: `Order status updated to ${resolvedStatus}.`,
      data: normalizedOrder,
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    next(error);
  }
};

/**
 * Secure Payment Webhook Handler (Accepts ID or OrderNumber)
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

    const { orderId, externalId, status, transactionId, transactionRef } = req.body;
    const identifier = orderId || externalId;

    if (!identifier || !status) {
      return res.status(400).json({
        success: false,
        message: 'Missing required order identifier (orderId/externalId) or status parameter',
      });
    }

    const ref = transactionRef || transactionId;

    // Find target order by UUID primary key or orderNumber
    const existingOrder = await prisma.order.findFirst({
      where: {
        OR: [{ id: identifier }, { orderNumber: identifier }],
      },
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: `Order with identifier ${identifier} not found`,
      });
    }

    const isSuccess = ['SUCCESS', 'COMPLETED', 'PAID', 'SUCCESSFUL'].includes(
      status.toUpperCase()
    );

    const updatedOrder = await queryWithFallback(
      () =>
        prisma.order.update({
          where: { id: existingOrder.id },
          data: {
            paymentStatus: isSuccess ? 'PAID' : 'FAILED',
            ...(isSuccess ? { status: 'CONFIRMED' } : {}),
            ...(ref && { transactionRef: ref }),
          },
          include: orderIncludeWithProducts,
        }),
      () =>
        prisma.order.update({
          where: { id: existingOrder.id },
          data: {
            paymentStatus: isSuccess ? 'PAID' : 'FAILED',
            ...(isSuccess ? { status: 'CONFIRMED' } : {}),
            ...(ref && { transactionRef: ref }),
          },
          include: orderIncludeWithOrderItems,
        })
    );

    const normalizedOrder = {
      ...updatedOrder,
      items: updatedOrder.items || updatedOrder.orderItems || [],
    };

    return res.status(200).json({
      success: true,
      message: 'Payment status verified and updated successfully',
      data: normalizedOrder,
    });
  } catch (error) {
    next(error);
  }
};