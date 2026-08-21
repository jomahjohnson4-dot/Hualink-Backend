import { Router } from 'express';
import { initiatePayment, handlePaymentWebhook } from '../controllers/paymentController.js';
import { verifyToken } from '../middleware/auth.js';
import { registerSSEClient } from '../services/sseService.js';

const router = Router();

// Public webhook route for mobile money gateway notifications
router.post('/webhook', handlePaymentWebhook);

// Protected endpoint to trigger push notifications to customer handset
router.post('/initiate', verifyToken, initiatePayment);

// Real-time SSE event stream for live payment updates
router.get('/stream/:orderId', (req, res) => {
  const { orderId } = req.params;
  registerSSEClient(orderId, res);
});

export default router;