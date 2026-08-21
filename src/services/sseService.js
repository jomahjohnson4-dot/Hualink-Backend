// src/services/sseService.js

// Map storing active orderId -> HTTP Response streams
const activeClients = new Map();

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