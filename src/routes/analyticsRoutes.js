import { Router } from 'express';
import {
  getAnalytics,
  getSalesOverview,
  getTopSellingProducts,
  getLowStockAlerts,
  getDashboardSummary,
  getDashboardAnalytics,
  getRevenueForecast,
} from '../controllers/analyticsController.js';
import { verifyToken, restrictTo } from '../middleware/auth.js';

const router = Router();

// =============================================================================
// PROTECTED ENDPOINTS (Requires Valid JWT Bearer Token)
// =============================================================================

// Guard all analytics routes with authentication middleware
router.use(verifyToken);

// Restrict analytics endpoints strictly to ADMIN and BUSINESS roles
router.use(restrictTo('ADMIN', 'BUSINESS'));

/**
 * Main dashboard overview summary
 */
router.get('/', getDashboardSummary);

/**
 * Detailed business metrics and inventory warning summary
 */
router.get('/overview', getAnalytics);

/**
 * Filtered sales overview (Supports startDate and endDate query params)
 */
router.get('/sales', getSalesOverview);

/**
 * Top-selling products by volume (Supports limit query param)
 */
router.get('/top-products', getTopSellingProducts);

/**
 * Low-stock inventory alerts (Supports threshold query param)
 */
router.get('/low-stock', getLowStockAlerts);

/**
 * Comprehensive dashboard metrics delegation endpoint
 */
router.get('/metrics', getDashboardAnalytics);

/**
 * Predictive revenue forecasting engine (Supports days query param e.g., ?days=14)
 */
router.get('/forecast', getRevenueForecast);

export default router;