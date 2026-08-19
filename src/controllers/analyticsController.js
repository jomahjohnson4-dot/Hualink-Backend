import { prisma } from '../prismaClient.js';

// Get Business Analytics & Inventory Warnings
export const getAnalytics = async (req, res) => {
  try {
    // 1. Calculate Total Revenue (COMPLETED orders only)
    const completedRevenueResult = await prisma.order.aggregate({
      where: { paymentStatus: 'COMPLETED' },
      _sum: { totalAmount: true },
      _count: { id: true },
    });

    // 2. Calculate Pending Revenue (PENDING orders)
    const pendingRevenueResult = await prisma.order.aggregate({
      where: { paymentStatus: 'PENDING' },
      _sum: { totalAmount: true },
      _count: { id: true },
    });

    // 3. Find Products with Low Stock (Stock Count < 10)
    const LOW_STOCK_THRESHOLD = 10;
    const lowStockProducts = await prisma.product.findMany({
      where: {
        stockCount: {
          lt: LOW_STOCK_THRESHOLD,
        },
      },
      select: {
        id: true,
        name: true,
        category: true,
        stockCount: true,
        basePrice: true,
      },
      orderBy: { stockCount: 'asc' },
    });

    // 4. Calculate Total Unique Products in Inventory
    const totalProductsCount = await prisma.product.count();

    res.status(200).json({
      summary: {
        totalCompletedRevenue: completedRevenueResult._sum.totalAmount || 0,
        completedOrdersCount: completedRevenueResult._count.id,
        totalPendingRevenue: pendingRevenueResult._sum.totalAmount || 0,
        pendingOrdersCount: pendingRevenueResult._count.id,
        totalCatalogProducts: totalProductsCount,
      },
      inventoryAlerts: {
        threshold: LOW_STOCK_THRESHOLD,
        lowStockCount: lowStockProducts.length,
        items: lowStockProducts,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get total revenue and completed order count
export const getSalesOverview = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    const whereClause = {
      paymentStatus: 'COMPLETED',
      ...((startDate || endDate) && {
        createdAt: {
          ...(startDate && { gte: new Date(startDate) }),
          ...(endDate && { lte: new Date(endDate) }),
        },
      }),
    };

    const [salesAggregate, totalOrders] = await Promise.all([
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        _avg: { totalAmount: true },
        where: whereClause,
      }),
      prisma.order.count({ where: whereClause }),
    ]);

    res.json({
      totalRevenue: salesAggregate._sum.totalAmount || 0,
      averageOrderValue: salesAggregate._avg.totalAmount || 0,
      totalCompletedOrders: totalOrders,
    });
  } catch (error) {
    next(error);
  }
};

// Get top-selling products by quantity ordered
export const getTopSellingProducts = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 5;

    // Group order items by productId and sum quantities
    const groupedItems = await prisma.orderItem.groupBy({
      by: ['productId'],
      _sum: {
        quantity: true,
      },
      orderBy: {
        _sum: {
          quantity: 'desc',
        },
      },
      take: limit,
    });

    // Populate product details for top items
    const productIds = groupedItems.map((item) => item.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    const topProducts = groupedItems.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      return {
        product,
        totalQuantitySold: item._sum.quantity,
      };
    });

    res.json(topProducts);
  } catch (error) {
    next(error);
  }
};

// Get low-stock inventory alerts
export const getLowStockAlerts = async (req, res, next) => {
  try {
    const threshold = parseInt(req.query.threshold, 10) || 10;

    const lowStockProducts = await prisma.product.findMany({
      where: {
        stockCount: { lte: threshold },
      },
      orderBy: { stockCount: 'asc' },
    });

    res.json({
      threshold,
      count: lowStockProducts.length,
      products: lowStockProducts,
    });
  } catch (error) {
    next(error);
  }
};

// Combined Dashboard Overview
export const getDashboardSummary = async (req, res, next) => {
  try {
    const [sales, lowStock, totalProducts] = await Promise.all([
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: { paymentStatus: 'COMPLETED' },
      }),
      prisma.product.count({ where: { stockCount: { lte: 10 } } }),
      prisma.product.count(),
    ]);

    res.json({
      totalRevenue: sales._sum.totalAmount || 0,
      totalProducts,
      lowStockAlertsCount: lowStock,
    });
  } catch (error) {
    next(error);
  }
};