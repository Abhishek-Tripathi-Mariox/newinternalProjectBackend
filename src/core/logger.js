import pino from 'pino';
import { config } from '../config/index.js';

/** Structured JSON logger (pretty-printed in development). */
export const logger = pino({
  level: config.logLevel,
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash'], censor: '[redacted]' },
  ...(config.env === 'development' ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
});
