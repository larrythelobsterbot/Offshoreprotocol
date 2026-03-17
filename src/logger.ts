import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss' },
    },
  }),
});
