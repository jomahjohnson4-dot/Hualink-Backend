import { Router } from 'express';
import { updateProductStock, getLowStockAlerts } from '../controllers/inventoryController.js';
import { verifyToken, restrictTo } from '../middleware/auth.js';

const router = Router();

// Protect all inventory routes
router.use(verifyToken);

/**
 * Fetch products reaching reorder thresholds (Admin & Supplier access)
 */
router.get('/low-stock-alerts', restrictTo('ADMIN', 'SUPPLIER', 'BUSINESS'), getLowStockAlerts);

/**
 * Update stock quantities and warehouse locations
 */
router.patch('/products/:productId/stock', restrictTo('ADMIN', 'SUPPLIER'), updateProductStock);

export default router;