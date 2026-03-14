import express from 'express';
import { authenticate } from '../Middleware/authMiddleware.js';
import {
    getReviewsByProduct,
    addReview,
    deleteReview
} from '../Controller/reviewController.js';

const router = express.Router({ mergeParams: false });

router.get('/product/:productId', getReviewsByProduct);
router.post('/', authenticate, addReview);
router.delete('/:id', authenticate, deleteReview);

export default router;
