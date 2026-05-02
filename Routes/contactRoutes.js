import express from 'express';
import { submitContactMessage } from '../Controller/contactController.js';

const router = express.Router();

router.post('/', submitContactMessage);

export default router;
