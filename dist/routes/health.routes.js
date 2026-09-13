import { Router } from 'express';
import mongoose from 'mongoose';
export const healthRouter = Router();
healthRouter.get('/', (_req, res) => {
    const db = mongoose.connection.db ? 'connected' : 'disconnected';
    res.json({
        ok: true,
        service: 'multiflix-api',
        db,
    });
});
