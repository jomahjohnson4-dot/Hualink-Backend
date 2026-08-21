import { Router } from 'express';
import db from '../config/db.js';
import { validateOrderPayload } from '../middleware/orderValidation.js';
import { verifyToken, restrictTo } from '../middleware/auth.js';

const router = Router();

// In-memory store for active SSE clients listening for payment updates
const paymentClients = new Map();

// -----------------------------------------------------------------------------
// CONTROLLER HANDLERS
// -----------------------------------------------------------------------------

/**
 * Create a new order in PostgreSQL using a Database Transaction
 */
export const createOrder = async (req, res) => {
  const client = await db.getClient ? await db.getClient() : await db.connect();

  try {
    const userId = req.user.id;
    const {
      customerName,
      customerPhone,
      deliveryRegion,
      deliveryAddress,
      paymentMethod,
      totalAmount,
      items,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Cart items are required.' });
    }

    // Begin ACID transaction
    await client.query('BEGIN');

    // 1. Insert main order record
    const newOrder = await client.query(
      `INSERT INTO orders (user_id, customer_name, phone, region, shipping_address, payment_method, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending') 
       RETURNING *`,
      [userId, customerName, customerPhone, deliveryRegion, deliveryAddress, paymentMethod, totalAmount]
    );

    const orderId = newOrder.rows[0].id;
    const orderNumber = newOrder.rows[0].order_number || `ORD-${orderId}`;

    // 2. Save individual order items
    for (const item of items) {
      const price = item.unitPrice ?? item.price;
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, price)
         VALUES ($1, $2, $3, $4)`,
        [orderId, item.productId, item.quantity, price]
      );
    }

    // Commit transaction to finalize updates
    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: {
        id: orderId,
        orderId: orderId,
        orderNumber,
        status: 'Pending',
        totalAmount,
      },
    });
  } catch (error) {
    // Rollback any partial inserts if an error occurs
    await client.query('ROLLBACK');
    console.error('Database Transaction Error (Create Order):', error);
    res.status(500).json({ message: 'Internal server error while placing order.' });
  } finally {
    // Release client back to pool
    client.release();
  }
};

/**
 * Retrieve user orders (or all orders if admin)
 */
export const getOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let queryText = 'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC';
    let queryParams = [userId];

    if (userRole === 'admin') {
      queryText = 'SELECT * FROM orders ORDER BY created_at DESC';
      queryParams = [];
    }

    const { rows } = await db.query(queryText, queryParams);
    res.status(200).json({ data: rows });
  } catch (error) {
    console.error('Fetch Orders Error:', error);
    res.status(500).json({ message: 'Error retrieving orders.' });
  }
};

/**
 * Retrieve specific order by ID along with its line items
 */
export const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const orderResult = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    const order = orderResult.rows[0];

    // Ensure users can only access their own orders (unless admin)
    if (order.user_id !== userId && userRole !== 'admin') {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const itemsResult = await db.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
    order.items = itemsResult.rows;

    res.status(200).json({ data: order });
  } catch (error) {
    console.error('Fetch Order Error:', error);
    res.status(500).json({ message: 'Error retrieving order details.' });
  }
};

/**
 * SSE Endpoint for streaming payment updates to the frontend
 */
export const streamPaymentStatus = (req, res) => {
  const { orderId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  paymentClients.set(String(orderId), res);

  req.on('close', () => {
    paymentClients.delete(String(orderId));
  });
};

/**
 * Payment gateway callback handler (updates DB & notifies SSE clients)
 */
export const handlePaymentWebhook = async (req, res) => {
  try {
    const { orderId, status } = req.body;

    if (!orderId || !status) {
      return res.status(400).json({ message: 'Invalid webhook payload.' });
    }

    await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);

    // Push update live to SSE client listening on frontend
    const clientRes = paymentClients.get(String(orderId));
    if (clientRes) {
      clientRes.write(`data: ${JSON.stringify({ orderId, status })}\n\n`);
    }

    res.status(200).json({ message: 'Webhook processed successfully' });
  } catch (error) {
    console.error('Webhook Error:', error);
    res.status(500).json({ message: 'Error processing webhook.' });
  }
};

// -----------------------------------------------------------------------------
// ROUTE DEFINITIONS
// -----------------------------------------------------------------------------

// PUBLIC ENDPOINTS
router.post('/payment-webhook', handlePaymentWebhook);
router.get('/payments/stream/:orderId', streamPaymentStatus);

// PROTECTED ENDPOINTS (Requires Valid JWT Bearer Token)
router.use(verifyToken);

router.post('/', validateOrderPayload, createOrder);
router.get('/', getOrders);
router.get('/:id', getOrderById);

export default router;