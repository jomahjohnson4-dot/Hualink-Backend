import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

import httpLogger from './src/middleware/httpLogger.js';
import errorHandler from './src/middleware/errorHandler.js';
import logger from './src/utils/logger.js';
import prisma from './src/utils/prismaClient.js';

// Import Routes
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
  'https://hualink-frontend.vercel.app', // Production Vercel App
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (Postman, curl, server-to-server)
    if (!origin) return callback(null, true);

    // Check exact origins, LAN IPs, or Vercel preview deployment URLs (*.vercel.app)
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

// 3. Global Rate Limiter
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

// 4. Body Parsers, Static Files & Logger
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(httpLogger);

// Serve uploads/static assets directory if needed
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health Check Endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Hualink Distribution API running smoothly',
    timestamp: new Date().toISOString(),
  });
});

// 5. API Endpoints
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/inventory', inventoryRoutes);

// 6. 404 Route Fallback
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.originalUrl}`,
  });
});

// 7. Centralized Error Handler (Must be last middleware)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  logger.info(`🚀 Server running securely on http://localhost:${PORT}`);
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
  logger.info(`${signal} received. Closing HTTP server and database connections...`);
  server.close(async () => {
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