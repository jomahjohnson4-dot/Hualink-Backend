import prisma from '../utils/prismaClient.js';
import {
  NOTIFICATION_TYPES,
  resolveRecipientKey,
  ADMIN_RECIPIENT,
} from '../services/notificationService.js';
import { registerNotificationClient, broadcastNotification } from '../services/sseService.js';

/**
 * GET /api/notifications
 * The alert-center feed for the signed-in principal.
 *
 * Admins read the shared 'ADMIN' bucket (a log of every system activity);
 * customers read their own notifications (order updates and so on).
 *
 * Admins may pass `scope=all` to receive the shared admin bucket *and* their
 * own personal notifications in one chronological feed — this is what the
 * dedicated /notifications page renders for the "All Activity" tab.
 */
export const getNotifications = async (req, res, next) => {
  try {
    const recipient = resolveRecipientKey(req.user);
    if (!recipient) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required to read notifications.',
      });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const unreadOnly = String(req.query.unreadOnly || '').toLowerCase() === 'true';
    const scope = String(req.query.scope || '').toLowerCase();
    const type = String(req.query.type || '').trim().toUpperCase();

    const isAdmin = String(req.user?.role || '').toUpperCase() === 'ADMIN';

    let where = { userId: recipient };
    if (isAdmin && scope === 'all') {
      // The admin sees the shared activity bucket plus their own inbox.
      where = { OR: [{ userId: recipient }, { userId: ADMIN_RECIPIENT }] };
    }

    if (unreadOnly) where.isRead = false;
    if (type && NOTIFICATION_TYPES.includes(type)) where.type = type;

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.count({
        where: isAdmin && scope === 'all'
          ? { OR: [{ userId: recipient }, { userId: ADMIN_RECIPIENT }], isRead: false }
          : { userId: recipient, isRead: false },
      }),
    ]);

    res.status(200).json({
      success: true,
      data: notifications,
      unreadCount,
      recipient,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/notifications
 * Helper route that logs a system event.
 *
 * When the caller is authenticated the notification is filed under their own
 * bucket (admins may target another recipient explicitly). Unauthenticated
 * callers are treated as internal tooling and must name the recipient, so the
 * route can never be used to flood somebody else's inbox.
 */
export const createNotification = async (req, res, next) => {
  try {
    const { userId, title, message, type = 'SYSTEM' } = req.body || {};

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: 'Both title and message are required.',
      });
    }

    const typeValue = String(type).toUpperCase();
    if (!NOTIFICATION_TYPES.includes(typeValue)) {
      return res.status(400).json({
        success: false,
        message: `Invalid type. Expected one of: ${NOTIFICATION_TYPES.join(', ')}.`,
      });
    }

    let recipient;
    if (req.user) {
      const isAdmin = String(req.user.role || '').toUpperCase() === 'ADMIN';
      // Only an admin may file a notification for somebody else.
      recipient = isAdmin && userId ? String(userId) : resolveRecipientKey(req.user);
    } else {
      // Unauthenticated callers must state who the notification is for.
      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'An explicit userId is required when no session is attached.',
        });
      }
      recipient = String(userId);
    }

    const notification = await prisma.notification.create({
      data: {
        userId: recipient,
        title: String(title).trim(),
        message: String(message),
        type: typeValue,
      },
    });

    // Reuse the broadcast so live subscribers see it immediately.
    broadcastNotification(notification);

    res.status(201).json({
      success: true,
      message: 'Notification logged.',
      data: notification,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/notifications/:id/read
 * Marks a single notification as read. Only the owner may mark it.
 */
export const markNotificationRead = async (req, res, next) => {
  try {
    const recipient = resolveRecipientKey(req.user);
    if (!recipient) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    const existing = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }

    if (existing.userId !== recipient) {
      return res.status(403).json({
        success: false,
        message: 'You cannot update a notification addressed to someone else.',
      });
    }

    const notification = await prisma.notification.update({
      where: { id: req.params.id },
      data: { isRead: true },
    });

    res.status(200).json({
      success: true,
      message: 'Notification marked as read.',
      data: notification,
    });
  } catch (error) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    next(error);
  }
};

/**
 * PATCH /api/notifications/read-all
 * Marks every notification in the caller's bucket as read.
 */
export const markAllNotificationsRead = async (req, res, next) => {
  try {
    const recipient = resolveRecipientKey(req.user);
    if (!recipient) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    const result = await prisma.notification.updateMany({
      where: { userId: recipient, isRead: false },
      data: { isRead: true },
    });

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read.',
      updated: result.count,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/notifications/:id
 * Removes a notification from the caller's bucket.
 */
export const deleteNotification = async (req, res, next) => {
  try {
    const recipient = resolveRecipientKey(req.user);
    if (!recipient) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    const existing = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }

    if (existing.userId !== recipient) {
      return res.status(403).json({
        success: false,
        message: 'You cannot delete a notification addressed to someone else.',
      });
    }

    await prisma.notification.delete({ where: { id: req.params.id } });

    res.status(200).json({ success: true, message: 'Notification deleted.' });
  } catch (error) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    next(error);
  }
};

/**
 * GET /api/notifications/stream
 * Server-sent events channel that pushes new notifications as they happen.
 *
 * `EventSource` cannot send an Authorization header, so the JWT arrives as a
 * query parameter and is verified by the route before the stream is opened.
 */
export const streamNotifications = async (req, res, next) => {
  try {
    const recipient = resolveRecipientKey(req.user);
    if (!recipient) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    registerNotificationClient(recipient, res);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/notifications
 * The admin "Notifications & Audit Log" feed.
 *
 * Unlike the customer feed this endpoint spans every recipient bucket, so the
 * Hualink Admin can see each customer sign-up, order purchase and
 * verification event in one chronological stream. The verification code audit
 * table is merged in so OTP/PIN events are visible even before they are
 * summarised into a notification.
 */
export const getAuditLog = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
    const type = String(req.query.type || '').trim().toUpperCase();
    const category = String(req.query.category || '').trim().toUpperCase();

    // Category shorthands used by the admin panel filter chips.
    const CATEGORY_TYPES = {
      SIGNUP: ['SIGNUP'],
      ORDERS: ['ORDER'],
      VERIFICATION: ['VERIFY'],
      INQUIRIES: ['INQUIRY'],
      CATALOGUE: ['PRODUCT'],
      SYSTEM: ['SYSTEM'],
    };

    const typeFilter =
      type && NOTIFICATION_TYPES.includes(type)
        ? [type]
        : CATEGORY_TYPES[category] || null;

    const where = typeFilter ? { type: { in: typeFilter } } : {};

    const [notifications, verificationCodes, counts] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.verificationCode.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.groupBy({
        by: ['type'],
        _count: { _all: true },
      }),
    ]);

    const summary = {
      total: notifications.length,
      byType: counts.reduce((acc, entry) => {
        acc[entry.type] = entry._count._all;
        return acc;
      }, {}),
      verifications: verificationCodes.length,
    };

    res.status(200).json({
      success: true,
      data: notifications,
      verificationCodes,
      summary,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/notifications/verifications
 * The raw verification-code audit trail (issued / verified / failed codes).
 */
export const getVerificationAudit = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const records = await prisma.verificationCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.status(200).json({ success: true, data: records });
  } catch (error) {
    next(error);
  }
};
