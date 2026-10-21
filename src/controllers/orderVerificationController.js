// src/controllers/orderVerificationController.js
import { prisma } from '../utils/prismaClient.js';
import {
  requestVerificationCode,
  verifyOrderPin,
} from '../services/verificationService.js';
import { notifyAdmins } from '../services/notificationService.js';

/**
 * Orders above this value (TZS) always require a PIN confirmation before the
 * request is written to the database.
 */
export const HIGH_VALUE_THRESHOLD = Number(
  process.env.HIGH_VALUE_ORDER_THRESHOLD || 500000
);

/**
 * Decides whether an order request has to be confirmed with a PIN.
 *
 * Wholesale accounts (BUSINESS / SUPPLIER) always confirm, and so does any
 * basket above the high-value threshold.
 */
export const requiresOrderPin = ({ role, amount } = {}) => {
  const normalisedRole = String(role || '').toUpperCase();
  if (normalisedRole === 'BUSINESS' || normalisedRole === 'SUPPLIER') return true;
  return Number(amount || 0) >= HIGH_VALUE_THRESHOLD;
};

/**
 * POST /api/orders/request-pin
 * Issues the 4-digit PIN that confirms a high-value wholesale order request.
 */
export const requestOrderPin = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required to request an order confirmation PIN.',
      });
    }

    const amount = req.body?.amount ? Number(req.body.amount) : null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true, role: true, name: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User account not found. Please log in again.',
      });
    }

    const result = await requestVerificationCode({
      email: user.email,
      phone: user.phone,
      purpose: 'ORDER',
      userId: user.id,
      amount,
    });

    res.status(200).json({
      success: true,
      message: `A ${result.length}-digit confirmation PIN has been sent to ${
        user.email || user.phone || 'your registered contact'
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
 * POST /api/orders/verify-pin
 * Confirms the PIN the customer typed before the order is placed.
 */
export const verifyOrderPinController = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required to verify an order request.',
      });
    }

    const { code, amount } = req.body || {};

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'The confirmation PIN is required.',
      });
    }

    const verification = await verifyOrderPin({
      userId,
      code,
      amount: amount === undefined || amount === null ? null : Number(amount),
    });

    await notifyAdmins({
      type: 'VERIFY',
      title: 'Wholesale Order Request Confirmed',
      message: `The customer confirmed a wholesale purchase request worth TSh ${Number(
        verification.amount || 0
      ).toLocaleString()} with a valid PIN.`,
    }).catch((error) =>
      console.error('[Notification] Order PIN event failed:', error?.message)
    );

    res.status(200).json({
      success: true,
      message: 'Order request confirmed.',
      data: {
        verificationId: verification.id,
        purpose: verification.purpose,
        status: verification.status,
        verifiedAt: verification.verifiedAt,
        amount: verification.amount,
      },
    });
  } catch (error) {
    const status = error.status || 400;
    res.status(status).json({
      success: false,
      message: error.message || 'The confirmation PIN could not be verified.',
    });
  }
};
