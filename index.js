import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import carouselRoutes from './Routes/carouselRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/carousel', carouselRoutes);

app.get('/', (req, res) => {
    res.send('hello');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});