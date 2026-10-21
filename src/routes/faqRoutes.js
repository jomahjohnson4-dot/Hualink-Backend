import { Router } from 'express';
import {
  getFaqs,
  getFaqById,
  createFaq,
  updateFaq,
  deleteFaq,
} from '../controllers/faqController.js';
import { authenticateJWT, restrictTo } from '../middleware/authHandler.js';

const router = Router();

// Public read access — the marketing site renders the FAQ list from here.
router.get('/', getFaqs);
router.get('/:id', getFaqById);

// Writes are reserved for admins.
router.post('/', authenticateJWT, restrictTo('admin', 'depot'), createFaq);
router.put('/:id', authenticateJWT, restrictTo('admin', 'depot'), updateFaq);
router.delete('/:id', authenticateJWT, restrictTo('admin', 'depot'), deleteFaq);

export default router;
