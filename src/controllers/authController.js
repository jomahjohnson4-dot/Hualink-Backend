import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../utils/prismaClient.js';
import { sendResetEmail } from '../utils/emailService.js';
import logger from '../utils/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * Sign a JWT token for an authenticated user/admin.
 */
const signToken = (payload) => {
  return jwt.sign(
    { id: payload.id, email: payload.email, role: payload.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
};

/**
 * Generate a secure 6-digit numeric OTP code.
 */
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const VALID_ROLES = ['CUSTOMER', 'BUSINESS', 'SUPPLIER', 'ADMIN'];

/**
 * POST /api/auth/register
 * Creates a user record, hashes the password with bcrypt, returns a JWT token + user object.
 */
export const registerUser = async (req, res, next) => {
  try {
    const { fullName, email, phone, region, accountType, password, companyName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'A user with this email already exists.' });
    }

    const role = accountType && VALID_ROLES.includes(accountType.toUpperCase())
      ? accountType.toUpperCase()
      : 'CUSTOMER';

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name: fullName || email,
        email,
        phone: phone || null,
        role,
        companyName: companyName || null,
        password: hashedPassword,
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        companyName: true,
        createdAt: true,
      },
    });

    // Store the selected region as an address record linked to the new user
    if (region) {
      await prisma.address.create({
        data: { userId: user.id, region, street: '', details: null },
      });
    }

    const token = signToken(user);

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      token,
      user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/login
 * Verifies email/password hash (supports both User and Admin records), returns JWT token + profile.
 */
export const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    // 1. Lookup in User table first
    let user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      }

      const token = signToken(user);
      return res.status(200).json({
        success: true,
        message: 'Login successful.',
        token,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.name,
          name: user.name,
          phone: user.phone,
          role: user.role,
          companyName: user.companyName,
        },
      });
    }

    // 2. Fallback lookup in Admin table
    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const token = signToken({ id: admin.id, email: admin.email, role: 'ADMIN' });

    res.status(200).json({
      success: true,
      message: 'Login successful.',
      token,
      user: {
        id: admin.id,
        email: admin.email,
        fullName: admin.name || 'Admin User',
        name: admin.name || 'Admin User',
        role: 'ADMIN',
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/google
 * Verifies a Google OAuth ID token, finds or creates the user, returns a JWT token + profile.
 */
export const googleLogin = async (req, res, next) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ success: false, message: 'Google ID token is required.' });
    }

    // Verify the ID token using the Google OAuth2 client library.
    // audience: GOOGLE_CLIENT_ID ensures the token was issued for this Hualink client.
    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID,
      });
    } catch (googleError) {
      logger.error('Google ID token verification failed:', googleError.message);
      return res.status(401).json({ success: false, message: 'Unable to verify Google account.' });
    }

    const payload = ticket.getPayload();
    const { email, name, sub: googleId } = payload || {};
    if (!email) {
      return res.status(401).json({ success: false, message: 'Google account has no associated email.' });
    }

    // Upsert: find existing user by email, otherwise create a new Hualink account.
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: name || email,
          googleId: googleId || null,
          // Google users have no usable password; set a random unusable one
          password: await bcrypt.hash(Math.random().toString(36).slice(-16), 10),
          role: 'CUSTOMER',
        },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          companyName: true,
          createdAt: true,
        },
      });
    }

    const token = signToken(user);

    res.status(200).json({
      success: true,
      message: 'Google login successful.',
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.name,
        name: user.name,
        phone: user.phone,
        role: user.role,
        companyName: user.companyName,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/auth/me
 * Returns the profile of the currently authenticated user (dual lookup User/Admin).
 */
export const getProfile = async (req, res, next) => {
  try {
    const { id, role } = req.user || {};

    let profile;
    if (role === 'ADMIN') {
      profile = await prisma.admin.findUnique({
        where: { id },
        select: { id: true, email: true, name: true, createdAt: true },
      });
    } else {
      profile = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          companyName: true,
          createdAt: true,
        },
      });
    }

    if (!profile) {
      return res.status(404).json({ success: false, message: 'Profile not found.' });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/request-otp
 * Generates a 6-digit OTP with a 10-minute expiry and delivers it by email.
 */
export const requestOtp = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account associated with this email.' });
    }

    const otp = generateOtp();
    // 10-minute expiry per specification
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.user.update({
      where: { email },
      data: { resetOtp: otp, resetOtpExpires: otpExpiry },
    });

    // Deliver the OTP via SMTP/Resend (Nodemailer)
    try {
      await sendResetEmail(email, otp);
      logger.info(`📧 Password reset OTP sent to ${email}`);
    } catch (emailError) {
      // SMTP may not be configured in local/dev environments. Log the OTP so the
      // reset flow can still be tested without breaking the request.
      logger.warn(
        `⚠️  Email delivery failed for ${email}. DEV OTP (check server logs): ${otp}. Error: ${emailError.message}`
      );
    }

    res.status(200).json({
      success: true,
      message: 'A 6-digit verification code has been sent to your email address.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/verify-reset-password
 * Verifies the OTP code against the DB record (TTL), updates the hashed password,
 * and invalidates the OTP code.
 */
export const verifyResetPassword = async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, verification code, and new password are required.',
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.resetOtp !== code) {
      return res.status(400).json({ success: false, message: 'Invalid verification code.' });
    }

    if (new Date() > new Date(user.resetOtpExpires)) {
      return res.status(400).json({ success: false, message: 'Verification code has expired.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password & clear the reset OTP / expiry fields
    await prisma.user.update({
      where: { email },
      data: {
        password: hashedPassword,
        resetOtp: null,
        resetOtpExpires: null,
      },
    });

    res.status(200).json({
      success: true,
      message: 'Password reset successful. You can now log in.',
    });
  } catch (error) {
    next(error);
  }
};
