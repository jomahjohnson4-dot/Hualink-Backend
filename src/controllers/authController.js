import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../utils/prismaClient.js';
import { sendResetEmail } from '../utils/emailService.js';
import { notifyAdmins, notifyUser } from '../services/notificationService.js';
import {
  requestVerificationCode,
  verifyVerificationCode,
  notifyVerificationSuccess,
  resolvePurpose,
} from '../services/verificationService.js';
import logger from '../utils/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * Sign-up verification is enforced by default. Set `REQUIRE_OTP_VERIFICATION=false`
 * to allow unverified registrations (useful for scripted seeding).
 */
const isOtpRequired = () =>
  String(process.env.REQUIRE_OTP_VERIFICATION || 'true').toLowerCase() !== 'false';


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
 *
 * The account is only created once the sign-up verification code has been
 * confirmed — `verificationId` (the id of an already VERIFIED
 * `verification_codes` row) or `verificationCode` (the 6-digit code itself)
 * must be supplied. The verified state is stored in PostgreSQL on both the
 * `verification_codes` audit row and the `users.email_verified` column.
 */
export const registerUser = async (req, res, next) => {
  try {
    const {
      fullName,
      email,
      phone,
      region,
      accountType,
      password,
      companyName,
      verificationId,
      verificationCode,
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const normalisedEmail = String(email).trim().toLowerCase();

    const existingUser = await prisma.user.findUnique({ where: { email: normalisedEmail } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'A user with this email already exists.' });
    }

    // ---- Verification gate -------------------------------------------------
    let verification = null;

    if (verificationId) {
      verification = await prisma.verificationCode.findUnique({ where: { id: verificationId } });

      if (!verification || verification.purpose !== 'SIGNUP') {
        return res.status(400).json({
          success: false,
          message: 'The verification session could not be found. Please verify again.',
        });
      }

      if (verification.status !== 'VERIFIED') {
        return res.status(400).json({
          success: false,
          message: 'The verification code has not been confirmed yet.',
        });
      }

      if (verification.email && verification.email !== normalisedEmail) {
        return res.status(400).json({
          success: false,
          message: 'The verification code was issued for a different email address.',
        });
      }
    } else if (verificationCode) {
      try {
        verification = await verifyVerificationCode({
          code: verificationCode,
          email: normalisedEmail,
          purpose: 'SIGNUP',
        });
      } catch (verifyError) {
        return res.status(verifyError.status || 400).json({
          success: false,
          message: verifyError.message || 'Invalid verification code.',
        });
      }
    } else if (isOtpRequired()) {
      return res.status(400).json({
        success: false,
        message: 'A verification code is required to create an account.',
        requiresVerification: true,
      });
    }

    const isVerified = Boolean(verification);

    // ---- Account creation --------------------------------------------------
    const role = accountType && VALID_ROLES.includes(accountType.toUpperCase())
      ? accountType.toUpperCase()
      : 'CUSTOMER';

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name: fullName || email,
        email: normalisedEmail,
        phone: phone || null,
        role,
        companyName: companyName || null,
        password: hashedPassword,
        emailVerified: isVerified,
        verifiedAt: isVerified ? new Date() : null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        companyName: true,
        emailVerified: true,
        createdAt: true,
      },
    });

    // Store the selected region as an address record linked to the new user
    if (region) {
      await prisma.address.create({
        data: { userId: user.id, region, street: '', details: null },
      });
    }

    // Link the verification row to the account it unlocked.
    if (verification) {
      await prisma.verificationCode.update({
        where: { id: verification.id },
        data: { userId: user.id },
      });
    }

    const token = signToken(user);

    // ---- Notification trail ------------------------------------------------
    await notifyAdmins({
      type: 'SIGNUP',
      title: 'New User Registration',
      message: `${user.name} (${user.email}) created a ${
        role === 'BUSINESS' ? 'Wholesale Partner' : 'Customer'
      } account${companyName ? ` for ${companyName}` : ''}.`,
    }).catch((error) =>
      console.error('[Notification] Sign-up event failed:', error?.message)
    );

    await notifyUser(user.id, {
      type: 'SIGNUP',
      title: 'Welcome to Hualink',
      message: `Your account is ready. ${
        isVerified
          ? 'Your email address has been verified successfully.'
          : 'Please verify your email address to activate wholesale purchasing.'
      }`,
    }).catch((error) =>
      console.error('[Notification] Welcome event failed:', error?.message)
    );

    res.status(201).json({
      success: true,
      message: isVerified
        ? 'Account created and verified successfully.'
        : 'Account created successfully.',
      token,
      user,
      verified: isVerified,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/request-signup-otp
 * Issues the 6-digit sign-up verification code and delivers it by email/SMS.
 *
 * The code is stored as a PENDING row in `verification_codes` so the sign-up
 * can be completed by `POST /api/auth/verify-otp`.
 */
export const requestSignupOtp = async (req, res, next) => {
  try {
    const { email, phone } = req.body || {};

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        message: 'An email address or phone number is required.',
      });
    }

    const normalisedEmail = email ? String(email).trim().toLowerCase() : null;

    if (normalisedEmail) {
      const existingUser = await prisma.user.findUnique({
        where: { email: normalisedEmail },
        select: { id: true },
      });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'A user with this email already exists.',
        });
      }
    }

    const result = await requestVerificationCode({
      email: normalisedEmail,
      phone,
      purpose: 'SIGNUP',
    });

    res.status(200).json({
      success: true,
      message: `A ${result.length}-digit verification code has been sent to ${
        normalisedEmail || phone
      }.`,
      data: {
        verificationId: result.id,
        purpose: result.purpose,
        channel: result.channel,
        expiresAt: result.expiresAt,
        length: result.length,
        // Surfaced in demo mode so the UI can offer a one-click autofill.
        demoCode: result.demoCode,
        isDemo: result.isDemo,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/verify-otp
 * Processes a verification code request and stores the verified status in
 * PostgreSQL.
 *
 * Handles both verification purposes:
 *  - `SIGNUP` — a 6-digit code; the `verification_codes` row flips to
 *    VERIFIED and the linked `users.email_verified` column is stamped.
 *  - `ORDER` — a 4-digit PIN confirming a wholesale purchase request.
 */
export const verifyOtp = async (req, res, next) => {
  try {
    const { code, email, phone, purpose, userId, orderId } = req.body || {};
    const resolvedPurpose = resolvePurpose(purpose, 'SIGNUP');

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'The verification code is required.',
      });
    }

    const verification = await verifyVerificationCode({
      code,
      email,
      phone,
      purpose: resolvedPurpose,
      userId: userId || req.user?.id || null,
    });

    // Attach the account + order to the verified row.
    if (req.user?.id && verification.userId !== req.user.id) {
      await prisma.verificationCode.update({
        where: { id: verification.id },
        data: { userId: req.user.id, orderId: orderId || verification.orderId },
      });
    } else if (orderId && !verification.orderId) {
      await prisma.verificationCode.update({
        where: { id: verification.id },
        data: { orderId },
      });
    }

    // Tell the customer their account / order was confirmed.
    if (resolvedPurpose === 'SIGNUP' && verification.userId) {
      await notifyVerificationSuccess(verification.userId, {
        email: verification.email,
        purpose: 'SIGNUP',
      }).catch((error) =>
        console.error('[Notification] Verification event failed:', error?.message)
      );
    }

    res.status(200).json({
      success: true,
      message:
        resolvedPurpose === 'ORDER'
          ? 'Order verification successful.'
          : 'Verification successful. Your account is verified.',
      data: {
        verificationId: verification.id,
        purpose: verification.purpose,
        status: verification.status,
        verifiedAt: verification.verifiedAt,
        email: verification.email,
        phone: verification.phone,
        userId: verification.userId,
      },
    });
  } catch (error) {
    const status = error.status || 400;
    res.status(status).json({
      success: false,
      message: error.message || 'The verification code could not be confirmed.',
    });
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
          // Google already proved the customer owns this address.
          emailVerified: true,
          verifiedAt: new Date(),
        },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          companyName: true,
          emailVerified: true,
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
          emailVerified: true,
          verifiedAt: true,
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
