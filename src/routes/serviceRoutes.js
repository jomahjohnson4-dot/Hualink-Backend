import { Router } from 'express';
import { prisma } from '../prismaClient.js';

const router = Router();

// GET /api/services - Fetch all services with search & category filtering
router.get('/', async (req, res, next) => {
  try {
    const { category, search } = req.query;
    const whereClause = {};

    if (category && category !== 'all') {
      whereClause.category = category;
    }

    if (search) {
      whereClause.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { provider: { contains: search, mode: 'insensitive' } },
      ];
    }

    const services = await prisma.service.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json({
      success: true,
      count: services.length,
      data: services,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/services/whatsapp-link - Generate encoded WhatsApp chat redirect link
router.post('/whatsapp-link', (req, res) => {
  const { phone, serviceTitle, providerName, price, location } = req.body;

  if (!phone || !serviceTitle || !providerName) {
    return res.status(400).json({
      success: false,
      message: 'Missing required parameters (phone, serviceTitle, providerName)',
    });
  }

  const sanitizedPhone = phone.replace(/[^0-9]/g, '');

  const messageText =
    `Hello ${providerName}! 👋\n\n` +
    `I am contacting you via *Hualink Hub* regarding:\n` +
    `📌 *${serviceTitle}*\n\n` +
    `Estimated Price: ${price || 'N/A'}\n` +
    `Location/Target: ${location || 'N/A'}\n\n` +
    `I would like to inquire about starting this service.`;

  const encodedMessage = encodeURIComponent(messageText);
  const whatsappUrl = `https://wa.me/${sanitizedPhone}?text=${encodedMessage}`;

  return res.status(200).json({
    success: true,
    url: whatsappUrl,
  });
});

export default router;