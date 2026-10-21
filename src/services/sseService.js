// src/services/sseService.js

// Map storing active orderId -> HTTP Response streams
const activeClients = new Map();

// Map storing orderId -> Set of HTTP Response streams watching live route tracking
const orderStatusClients = new Map();

// Map storing recipientKey -> Set of HTTP Response streams watching the
// notification inbox (the "ADMIN" bucket or a specific user id)
const notificationClients = new Map();

/**
 * Registers a client SSE connection for a specific order
 */
export const registerSSEClient = (orderId, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send an initial handshake message
  res.write(`data: ${JSON.stringify({ status: 'CONNECTED', orderId })}\n\n`);

  activeClients.set(orderId, res);

  // Clean up when client disconnects or completes payment
  res.on('close', () => {
    activeClients.delete(orderId);
  });
};

/**
 * Emits a real-time event payload to a connected order client
 */
export const notifyPaymentUpdate = (orderId, payload) => {
  const clientRes = activeClients.get(orderId);
  if (clientRes) {
    clientRes.write(`data: ${JSON.stringify(payload)}\n\n`);

    // Close connection if transaction terminal state is reached
    if (['COMPLETED', 'PAID', 'FAILED', 'CANCELLED'].includes(payload.status)) {
      clientRes.end();
      activeClients.delete(orderId);
    }
  }
};

/**
 * Registers a client watching live route tracking for a single order.
 *
 * Unlike the payment stream this channel stays open for the whole journey —
 * the connection is only closed when the browser goes away.
 */
export const registerOrderStatusClient = (orderId, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ orderId, status: 'CONNECTED' })}\n\n`);

  const clients = orderStatusClients.get(orderId) || new Set();
  clients.add(res);
  orderStatusClients.set(orderId, clients);

  // Heartbeat keeps intermediaries from closing an idle stream.
  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // The socket is already gone; the close handler performs the cleanup.
    }
  }, 25000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const bucket = orderStatusClients.get(orderId);
    if (bucket) {
      bucket.delete(res);
      if (!bucket.size) orderStatusClients.delete(orderId);
    }
  });
};

/**
 * Pushes the latest order state to every client watching that order.
 * Called whenever an admin moves an order to a new lifecycle stage.
 */
export const broadcastOrderStatus = (order) => {
  if (!order?.id) return;

  const clients = orderStatusClients.get(order.id);
  if (!clients || !clients.size) return;

  const payload = JSON.stringify({
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    updatedAt: order.updatedAt,
  });

  clients.forEach((clientRes) => {
    try {
      clientRes.write(`data: ${payload}\n\n`);
    } catch {
      // Ignore disconnected clients; the close handler removes them.
    }
  });
};

/**
 * Registers a client watching the notification inbox of a single recipient.
 *
 * `recipientKey` is either the shared 'ADMIN' bucket or a user id — the same
 * value stored on `Notification.userId`.
 */
export const registerNotificationClient = (recipientKey, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ status: 'CONNECTED', recipientKey })}\n\n`);

  const clients = notificationClients.get(recipientKey) || new Set();
  clients.add(res);
  notificationClients.set(recipientKey, clients);

  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // The socket is already gone; the close handler performs the cleanup.
    }
  }, 25000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const bucket = notificationClients.get(recipientKey);
    if (bucket) {
      bucket.delete(res);
      if (!bucket.size) notificationClients.delete(recipientKey);
    }
  });
};

/**
 * Pushes a freshly created notification to every client watching that
 * recipient. Called right after the row is persisted.
 */
export const broadcastNotification = (notification) => {
  if (!notification?.userId) return;

  const clients = notificationClients.get(notification.userId);
  if (!clients || !clients.size) return;

  const payload = JSON.stringify({
    id: notification.id,
    userId: notification.userId,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    isRead: notification.isRead,
    createdAt: notification.createdAt,
  });

  clients.forEach((clientRes) => {
    try {
      clientRes.write(`data: ${payload}\n\n`);
    } catch {
      // Ignore disconnected clients; the close handler removes them.
    }
  });
};

