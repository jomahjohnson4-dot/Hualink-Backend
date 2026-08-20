import { prisma } from '../utils/prismaClient.js';

/**
 * Calculates simple linear regression (y = mx + b) over historical time series data
 */
const calculateLinearRegression = (dataPoints) => {
  const n = dataPoints.length;
  if (n === 0) return { slope: 0, intercept: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  dataPoints.forEach((point, index) => {
    const x = index + 1; // Time step index
    const y = point.value;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  });

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) || 0;
  const intercept = (sumY - slope * sumX) / n || 0;

  return { slope, intercept, totalPoints: n };
};

/**
 * Fetches dashboard analytics metrics (Revenue, Order volume, Top Products)
 */
export const getDashboardAnalyticsService = async () => {
  // Total Revenue from PAID orders
  const revenueResult = await prisma.order.aggregate({
    where: { paymentStatus: 'PAID' },
    _sum: { totalAmount: true },
    _count: { id: true },
  });

  // Count orders grouped by status
  const ordersByStatus = await prisma.order.groupBy({
    by: ['status'],
    _count: { id: true },
  });

  // Top 5 best-selling products by quantity
  const topProducts = await prisma.orderItem.groupBy({
    by: ['productId'],
    _sum: { quantity: true },
    orderBy: {
      _sum: {
        quantity: 'desc',
      },
    },
    take: 5,
  });

  // Populate product details for top sellers
  const populatedTopProducts = await Promise.all(
    topProducts.map(async (item) => {
      const product = await prisma.product.findUnique({
        where: { id: item.productId },
        select: { name: true, category: true, basePrice: true },
      });
      return {
        productId: item.productId,
        name: product?.name || 'Unknown Product',
        category: product?.category || 'General',
        unitsSold: item._sum.quantity,
      };
    })
  );

  return {
    totalRevenue: revenueResult._sum.totalAmount || 0,
    totalOrders: revenueResult._count.id || 0,
    ordersByStatus,
    topSellingProducts: populatedTopProducts,
  };
};

/**
 * Projects future revenue over specified days using linear regression model
 */
export const forecastRevenueService = async (daysToForecast = 7) => {
  // Fetch historical daily sales for paid orders over the last 30 days
  const pastThirtyDays = new Date();
  pastThirtyDays.setDate(pastThirtyDays.getDate() - 30);

  const historicalOrders = await prisma.order.findMany({
    where: {
      paymentStatus: 'PAID',
      createdAt: { gte: pastThirtyDays },
    },
    select: {
      totalAmount: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Aggregate daily revenue totals
  const dailyTotals = {};
  historicalOrders.forEach((order) => {
    const dateKey = order.createdAt.toISOString().split('T')[0];
    dailyTotals[dateKey] = (dailyTotals[dateKey] || 0) + order.totalAmount;
  });

  const timeSeries = Object.keys(dailyTotals).map((date) => ({
    date,
    value: dailyTotals[date],
  }));

  const { slope, intercept, totalPoints } = calculateLinearRegression(timeSeries);

  // Generate forecasted projections for upcoming days
  const forecast = [];
  const today = new Date();

  for (let i = 1; i <= daysToForecast; i++) {
    const futureDate = new Date();
    futureDate.setDate(today.getDate() + i);
    const dateStr = futureDate.toISOString().split('T')[0];

    // Forecast value = slope * (next_x_index) + intercept
    const xIndex = totalPoints + i;
    const projectedRevenue = Math.max(0, slope * xIndex + intercept);

    forecast.push({
      date: dateStr,
      projectedRevenue: Math.round(projectedRevenue * 100) / 100,
    });
  }

  return {
    historicalDataPoints: timeSeries.length,
    trendSlope: slope,
    forecast,
  };
};