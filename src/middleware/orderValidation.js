// middleware/orderValidation.js
import { body, validationResult } from 'express-validator';

// Validation rules for order creation
export const validateOrderPayload = [
  body('customerPhone')
    .optional({ checkFalsy: true })
    .custom((value, { req }) => {
      // Check customerPhone, phone, or customerDetails.phone
      const phoneNum = value || req.body.phone || req.body.customerDetails?.phone;
      if (!phoneNum) {
        throw new Error('Customer phone number is required');
      }
      const cleanPhone = String(phoneNum).replace(/\s+/g, '');
      if (!/^(?:\+255|255|0)[0-9]{9}$/.test(cleanPhone)) {
        throw new Error('Invalid phone number format (e.g., 0712345678 or 255712345678)');
      }
      return true;
    }),

  body('paymentMethod')
    .notEmpty().withMessage('Payment method is required')
    .isIn(['M-PESA', 'AZAM-PAY', 'TIGO-PESA', 'AIRTEL-MONEY', 'HALOPESA', 'CARD', 'CASH'])
    .withMessage('Invalid payment method selection'),

  body('items')
    .isArray({ min: 1 }).withMessage('Order items must be a non-empty array'),

  body('items.*.productId')
    .custom((value, { req, path }) => {
      // Extract array index from path (e.g. items[0].productId)
      const index = path.match(/\d+/)?.[0];
      const item = index !== undefined ? req.body.items[index] : null;
      const id = value || item?.id;

      if (!id) {
        throw new Error('Product ID is required');
      }
      // Allow standard string IDs, CUIDs, or UUIDs
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('Invalid Product ID format');
      }
      return true;
    }),

  body('items.*.quantity')
    .isInt({ min: 1 }).withMessage('Quantity must be an integer greater than 0'),

  body('items.*.unitPrice')
    .optional()
    .custom((value, { req, path }) => {
      const index = path.match(/\d+/)?.[0];
      const item = index !== undefined ? req.body.items[index] : null;
      const price = value !== undefined ? value : item?.price;

      if (price === undefined || isNaN(parseFloat(price)) || parseFloat(price) < 0) {
        throw new Error('Unit price must be a positive number');
      }
      return true;
    }),

  // Catch validation errors and reject invalid requests
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({
        success: false,
        error: 'Validation failed',
        details: errors.array().map((err) => ({
          field: err.path,
          message: err.msg,
        })),
      });
    }
    next();
  },
];