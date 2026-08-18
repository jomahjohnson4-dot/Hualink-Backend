const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);

  // Handle Prisma Record Not Found Error
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Requested record was not found.' });
  }

  // Handle Prisma Unique Constraint Error
  if (err.code === 'P2002') {
    return res.status(400).json({ error: 'Unique constraint failed. Duplicate value provided.' });
  }

  // Fallback Error Response
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
};

module.exports = errorHandler;