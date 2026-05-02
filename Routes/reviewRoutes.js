import express from 'express';
import multer from 'multer';
import { authenticate, optionalAuthenticate } from '../Middleware/authMiddleware.js';
import {
    getReviewsByProduct,
    addReview,
    deleteReview,
    uploadReviewImage,
} from '../Controller/reviewController.js';

const router = express.Router({ mergeParams: false });
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
            return;
        }
        cb(new Error('Only JPG, PNG, and WEBP images are allowed'));
    },
});

const uploadReviewImageMiddleware = (req, res, next) => {
    const handler = upload.single('image');
    handler(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'Image must be 5MB or smaller',
            });
        }
        return res.status(400).json({
            success: false,
            message: err.message || 'Failed to upload image',
        });
    });
};

router.get('/product/:productId', optionalAuthenticate, getReviewsByProduct);
router.post('/upload-image', authenticate, uploadReviewImageMiddleware, uploadReviewImage);
router.post('/', authenticate, addReview);
router.delete('/:id', authenticate, deleteReview);

export default router;
