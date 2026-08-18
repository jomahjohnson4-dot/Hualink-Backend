const rateLimit = require('express-rate-limit');

// Limit login attempts to 5 requests per 15-minute window per IP
exports.loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Maximum 5 requests
  message: {
    error: 'Too many login attempts from this IP. Please try again after 15 minutes.'
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false // Disable `X-RateLimit-*` headers
});