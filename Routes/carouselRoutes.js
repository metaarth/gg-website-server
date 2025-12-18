import express from 'express';
import { getCarouselImages } from '../Controller/carouselController.js';

const router = express.Router();

router.get('/', getCarouselImages);

export default router;

