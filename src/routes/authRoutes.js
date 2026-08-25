import { Router } from 'express';
import {
  registerAdmin,
  loginAdmin,
  getProfile,
  requestPasswordReset,
  verifyResetOtp,
  resetPassword,
} from '../controllers/authController.js';
import { authenticateJWT } from '../middleware/authHandler.js';

const router = Router();

// Admin registration & login
router.post('/register', registerAdmin);
router.post('/login', loginAdmin);

// Password reset routes
router.post('/forgot-password', requestPasswordReset);
router.post('/verify-otp', verifyResetOtp);
router.post('/reset-password', resetPassword);

// Protected user profile route
router.get('/me', authenticateJWT, getProfile);

export default router;