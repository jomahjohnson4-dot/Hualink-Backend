import { Router } from 'express';
import jwt from 'jsonwebtoken';
import {
  getNotifications,
  createNotification,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  streamNotifications,
} from '../controllers/notificationController.js';
import { verifyToken } from '../middleware/auth.js';

const router = Router();

/**
 * `EventSource` cannot send an Authorization header, so the live notification
 * stream authenticates through a `token` query parameter. The token is
 * verified here before the connection is upgraded to SSE.
 */
const verifyStreamToken = async (req, res, next) => {
  try {
    const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided for the notification stream.',
      });
    }

    const secret = process.env.JWT_SECRET || 'super_secret_jwt_key_hualink_2026_change_in_prod';
    const decoded = jwt.verify(token, secret);

    // Reuse the standard verification path so the user lookup stays in one
    // place — this simply injects the decoded token into the header.
    req.headers.authorization = `Bearer ${token}`;
    req.streamToken = decoded;

    return verifyToken(req, res, next);
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Authentication token has expired. Please log in again.',
      });
    }
    if (error?.name === 'JsonWebTokenError') {
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

// Live stream — mounted before the guarded routes below.
router.get('/stream', verifyStreamToken, streamNotifications);

/**
 * Attaches `req.user` when a bearer token is present but never rejects an
 * anonymous caller. Used by the helper route so an authenticated admin is
 * recognised while internal tooling can still post without a session.
 */
const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || !header.startsWith('Bearer ')) return next();

  return verifyToken(req, res, next);
};

// The helper route is intentionally permissive so internal tooling can log an
// event without a session; the controller decides the recipient.
router.post('/', optionalAuth, createNotification);

router.get('/', verifyToken, getNotifications);
router.patch('/read-all', verifyToken, markAllNotificationsRead);
router.patch('/:id/read', verifyToken, markNotificationRead);
router.delete('/:id', verifyToken, deleteNotification);

export default router;
