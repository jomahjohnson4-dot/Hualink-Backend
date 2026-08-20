import { prisma } from '../utils/prismaClient.js';

/**
 * Update stock counts and warehouse assignments for products (Admin/Supplier)
 */
export const updateStockService = async ({ productId, stockCount, warehouseLocation }) => {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!product) {
    throw new Error(`Product not found (ID: ${productId})`);
  }

  const updatedProduct = await prisma.product.update({
    where: { id: productId },
    data: {
      ...(stockCount !== undefined && { stockCount: parseInt(stockCount, 10) }),
      ...(warehouseLocation && { warehouseLocation }),
    },
  });

  return updatedProduct;
};

/**
 * Fetch low-stock products across warehouses for inventory reorder triggers
 */
export const getLowStockProductsService = async (threshold = 10) => {
  const lowStockProducts = await prisma.product.findMany({
    where: {
      stockCount: {
        lte: parseInt(threshold, 10),
      },
    },
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          companyName: true,
          email: true,
          phone: true,
        },
      },
    },
    orderBy: {
      stockCount: 'asc',
    },
  });

  return lowStockProducts;
};