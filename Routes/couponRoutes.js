import express from 'express';
import { authenticate } from '../Middleware/authMiddleware.js';
import { listPublicCoupons, validateCoupon } from '../Controller/couponController.js';

const router = express.Router();

router.get('/public', listPublicCoupons);
router.post('/validate', authenticate, validateCoupon);

export default router;

