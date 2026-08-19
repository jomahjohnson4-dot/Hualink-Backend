import logger from '../utils/logger.js';

const errorHandler = (err, req, res, next) => {
  // Log the detailed error stack using your logger
  if (logger && logger.error) {
    logger.error(err.stack || err.message);
  } else {
    console.error(err.stack || err.message);
  }

  const statusCode = err.statusCode || res.statusCode !== 200 ? res.statusCode : 500;

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

export default errorHandler;