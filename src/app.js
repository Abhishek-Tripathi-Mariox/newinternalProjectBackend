import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { db } from './db/knex.js';
import { requestId } from './middleware/requestId.js';
import { httpLogger } from './middleware/httpLogger.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundRoute } from './middleware/errorHandler.js';
import { apiRouter } from './routes.js';

/** Build the Express app (no listen — server.js and the tests both use this). */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // correct client IPs for rate limiting behind one proxy / load balancer

  app.use(requestId);
  // Server clock on every response: the frontend uses it instead of the browser's clock (see frontend src/lib/clock.js).
  app.use((_req, res, next) => { res.setHeader('X-Server-Time', String(Date.now())); next(); });
  app.use(httpLogger);
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true, // refresh-token cookie
    exposedHeaders: ['X-Request-Id', 'X-Server-Time', 'Content-Disposition'],
  }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  // Liveness + DB readiness (no auth, not rate-limited)
  app.get('/health', async (_req, res) => {
    try {
      await db.raw('select 1');
      res.json({ status: 'ok', db: 'up', uptime: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  app.use('/api/v1', apiLimiter, apiRouter());
  app.use(notFoundRoute);
  app.use(errorHandler);
  return app;
}
