const express = require('express');
const router = express.Router();
const { 
  getProducts, 
  createProduct, 
  updateProduct 
} = require('../controllers/productController');
const { authenticateJWT } = require('../middleware/authHandler');

// Public read access
router.get('/', getProducts);

// Protected admin write actions
router.post('/', authenticateJWT, createProduct);
router.put('/:id', authenticateJWT, updateProduct);

module.exports = router;