import prisma from '../utils/prismaClient.js';
import { notifyAdmins } from '../services/notificationService.js';

/** Lifecycle values the admin panel is allowed to set on an inquiry. */
const INQUIRY_STATUSES = ['NEW', 'REPLIED', 'RESOLVED'];

/**
 * Normalises an incoming status to the Prisma enum casing.
 * Accepts `replied`, `Replied`, `REPLIED` and friends.
 */
const normaliseStatus = (raw) => {
  const value = String(raw || '').trim().toUpperCase();
  return INQUIRY_STATUSES.includes(value) ? value : null;
};

/**
 * POST /api/inquiries
 * Persists a chat/inquiry message coming from the client-facing chat modal.
 */
export const createInquiry = async (req, res, next) => {
  try {
    const { customerName, customerContact, productOrService, message, timestamp } =
      req.body || {};

    if (!customerName || !customerContact || !message) {
      return res.status(400).json({
        success: false,
        message: 'Customer name, contact and message are required.',
      });
    }

    // Ignore client-supplied timestamps that cannot be parsed; fall back to now().
    const parsedTimestamp = timestamp ? new Date(timestamp) : null;
    const safeTimestamp =
      parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime()) ? parsedTimestamp : new Date();

    const inquiry = await prisma.inquiry.create({
      data: {
        customerName: String(customerName).trim(),
        customerContact: String(customerContact).trim(),
        productOrService: productOrService
          ? String(productOrService).trim()
          : 'General Inquiry',
        message: String(message).trim(),
        timestamp: safeTimestamp,
        status: 'NEW',
      },
    });

    // Log the event in the admin activity stream. A notification failure must
    // never lose the inquiry, so the error is swallowed.
    await notifyAdmins({
      type: 'INQUIRY',
      title: 'New Inquiry Received!',
      message: `${inquiry.customerName} (${inquiry.customerContact}) enquired about ${inquiry.productOrService}.`,
    }).catch((error) =>
      console.error('[Notification] Inquiry event failed:', error?.message)
    );

    res.status(201).json({
      success: true,
      message: 'Inquiry received successfully.',
      data: inquiry,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/inquiries
 * Live feed of client inquiries, newest first.
 */
export const getInquiries = async (req, res, next) => {
  try {
    const { status } = req.query;

    const whereClause = {};
    const normalised = status ? normaliseStatus(status) : null;
    if (status && !normalised) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Expected one of: ${INQUIRY_STATUSES.join(', ')}.`,
      });
    }
    if (normalised) whereClause.status = normalised;

    const [inquiries, counts] = await Promise.all([
      prisma.inquiry.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.inquiry.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const summary = INQUIRY_STATUSES.reduce((acc, key) => {
      acc[key] = 0;
      return acc;
    }, {});
    counts.forEach((entry) => {
      summary[entry.status] = entry._count._all;
    });

    res.status(200).json({
      success: true,
      data: inquiries,
      summary: { total: inquiries.length, ...summary },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/inquiries/:id
 */
export const getInquiryById = async (req, res, next) => {
  try {
    const inquiry = await prisma.inquiry.findUnique({ where: { id: req.params.id } });

    if (!inquiry) {
      return res.status(404).json({ success: false, message: 'Inquiry not found.' });
    }

    res.status(200).json({ success: true, data: inquiry });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/admin/inquiries/:id
 * Moves an inquiry through the NEW -> REPLIED -> RESOLVED lifecycle.
 */
export const updateInquiryStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, adminNote } = req.body || {};

    const normalised = normaliseStatus(status);
    if (!normalised) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Expected one of: ${INQUIRY_STATUSES.join(', ')}.`,
      });
    }

    const existing = await prisma.inquiry.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Inquiry not found.' });
    }

    const inquiry = await prisma.inquiry.update({
      where: { id },
      data: {
        status: normalised,
        ...(normalised === 'REPLIED' && !existing.repliedAt ? { repliedAt: new Date() } : {}),
        ...(adminNote !== undefined ? { adminNote: adminNote || null } : {}),
      },
    });

    // The reply/resolve action is part of the admin activity stream.
    await notifyAdmins({
      type: 'INQUIRY',
      title: `Inquiry Marked ${normalised === 'REPLIED' ? 'Replied' : 'Resolved'}`,
      message: `${existing.customerName}'s inquiry about ${existing.productOrService} was marked ${normalised}.`,
    }).catch((error) =>
      console.error('[Notification] Inquiry status event failed:', error?.message)
    );

    res.status(200).json({
      success: true,
      message: `Inquiry marked as ${normalised}.`,
      data: inquiry,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/admin/inquiries/:id
 */
export const deleteInquiry = async (req, res, next) => {
  try {
    await prisma.inquiry.delete({ where: { id: req.params.id } });
    res.status(200).json({ success: true, message: 'Inquiry deleted successfully.' });
  } catch (error) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Inquiry not found.' });
    }
    next(error);
  }
};
