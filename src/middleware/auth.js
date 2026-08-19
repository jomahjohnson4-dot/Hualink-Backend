import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import logger from '../utils/logger.js';

/**
 * Middleware to verify JWT token from Authorization header or cookies
 */
export const verifyToken = async (req, res, next) => {
  try {
    let token;

    // 1. Extract token from Authorization header (Bearer <token>)
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } 
    // Fallback: Check cookies if using cookie-parser
    else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No authentication token provided.',
      });
    }

    // 2. Verify signature using JWT secret key
    const secret = process.env.JWT_SECRET || 'your_fallback_jwt_secret_key';
    const decoded = jwt.verify(token, secret);
    const userId = decoded.id || decoded.userId;

    // 3. Dual Lookup: Check Admin table first, then User table
    let currentUser = null;
    let userRole = decoded.role || 'user';

    // Try finding in Admin table
    try {
      const adminUser = await prisma.admin.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });
      if (adminUser) {
        currentUser = {
          ...adminUser,
          fullName: 'Admin User',
          role: 'ADMIN',
          isActive: true,
        };
        userRole = 'ADMIN';
      }
    } catch (err) {
      // Prisma admin query failed or table structure differs
    }

    // If not found in Admin, check User table
    if (!currentUser) {
      currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          isActive: true,
        },
      });
    }

    if (!currentUser) {
      return res.status(401).json({
        success: false,
        message: 'User belonging to this token no longer exists.',
      });
    }

    if (currentUser.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated. Please contact support.',
      });
    }

    // 4. Attach authenticated user object to Request interface
    req.user = currentUser;
    next();
  } catch (error) {
    if (logger && logger.error) {
      logger.error(`JWT Verification Error: ${error.message}`);
    } else {
      console.error(`JWT Verification Error:`, error);
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Authentication token has expired. Please log in again.',
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token signature.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Internal server error during authentication.',
    });
  }
};

/**
 * Role-Based Access Control (RBAC) Middleware
 * Usage: restrictTo('ADMIN', 'MANAGER', 'admin')
 */
export const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. User not attached to request.',
      });
    }

    const userRole = (req.user.role || '').toUpperCase();
    const allowed = roles.map((r) => r.toUpperCase());

    if (!allowed.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not have permission to perform this action.',
      });
    }
    next();
  };
};

// Aliases for route flexibility
export const authenticateJWT = verifyToken;
export const requireRole = restrictTo;