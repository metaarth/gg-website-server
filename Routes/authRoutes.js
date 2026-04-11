import express from 'express';
import { me, logout, sendPhoneOtp, verifyPhoneOtp } from '../Controller/authController.js';
import { authenticate } from '../Middleware/authMiddleware.js';

const router = express.Router();

router.post('/otp/send', sendPhoneOtp);
router.post('/otp/verify', verifyPhoneOtp);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);

export default router;

