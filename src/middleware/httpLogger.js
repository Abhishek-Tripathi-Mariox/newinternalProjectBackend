import { pinoHttp } from 'pino-http';
import { logger } from '../core/logger.js';

/** One structured log line per request, tagged with the request id and the signed-in user. */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.id,
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  customProps: (req) => (req.user ? { userId: req.user.id } : {}),
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  autoLogging: { ignore: (req) => req.url === '/health' },
});
