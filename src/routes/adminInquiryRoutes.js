import { Router } from 'express';
import {
  getInquiries,
  getInquiryById,
  updateInquiryStatus,
  deleteInquiry,
} from '../controllers/inquiryController.js';
import { authenticateJWT, restrictTo } from '../middleware/authHandler.js';

const router = Router();

// Every admin inquiry route requires a signed-in administrator.
router.use(authenticateJWT, restrictTo('admin', 'depot'));

router.get('/', getInquiries);
router.get('/:id', getInquiryById);
router.patch('/:id', updateInquiryStatus);
router.delete('/:id', deleteInquiry);

export default router;
