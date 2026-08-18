const { body, validationResult } = require('express-validator');

// Validation rules for order creation
exports.validateOrderPayload = [
  body('customerPhone')
    .notEmpty().withMessage('Customer phone number is required')
    .isString().withMessage('Phone number must be a string')
    .matches(/^(255|0)[0-9]{9}$/).withMessage('Invalid phone number format (e.g., 255700000000 or 0700000000)'),

  body('paymentMethod')
    .notEmpty().withMessage('Payment method is required')
    .isIn(['M-PESA', 'TIGO-PESA', 'AIRTEL-MONEY', 'HALOPESA', 'CASH'])
    .withMessage('Invalid payment method selection'),

  body('items')
    .isArray({ min: 1 }).withMessage('Order items must be a non-empty array'),

  body('items.*.productId')
    .notEmpty().withMessage('Product ID is required')
    .isUUID().withMessage('Invalid Product ID format'),

  body('items.*.quantity')
    .isInt({ min: 1 }).withMessage('Quantity must be an integer greater than 0'),

  body('items.*.unitPrice')
    .isFloat({ min: 0 }).withMessage('Unit price must be a positive number'),

  // Catch validation errors and reject invalid requests
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({
        error: 'Validation failed',
        details: errors.array().map((err) => ({
          field: err.path,
          message: err.msg
        }))
      });
    }
    next();
  }
];