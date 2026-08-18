const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrderById,
  handlePaymentWebhook
} = require('../controllers/orderController');
const { validateOrderPayload } = require('../middleware/orderValidation');
const { authenticateJWT } = require('../middleware/authHandler');

// Protected order creation with validation
router.post('/', authenticateJWT, validateOrderPayload, createOrder);

// Protected order retrieval
router.get('/', authenticateJWT, getOrders);
router.get('/:id', authenticateJWT, getOrderById);

// Public payment gateway webhook callback (e.g., AzamPay / Selcom)
router.post('/payment-webhook', handlePaymentWebhook);

module.exports = router;