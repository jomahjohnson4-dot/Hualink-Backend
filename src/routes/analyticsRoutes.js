import { Router } from 'express';
import {
  getDashboardSummary,
  getSalesOverview,
  getTopSellingProducts,
  getLowStockAlerts,
} from '../controllers/analyticsController.js';
import { authenticateJWT } from '../middleware/authHandler.js';

const router = Router();

// Main dashboard overview endpoint
router.get('/', authenticateJWT, getDashboardSummary);

// Detailed analytics endpoints
router.get('/sales', authenticateJWT, getSalesOverview);
router.get('/top-products', authenticateJWT, getTopSellingProducts);
router.get('/low-stock', authenticateJWT, getLowStockAlerts);

export default router;