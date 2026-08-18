const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const httpLogger = require('./src/middleware/httpLogger');
const errorHandler = require('./src/middleware/errorHandler');
const logger = require('./src/utils/logger');
const prisma = require('./src/prismaClient');

const app = express();

// Security & Core Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(httpLogger);

// Health Check
app.get('/', (req, res) => {
  res.json({ message: 'Hualink Distribution API running' });
});

// API Routes
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/products', require('./src/routes/productRoutes'));
app.use('/api/orders', require('./src/routes/orderRoutes'));
app.use('/api/analytics', require('./src/routes/analyticsRoutes'));

// Centralized Error Handler (must be last)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
});

// Graceful Shutdown
const handleShutdown = async (signal) => {
  logger.info(`${signal} received. Closing server and database connection...`);
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Database disconnected cleanly. Exiting.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
// Ensure database connection handling has error wrapping
prisma.$connect()
  .then(() => console.log('Database connected'))
  .catch((err) => console.error('Database connection failed:', err));
