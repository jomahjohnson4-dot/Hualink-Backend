import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

dotenv.config();

import httpLogger from './src/middleware/httpLogger.js';
import errorHandler from './src/middleware/errorHandler.js';
import logger from './src/utils/logger.js';
import prisma from './src/utils/prismaClient.js';

// Import Existing Routes
import authRoutes from './src/routes/authRoutes.js';
import productRoutes from './src/routes/productRoutes.js';
import orderRoutes from './src/routes/orderRoutes.js';
import analyticsRoutes from './src/routes/analyticsRoutes.js';
import serviceRoutes from './src/routes/serviceRoutes.js';
import paymentRoutes from './src/routes/paymentRoutes.js';
import inventoryRoutes from './src/routes/inventoryRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// 1. Security Headers Configuration
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// 2. Multi-Origin & Local Network CORS Strategy
const envOrigins = process.env.CLIENT_URL ? process.env.CLIENT_URL.split(',') : [];

const allowedOrigins = [
  ...envOrigins,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://hualink-frontend.vercel.app',
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const isAllowed =
      allowedOrigins.includes(origin) ||
      /^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+):(5173|3000)$/.test(origin) ||
      /^https:\/\/hualink-frontend.*\.vercel\.app$/.test(origin);

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error(`CORS error: Origin ${origin} is not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-signature', 'x-selcom-signature'],
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// 3. Socket.io WebSockets Setup (In-App Live Chat Engine)
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.on('connection', (socket) => {
  logger.info(`⚡ Socket Connected: ${socket.id}`);

  // Join dedicated room for a specific booking chat
  socket.on('join_booking_chat', (bookingId) => {
    socket.join(bookingId);
    logger.info(`👤 Socket ${socket.id} joined chat room for Booking ID: ${bookingId}`);
  });

  // Join business owner/provider notification channel across all services
  socket.on('join_provider_channel', (providerId) => {
    socket.join(`provider_${providerId}`);
    logger.info(`🏢 Provider ${providerId} joined notification channel`);
  });

  // Handle incoming live chat message, save to Prisma, and route to proper channels
  socket.on('send_message', async (data) => {
    const { content, text, senderId, receiverId, bookingId, providerId, serviceId } = data;
    const messageContent = content || text || '';

    try {
      let savedMessage = null;
      if (bookingId) {
        savedMessage = await prisma.message.create({
          data: {
            content: messageContent,
            senderId: senderId || 'client-id',
            receiverId: receiverId || providerId || 'provider-id',
            bookingId: bookingId,
          },
        });
      }

      const payload = savedMessage || {
        bookingId,
        serviceId,
        content: messageContent,
        senderId: senderId || 'client-id',
        receiverId: receiverId || providerId || 'provider-id',
        createdAt: new Date().toISOString(),
      };

      // 1. Broadcast to everyone actively inside this specific booking room
      io.to(bookingId).emit('receive_message', payload);

      // 2. Broadcast push alert to business owner's provider channel if providerId is supplied
      if (providerId) {
        io.to(`provider_${providerId}`).emit('new_service_inquiry', {
          bookingId,
          serviceId,
          message: payload,
        });
      }
    } catch (err) {
      logger.error('❌ Failed to store or broadcast live chat message:', err);
    }
  });

  socket.on('disconnect', () => {
    logger.info(`🔌 Socket Disconnected: ${socket.id}`);
  });
});

// 4. Global Rate Limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP. Please try again after 15 minutes.',
  },
});

app.use('/api', apiLimiter);

// 5. Body Parsers, Static Files & Logger
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(httpLogger);

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ------------------------------------------------------------------
// 🛠️ HELPER: Beem Africa SMS Integration
// ------------------------------------------------------------------
const sendSMS = async (phoneNumber, message) => {
  const BEEM_API_KEY = process.env.BEEM_API_KEY;
  const BEEM_SECRET_KEY = process.env.BEEM_SECRET_KEY;
  const SENDER_ID = process.env.BEEM_SENDER_ID || 'INFO';

  if (!BEEM_API_KEY || !BEEM_SECRET_KEY) {
    logger.warn('⚠️ Beem SMS credentials missing in .env. Skipping SMS.');
    return;
  }

  try {
    let formattedPhone = phoneNumber.replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '255' + formattedPhone.slice(1);
    } else if (formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.slice(1);
    }

    const authHeader = 'Basic ' + Buffer.from(`${BEEM_API_KEY}:${BEEM_SECRET_KEY}`).toString('base64');

    const payload = {
      source_addr: SENDER_ID,
      schedule_time: '',
      message: message,
      recipients: [{ recipient_id: '1', dest_addr: formattedPhone }],
    };

    const response = await axios.post('https://api.beem.africa/v1/send', payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
    });

    logger.info(`📱 SMS sent to ${formattedPhone}: ${response.data.message || 'Success'}`);
  } catch (error) {
    logger.error('❌ Beem SMS Error:', error.response?.data || error.message);
  }
};

// ------------------------------------------------------------------
// 📌 SERVICE BOOKINGS, CHAT LOGS & ADMIN ENDPOINTS
// ------------------------------------------------------------------

// POST: Client submits booking request (Saves to DB + Sends SMS Confirmation)
app.post('/api/bookings', async (req, res, next) => {
  try {
    const { serviceTitle, provider, clientName, clientPhone, note } = req.body;

    if (!clientName || !clientPhone || !serviceTitle) {
      return res.status(400).json({ success: false, message: 'Name, phone, and service title are required.' });
    }

    const booking = await prisma.serviceBooking.create({
      data: {
        serviceTitle,
        provider: provider || 'Hualink Tech Solutions',
        clientName,
        clientPhone,
        note: note || '',
        status: 'PENDING',
      },
    });

    const smsMessage = `Hello ${clientName}, your booking request for "${serviceTitle}" has been received by ${provider || 'Hualink'}. We will contact you shortly!`;
    sendSMS(clientPhone, smsMessage);

    res.status(201).json({
      success: true,
      message: 'Booking order submitted successfully',
      data: booking,
    });
  } catch (error) {
    next(error);
  }
});

// POST: Store chat message via REST API Fallback
app.post('/api/messages', async (req, res, next) => {
  try {
    const { bookingId, content, text, senderId, receiverId } = req.body;
    const messageContent = content || text || '';

    if (!bookingId || !messageContent) {
      return res.status(400).json({ success: false, message: 'Booking ID and content are required.' });
    }

    const message = await prisma.message.create({
      data: {
        bookingId,
        content: messageContent,
        senderId: senderId || 'client-id',
        receiverId: receiverId || 'provider-id',
      },
    });

    res.status(201).json({ success: true, data: message });
  } catch (error) {
    next(error);
  }
});

// GET: Fetch historical chat logs for a specific booking
app.get('/api/messages/:bookingId', async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const messages = await prisma.message.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: messages });
  } catch (error) {
    next(error);
  }
});

// GET: Fetch all bookings for Admin Dashboard
app.get('/api/admin/bookings', async (req, res, next) => {
  try {
    const bookings = await prisma.serviceBooking.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: bookings });
  } catch (error) {
    next(error);
  }
});

// PATCH: Admin updates booking status (Approve/Reject) & Triggers SMS
app.patch('/api/admin/bookings/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'APPROVED' | 'CANCELLED' | 'COMPLETED'

    const updatedBooking = await prisma.serviceBooking.update({
      where: { id },
      data: { status },
    });

    if (status === 'APPROVED') {
      const smsMessage = `Great news ${updatedBooking.clientName}! Your order for "${updatedBooking.serviceTitle}" has been APPROVED. Our team will proceed shortly.`;
      sendSMS(updatedBooking.clientPhone, smsMessage);
    } else if (status === 'CANCELLED') {
      const smsMessage = `Hello ${updatedBooking.clientName}, your request for "${updatedBooking.serviceTitle}" could not be processed at this time. Thank you for choosing Hualink.`;
      sendSMS(updatedBooking.clientPhone, smsMessage);
    }

    res.json({
      success: true,
      message: `Booking updated to ${status}`,
      data: updatedBooking,
    });
  } catch (error) {
    next(error);
  }
});

// Health Check Endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Hualink Distribution API running smoothly',
    timestamp: new Date().toISOString(),
  });
});

// 6. Existing API Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/inventory', inventoryRoutes);

// 7. 404 Route Fallback
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.originalUrl}`,
  });
});

// 8. Centralized Error Handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

// Start server listening via httpServer (for Socket.io support)
httpServer.listen(PORT, () => {
  logger.info(`🚀 Server & WebSockets running securely on http://localhost:${PORT}`);
});

// Database Connection Handling
prisma
  .$connect()
  .then(() => logger.info('✅ PostgreSQL Database connected cleanly'))
  .catch((err) => logger.error('❌ Database connection failed:', err));

// Unhandled Errors / Signals
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Graceful Shutdown Handler
const handleShutdown = async (signal) => {
  logger.info(`${signal} received. Closing HTTP server, WebSockets, and database connections...`);
  httpServer.close(async () => {
    try {
      await prisma.$disconnect();
      logger.info('Database disconnected cleanly. Server terminated.');
      process.exit(0);
    } catch (err) {
      logger.error('Error during database disconnect:', err);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));