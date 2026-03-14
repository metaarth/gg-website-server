import express from 'express';
import { authenticate } from '../Middleware/authMiddleware.js';
import {
    createOrder,
    getUserOrders,
    getOrderById,
    updateOrderStatus
} from '../Controller/orderController.js';

const router = express.Router();

router.post('/', authenticate, createOrder);
router.get('/user/:userId', authenticate, getUserOrders);
router.get('/:id', authenticate, getOrderById);
router.patch('/:id/status', authenticate, updateOrderStatus);

export default router;

