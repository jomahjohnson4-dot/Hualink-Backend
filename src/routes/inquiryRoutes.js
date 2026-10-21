import { Router } from 'express';
import { createInquiry } from '../controllers/inquiryController.js';

const router = Router();

// Public endpoint used by the client-facing chat modal.
router.post('/', createInquiry);

export default router;
