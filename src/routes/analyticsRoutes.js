const express = require('express');
const router = express.Router();
const {
  getDashboardSummary,
  getSalesOverview,
  getTopSellingProducts,
  getLowStockAlerts
} = require('../controllers/analyticsController');
const { authenticateJWT } = require('../middleware/authHandler');

// Main dashboard overview endpoint
router.get('/', authenticateJWT, getDashboardSummary);

// Detailed analytics endpoints
router.get('/sales', authenticateJWT, getSalesOverview);
router.get('/top-products', authenticateJWT, getTopSellingProducts);
router.get('/low-stock', authenticateJWT, getLowStockAlerts);

module.exports = router;