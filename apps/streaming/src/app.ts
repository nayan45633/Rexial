import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { ServerError } from 'livekit-server-sdk';
import { config } from './config.js';
import routes from './routes.js';

export function createApp(): Express {
    const app = express();

    app.use(cors({ origin: config.corsOrigins }));
    app.use(express.json());

    app.get('/health', (_req, res) => {
        res.status(200).json({ ok: true });
    });

    app.use('/api/v1/stream', routes);

    // Express 5 forwards rejected handlers here.
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        // LiveKit answers not_found when the player has not joined the room
        // (yet, or any more), which is the caller's problem, not ours.
        if (err instanceof ServerError && err.status === 404) {
            res.status(404).json({ success: false, error: 'That person is not in the video room.' });
            return;
        }

        console.error('[streaming] request failed', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    });

    return app;
}
