import { prisma } from '../utils/prismaClient.js';

/**
 * Executes secure order placement inside an atomic Prisma transaction.
 * Product prices and stock are validated directly against PostgreSQL to ensure integrity.
 */
export const createOrderService = async ({
  userId,
  customerPhone,
  paymentMethod,
  shippingAddress,
  region,
  items,
}) => {
  return await prisma.$transaction(async (tx) => {
    let totalAmount = 0;
    const orderItemsData = [];

    for (const item of items) {
      const targetProductId = item.productId || item.id;

      if (!targetProductId) {
        throw new Error('Each item must include a valid productId.');
      }

      // 1. Fetch live product from DB to protect price integrity
      const product = await tx.product.findUnique({
        where: { id: targetProductId },
      });

      if (!product) {
        throw new Error(`Product not found (ID: ${targetProductId}).`);
      }

      const requestedQty = parseInt(item.quantity || 1, 10);

      if (requestedQty <= 0) {
        throw new Error(`Invalid quantity for product "${product.name}".`);
      }

      // 2. Validate inventory count
      if (product.stockCount < requestedQty) {
        throw new Error(
          `Insufficient stock for "${product.name}". Available: ${product.stockCount}, requested: ${requestedQty}.`
        );
      }

      // 3. Wholesale vs Retail unit pricing logic
      let unitPrice = Number(product.basePrice);
      if (
        product.wholesalePrice &&
        product.minWholesaleQty &&
        requestedQty >= product.minWholesaleQty
      ) {
        unitPrice = Number(product.wholesalePrice);
      }

      totalAmount += unitPrice * requestedQty;

      orderItemsData.push({
        productId: product.id,
        quantity: requestedQty,
        unitPrice,
      });

      // 4. Atomic inventory reduction
      await tx.product.update({
        where: { id: product.id },
        data: {
          stockCount: {
            decrement: requestedQty,
          },
        },
      });
    }

    // 5. Generate human-readable order string
    const orderNumber = `HU-${Math.floor(100000 + Math.random() * 900000)}`;

    // 6. Create order with price snapshot records
    const order = await tx.order.create({
      data: {
        orderNumber,
        customerPhone,
        totalAmount,
        paymentMethod: paymentMethod || 'MANUAL_MOBILE',
        shippingAddress: shippingAddress || 'Default Address',
        region: region || 'Dar es Salaam',
        ...(userId && { userId }),
        items: {
          create: orderItemsData,
        },
      },
      include: {
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    return order;
  });
};