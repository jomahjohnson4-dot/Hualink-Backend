import { Router } from 'express';
import {
  registerAdmin,
  loginAdmin,
  getProfile,
} from '../controllers/authController.js';
import { authenticateJWT } from '../middleware/authHandler.js';

const router = Router();

// Admin registration & login
router.post('/register', registerAdmin);
router.post('/login', loginAdmin);

// Protected user profile route
router.get('/me', authenticateJWT, getProfile);

export default router;