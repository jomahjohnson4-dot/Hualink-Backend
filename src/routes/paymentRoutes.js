import { Router } from 'express';
import { initiatePayment, handlePaymentWebhook } from '../controllers/paymentController.js';
import { verifyToken } from '../middleware/auth.js';

const router = Router();

// Public webhook route for mobile money gateway notifications
router.post('/webhook', handlePaymentWebhook);

// Protected endpoint to trigger push notifications to customer handset
router.post('/initiate', verifyToken, initiatePayment);

export default router;