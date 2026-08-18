const prisma = require('../prismaClient');

// Create a new customer order and decrease stock inside an interactive transaction
exports.createOrder = async (req, res, next) => {
  const { customerPhone, paymentMethod, items } = req.body;

  try {
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Order items array cannot be empty.' });
    }

    const orderNumber = `HL-${Date.now()}`;

    // Run interactive transaction
    const newOrder = await prisma.$transaction(async (tx) => {
      let totalAmount = 0;
      const orderItemsData = [];

      for (const item of items) {
        const quantity = parseInt(item.quantity, 10);

        // 1. Fetch item & verify existence
        const product = await tx.product.findUnique({
          where: { id: item.productId }
        });

        if (!product) {
          throw new Error(`Product with ID ${item.productId} was not found.`);
        }

        // 2. Validate sufficient stock
        if (product.stockCount < quantity) {
          throw new Error(
            `Insufficient stock for "${product.name}". Requested: ${quantity}, Available: ${product.stockCount}`
          );
        }

        // 3. Decrement stock atomically
        await tx.product.update({
          where: { id: item.productId },
          data: {
            stockCount: { decrement: quantity }
          }
        });

        // 4. Calculate pricing from database basePrice
        const unitPrice = parseFloat(item.unitPrice || product.basePrice);
        totalAmount += unitPrice * quantity;

        orderItemsData.push({
          productId: product.id,
          quantity,
          unitPrice
        });
      }

      // 5. Create the Order with nested items
      const order = await tx.order.create({
        data: {
          orderNumber,
          customerPhone: customerPhone || null,
          paymentMethod: paymentMethod || 'CASH',
          paymentStatus: 'PENDING',
          totalAmount,
          items: {
            create: orderItemsData
          }
        },
        include: {
          items: {
            include: { product: true }
          }
        }
      });

      return order;
    });

    res.status(201).json({
      message: 'Order placed successfully',
      order: newOrder
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Get all orders with optional status, phone, and date filters
exports.getOrders = async (req, res, next) => {
  const { paymentStatus, phone, startDate, endDate, page = 1, limit = 10 } = req.query;

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  try {
    const whereClause = {
      ...(paymentStatus && { paymentStatus: paymentStatus.toUpperCase() }),
      ...(phone && { customerPhone: { contains: phone } }),
      ...((startDate || endDate) && {
        createdAt: {
          ...(startDate && { gte: new Date(startDate) }),
          ...(endDate && { lte: new Date(endDate) })
        }
      })
    };

    const [orders, totalCount] = await Promise.all([
      prisma.order.findMany({
        where: whereClause,
        include: {
          items: {
            include: { product: true }
          }
        },
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.order.count({ where: whereClause })
    ]);

    res.status(200).json({
      data: orders,
      pagination: {
        totalItems: totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
        currentPage: pageNum,
        pageSize: limitNum
      }
    });
  } catch (error) {
    next(error);
  }
};

// Fetch order details by ID
exports.getOrderById = async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          include: { product: true }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    res.json(order);
  } catch (error) {
    next(error);
  }
};

// Handle Payment Callback / Webhook
exports.handlePaymentWebhook = async (req, res, next) => {
  const { orderNumber, transactionRef, status } = req.body;

  try {
    if (!orderNumber || !status) {
      return res.status(400).json({ error: 'Missing orderNumber or status in webhook payload.' });
    }

    const updatedOrder = await prisma.order.update({
      where: { orderNumber },
      data: {
        paymentStatus: status.toUpperCase(), // e.g., "COMPLETED" or "FAILED"
        transactionRef: transactionRef || null
      }
    });

    res.status(200).json({
      message: 'Payment status updated successfully',
      order: updatedOrder
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};