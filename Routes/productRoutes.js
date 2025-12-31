import express from 'express';
import { getProductsByCategory, getFilterOptions, getProductById } from '../Controller/productController.js';

const router = express.Router();

// Order matters: more specific routes must come before generic ones
router.get('/filters', getFilterOptions);
router.get('/:id', getProductById);
router.get('/', getProductsByCategory);

export default router;

