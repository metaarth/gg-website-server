import express from 'express';
import { getProductsByCategory, getFilterOptions, getProductBySlug, getPurposes } from '../Controller/productController.js';

const router = express.Router();

// Order matters: more specific routes must come before generic ones
router.get('/filters', getFilterOptions);
router.get('/purposes', getPurposes);
router.get('/:slug', getProductBySlug);
router.get('/', getProductsByCategory);

export default router;

