import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env, isProd } from './config/env.js';
import { HttpError } from './lib/httpError.js';
import { apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (env.trustProxyHops > 0) {
    app.set('trust proxy', env.trustProxyHops);
  }
  app.use(morgan(isProd ? 'combined' : 'dev'));
  app.use(helmet());
  // Allow all origins. The mobile app does not need CORS (native fetch is
  // exempt) but the browser-based admin panel does, and we want it to work
  // from any deployment origin without re-configuring CORS for each one.
  app.use(
    cors({
      origin: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', apiRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint Not found' });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      void next;
      if (err instanceof HttpError) {
        res.status(err.statusCode).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.details !== undefined ? { details: err.details } : {}),
        });
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Internal server error';
      res.status(500).json({ error: message });
    },
  );

  return app;
}
