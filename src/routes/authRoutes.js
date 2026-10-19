import { Router } from 'express';
import {
  registerUser,
  loginUser,
  googleLogin,
  getProfile,
  requestOtp,
  verifyResetPassword,
} from '../controllers/authController.js';
import { authenticateJWT } from '../middleware/authHandler.js';

const router = Router();

// User registration & login
router.post('/register', registerUser);
router.post('/login', loginUser);

// Google OAuth login token verification
router.post('/google', googleLogin);

// Password reset OTP flow
router.post('/request-otp', requestOtp);
router.post('/verify-reset-password', verifyResetPassword);

// Protected user profile route
router.get('/me', authenticateJWT, getProfile);

export default router;
