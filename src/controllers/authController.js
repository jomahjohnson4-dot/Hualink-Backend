const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');

// Register a new admin account
exports.register = async (req, res, next) => {
  const { email, password } = req.body;

  try {
    const existingAdmin = await prisma.admin.findUnique({ where: { email } });
    if (existingAdmin) {
      return res.status(400).json({ error: 'Admin account already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = await prisma.admin.create({
      data: { email, password: hashedPassword }
    });

    res.status(201).json({ message: 'Admin created successfully', adminId: admin.id });
  } catch (error) {
    next(error);
  }
};

// Login and generate JWT
exports.login = async (req, res, next) => {
  const { email, password } = req.body;

  try {
    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Sign token valid for 24 hours
    const token = jwt.sign(
      { adminId: admin.id, email: admin.email },
      process.env.JWT_SECRET || 'fallback_secret_key',
      { expiresIn: '1d' }
    );

    res.status(200).json({ message: 'Login successful', token });
  } catch (error) {
    next(error);
  }
};