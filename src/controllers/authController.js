import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prismaClient.js';
import { sendResetEmail } from '../utils/emailService.js';

// Register Admin
export const registerAdmin = async (req, res, next) => {
  try {
    const { email, password, name } = req.body;

    const existingAdmin = await prisma.admin.findUnique({ where: { email } });
    if (existingAdmin) {
      return res.status(400).json({ success: false, message: 'Admin already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const dataPayload = { email, password: hashedPassword };
    if (name) {
      dataPayload.name = name;
    }

    const admin = await prisma.admin.create({
      data: dataPayload,
    });

    res.status(201).json({
      success: true,
      data: { id: admin.id, email: admin.email, name: admin.name || null }
    });
  } catch (error) {
    next(error);
  }
};

// Login Admin
export const loginAdmin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: 'admin' },
      process.env.JWT_SECRET || 'fallback_secret_key',
      { expiresIn: '1d' }
    );

    res.status(200).json({
      success: true,
      token,
      data: { token },
      admin: { id: admin.id, email: admin.email, role: 'admin' }
    });
  } catch (error) {
    next(error);
  }
};

// Get Profile
export const getProfile = async (req, res, next) => {
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, createdAt: true },
    });

    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin profile not found' });
    }

    res.status(200).json({ success: true, data: admin });
  } catch (error) {
    next(error);
  }
};

// Step 1: Request Password Reset OTP
export const requestPasswordReset = async (req, res, next) => {
  try {
    const { email } = req.body;

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      return res.status(404).json({ success: false, message: 'No account associated with this email.' });
    }

    // Generate a 6-digit numeric OTP code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000); // Valid for 15 minutes

    // Save reset payload to database record
    await prisma.admin.update({
      where: { email },
      data: {
        resetOtp: otp,
        resetOtpExpires: otpExpiry
      }
    });

    // Send the email via Nodemailer
    await sendResetEmail(email, otp);

    res.status(200).json({
      success: true,
      message: 'Verification OTP generated and sent to your email.'
    });
  } catch (error) {
    next(error);
  }
};

// Step 2: Verify OTP Code
export const verifyResetOtp = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin || admin.resetOtp !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid verification code.' });
    }

    if (new Date() > new Date(admin.resetOtpExpires)) {
      return res.status(400).json({ success: false, message: 'Verification code has expired.' });
    }

    res.status(200).json({
      success: true,
      message: 'OTP verification successful.'
    });
  } catch (error) {
    next(error);
  }
};

// Step 3: Save New Password
export const resetPassword = async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin || admin.resetOtp !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid verification token.' });
    }

    if (new Date() > new Date(admin.resetOtpExpires)) {
      return res.status(400).json({ success: false, message: 'Verification session expired.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password & clear reset OTP columns
    await prisma.admin.update({
      where: { email },
      data: {
        password: hashedPassword,
        resetOtp: null,
        resetOtpExpires: null
      }
    });

    res.status(200).json({
      success: true,
      message: 'Password reset successful. You can now log in.'
    });
  } catch (error) {
    next(error);
  }
};