import { Router } from 'express';
import {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getAnalytics,
} from '../controllers/productController.js';
import { authenticateJWT, restrictTo } from '../middleware/authHandler.js';

const router = Router();

// Public Read Access
router.get('/', getProducts);
router.get('/:id', getProductById);

// Protected Admin / Depot Analytics & Inventory Alert Route
router.get('/analytics/overview', authenticateJWT, restrictTo('admin', 'depot'), getAnalytics);

// Protected Admin / Depot Write Actions
router.post('/', authenticateJWT, restrictTo('admin', 'depot'), createProduct);
router.put('/:id', authenticateJWT, restrictTo('admin', 'depot'), updateProduct);
router.delete('/:id', authenticateJWT, restrictTo('admin', 'depot'), deleteProduct);

export default router;