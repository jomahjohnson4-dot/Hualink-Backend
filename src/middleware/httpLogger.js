const morgan = require('morgan');
const logger = require('../utils/logger');

// Define stream object for Morgan
const stream = {
  write: (message) => logger.info(message.trim())
};

// Skip logging during automated test runs
const skip = () => {
  const env = process.env.NODE_ENV || 'development';
  return env === 'test';
};

const httpLogger = morgan(
  ':remote-addr - :method :url :status :response-time ms - :res[content-length]',
  { stream, skip }
);

module.exports = httpLogger;