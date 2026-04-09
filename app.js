import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import carouselRoutes from './Routes/carouselRoutes.js';
import productRoutes from './Routes/productRoutes.js';
import addressRoutes from './Routes/addressRoutes.js';
import orderRoutes from './Routes/orderRoutes.js';
import paymentRoutes from './Routes/paymentRoutes.js';
import { paymentCallback } from './Controller/paymentController.js';
import staticImagesRoutes from './Routes/staticImagesRoutes.js';
import reviewRoutes from './Routes/reviewRoutes.js';
import authRoutes from './Routes/authRoutes.js';
import cashbackRoutes from './Routes/cashbackRoutes.js';
import couponRoutes from './Routes/couponRoutes.js';
import { isConfigured as mailConfigured } from './config/mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// CORS: allow production client, local dev, and Easebuzz (user is redirected from Easebuzz to our callback)
const allowedOrigins = [
    'https://gawriganga.com',
    'https://www.gawriganga.com',
    'https://api.gawriganga.com',
    'https://testpay.easebuzz.in',
    'https://pay.easebuzz.in',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:3000',
    'http://localhost',
    'http://localhost:80',
];
if (process.env.CORS_ORIGIN) {
    process.env.CORS_ORIGIN.split(',').forEach(origin => {
        const trimmed = origin.trim();
        if (trimmed && !allowedOrigins.includes(trimmed)) allowedOrigins.push(trimmed);
    });
}

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (allowedOrigins.includes(origin)) return true;
    try {
        const u = new URL(origin);
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1') return true;
        if (host.endsWith('.easebuzz.in') || host === 'easebuzz.in') return true;
    } catch (_) {}
    return false;
}

// CSP: strict policy for any HTML this app might serve (e.g. future dashboard).
// API JSON responses are not affected. If you add HTML pages, relax directives as needed.
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'none'"],
                frameAncestors: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
            },
        },
    })
);
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { success: false, message: 'Too many requests' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many attempts' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/payment/initiate', authLimiter);

// Payment callback must be registered BEFORE CORS so Easebuzz redirect is never blocked
app.post('/api/payment/callback', paymentCallback);

app.use(cors({
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200
}));

// Ensure CORS header is set on error responses (so browser doesn't show "blocked by CORS")
const setCorsIfAllowed = (req, res) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
};

// Health check (for Render / load balancers)
app.get('/api/health', (req, res) => res.status(200).json({ ok: true }));

// Mail status (to verify SMTP env on production; does not test actual send)
app.get('/api/health/mail', (req, res) => res.status(200).json({ mailConfigured: mailConfigured }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/carousel', carouselRoutes);
app.use('/api/products', productRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/static-images', staticImagesRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api', cashbackRoutes);
app.use('/api/coupons', couponRoutes);

// Error handling for undefined API routes
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        setCorsIfAllowed(req, res);
        return res.status(404).json({
            success: false,
            message: 'API route not found',
            path: req.path
        });
    }
    next();
});

app.use((err, req, res, next) => {
    setCorsIfAllowed(req, res);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        ...(!isProduction && { error: err.message || String(err) }),
    });
});

// Production: log unhandled rejections/errors so process doesn’t exit silently (e.g. on EB)
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

app.listen(PORT, () => {
    if (!isProduction) console.log(`Server is running on port ${PORT}`);
});