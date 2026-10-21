import { Router } from 'express';
import { verifyToken, restrictTo } from '../middleware/auth.js';
import { getOrders } from '../controllers/orderController.js';

const router = Router();

// Admin order feed — administrators see every order regardless of owner.
router.use(verifyToken, restrictTo('ADMIN'));

router.get('/', getOrders);

export default router;
