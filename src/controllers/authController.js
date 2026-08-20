import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prismaClient.js';

// Register Admin
export const registerAdmin = async (req, res, next) => {
  try {
    const { email, password, name } = req.body;

    const existingAdmin = await prisma.admin.findUnique({ where: { email } });
    if (existingAdmin) {
      return res.status(400).json({ success: false, message: 'Admin already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Build data payload dynamically to prevent unknown argument error if name is not in schema
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

    // Attach role: 'admin' to payload so middleware restrictTo/requireRole passes
    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: 'admin' },
      process.env.JWT_SECRET || 'fallback_secret_key',
      { expiresIn: '1d' }
    );

    res.status(200).json({
      success: true,
      token,
      data: { token }, // Included under data for jq parsing compatibility
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