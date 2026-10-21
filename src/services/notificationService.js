// src/services/notificationService.js
import prisma from '../utils/prismaClient.js';
import { broadcastNotification } from './sseService.js';

/**
 * Every administrator shares a single notification bucket so that the admin
 * console shows one consistent activity stream regardless of which admin
 * account is signed in.
 */
export const ADMIN_RECIPIENT = 'ADMIN';

/** The notification kinds the system emits. */
export const NOTIFICATION_TYPES = [
  'ORDER',
  'INQUIRY',
  'PRODUCT',
  'SYSTEM',
  // A brand new customer completed the sign-up flow.
  'SIGNUP',
  // An OTP / PIN verification event.
  'VERIFY',
];

/**
 * Maps an authenticated principal onto the bucket its notifications live in.
 * Admins collapse onto 'ADMIN'; everybody else uses their own user id.
 */
export const resolveRecipientKey = (user) => {
  if (!user) return null;
  const role = String(user.role || '').toUpperCase();
  if (role === 'ADMIN') return ADMIN_RECIPIENT;
  return user.id || null;
};

/** Guards against an unknown type blowing up the Prisma enum. */
const normaliseType = (raw) => {
  const value = String(raw || '').trim().toUpperCase();
  return NOTIFICATION_TYPES.includes(value) ? value : 'SYSTEM';
};

/**
 * Persists a notification and pushes it to any live subscriber.
 *
 * Returns `null` when no recipient could be resolved — a notification without
 * an owner is meaningless, so it is skipped rather than stored.
 */
export const createNotification = async ({
  userId,
  title,
  message,
  type = 'SYSTEM',
  isRead = false,
} = {}) => {
  const recipient = String(userId || '').trim();
  if (!recipient) return null;

  const notification = await prisma.notification.create({
    data: {
      userId: recipient,
      title: String(title || '').trim() || 'System notification',
      message: String(message || ''),
      type: normaliseType(type),
      isRead: Boolean(isRead),
    },
  });

  // Push after the write so subscribers always receive a persisted row.
  broadcastNotification(notification);

  return notification;
};

/** Logs a notification in the shared admin activity stream. */
export const notifyAdmins = (payload) =>
  createNotification({ ...payload, userId: ADMIN_RECIPIENT });

/** Logs a notification for a single customer. */
export const notifyUser = (userId, payload) =>
  createNotification({ ...payload, userId });
