import { Router } from 'express';
import {
  registerUser,
  loginUser,
  googleLogin,
  getProfile,
  requestOtp,
  verifyResetPassword,
  requestSignupOtp,
  verifyOtp,
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

// Sign-up verification (6-digit OTP) — the account is only created once the
// code has been confirmed through /verify-otp.
router.post('/request-signup-otp', requestSignupOtp);
router.post('/verify-otp', verifyOtp);

// Protected user profile route
router.get('/me', authenticateJWT, getProfile);

export default router;
