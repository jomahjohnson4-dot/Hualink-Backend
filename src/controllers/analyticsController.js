import { prisma } from '../utils/prismaClient.js';
import {
  getDashboardAnalyticsService,
  forecastRevenueService,
} from '../services/analyticsService.js';

/**
 * Detailed Analytics & Inventory Warning Summary
 */
export const getAnalytics = async (req, res, next) => {
  try {
    const LOW_STOCK_THRESHOLD = 10;

    const [paidRevenueResult, pendingRevenueResult, lowStockProducts, totalProductsCount] =
      await Promise.all([
        // 1. Paid Revenue (Matches updated PaymentStatus enum: PAID)
        prisma.order.aggregate({
          where: { paymentStatus: 'PAID' },
          _sum: { totalAmount: true },
          _count: { id: true },
        }),
        // 2. Pending Revenue
        prisma.order.aggregate({
          where: { paymentStatus: 'PENDING' },
          _sum: { totalAmount: true },
          _count: { id: true },
        }),
        // 3. Low Stock Items
        prisma.product.findMany({
          where: { stockCount: { lt: LOW_STOCK_THRESHOLD } },
          select: {
            id: true,
            name: true,
            category: true,
            stockCount: true,
            basePrice: true,
            warehouseLocation: true,
          },
          orderBy: { stockCount: 'asc' },
        }),
        // 4. Total Catalog Products Count
        prisma.product.count(),
      ]);

    return res.status(200).json({
      success: true,
      summary: {
        totalPaidRevenue: paidRevenueResult._sum.totalAmount || 0,
        paidOrdersCount: paidRevenueResult._count.id,
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
    next(error);
  }
};

/**
 * Filtered Sales Overview (Supports Date Range)
 */
export const getSalesOverview = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    const whereClause = {
      paymentStatus: 'PAID',
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

    return res.status(200).json({
      success: true,
      data: {
        totalRevenue: salesAggregate._sum.totalAmount || 0,
        averageOrderValue: salesAggregate._avg.totalAmount || 0,
        totalCompletedOrders: totalOrders,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Top-Selling Products by Volume
 */
export const getTopSellingProducts = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 5;

    const groupedItems = await prisma.orderItem.groupBy({
      by: ['productId'],
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    const productIds = groupedItems.map((item) => item.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    const topProducts = groupedItems.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      return {
        product: product || null,
        totalQuantitySold: item._sum.quantity || 0,
      };
    });

    return res.status(200).json({
      success: true,
      data: topProducts,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Low-Stock Inventory Alerts
 */
export const getLowStockAlerts = async (req, res, next) => {
  try {
    const threshold = parseInt(req.query.threshold, 10) || 10;

    const lowStockProducts = await prisma.product.findMany({
      where: { stockCount: { lte: threshold } },
      orderBy: { stockCount: 'asc' },
    });

    return res.status(200).json({
      success: true,
      threshold,
      count: lowStockProducts.length,
      products: lowStockProducts,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Combined Executive Dashboard Overview
 */
export const getDashboardSummary = async (req, res, next) => {
  try {
    const [sales, lowStock, totalProducts] = await Promise.all([
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: { paymentStatus: 'PAID' },
      }),
      prisma.product.count({ where: { stockCount: { lte: 10 } } }),
      prisma.product.count(),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        totalRevenue: sales._sum.totalAmount || 0,
        totalProducts,
        lowStockAlertsCount: lowStock,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Aggregated Dashboard Analytics Service Delegate
 */
export const getDashboardAnalytics = async (req, res, next) => {
  try {
    const analytics = await getDashboardAnalyticsService();
    return res.status(200).json({
      success: true,
      data: analytics,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Predictive Sales & Revenue Forecasting
 */
export const getRevenueForecast = async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || '7', 10);
    const forecast = await forecastRevenueService(days);

    return res.status(200).json({
      success: true,
      data: forecast,
    });
  } catch (error) {
    next(error);
  }
};