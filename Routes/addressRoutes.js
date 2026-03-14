import express from 'express';
import { authenticate } from '../Middleware/authMiddleware.js';
import {
    getUserAddresses,
    getAddressById,
    createAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress
} from '../Controller/addressController.js';

const router = express.Router();

router.get('/user/:userId', authenticate, getUserAddresses);
router.get('/:id', authenticate, getAddressById);
router.post('/', authenticate, createAddress);
router.put('/:id', authenticate, updateAddress);
router.delete('/:id', authenticate, deleteAddress);
router.patch('/:id/default', authenticate, setDefaultAddress);

export default router;

