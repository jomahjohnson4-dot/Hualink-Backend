import { Router } from 'express';
import { verifyToken, restrictTo } from '../middleware/auth.js';
import { getAuditLog, getVerificationAudit } from '../controllers/notificationController.js';

const router = Router();

// The admin audit log spans every recipient bucket, so it is admin only.
router.use(verifyToken, restrictTo('ADMIN'));

router.get('/', getAuditLog);
router.get('/verifications', getVerificationAudit);

export default router;
