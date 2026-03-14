import express from 'express';
import { authenticate } from '../Middleware/authMiddleware.js';
import { initiatePayment } from '../Controller/paymentController.js';

const router = express.Router();

router.post('/initiate', authenticate, initiatePayment);

export default router;
