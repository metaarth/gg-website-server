import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import carouselRoutes from './Routes/carouselRoutes.js';
import productRoutes from './Routes/productRoutes.js';
import addressRoutes from './Routes/addressRoutes.js';
import orderRoutes from './Routes/orderRoutes.js';
import staticImagesRoutes from './Routes/staticImagesRoutes.js';
import reviewRoutes from './Routes/reviewRoutes.js';
import preorderRoutes from './Routes/preorderRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS: allow production client and local dev origins
const allowedOrigins = [
    'https://gg-website-client.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000'
];
if (process.env.CORS_ORIGIN) {
    process.env.CORS_ORIGIN.split(',').forEach(origin => {
        const trimmed = origin.trim();
        if (trimmed && !allowedOrigins.includes(trimmed)) allowedOrigins.push(trimmed);
    });
}

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
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
    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
};
app.use(express.json());

// Health check (for Render / load balancers)
app.get('/api/health', (req, res) => res.status(200).json({ ok: true }));

// Routes
app.use('/api/carousel', carouselRoutes);
app.use('/api/products', productRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/static-images', staticImagesRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/preorders', preorderRoutes);

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
        error: err.message || String(err)
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});