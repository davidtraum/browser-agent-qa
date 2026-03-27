import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import pinoHttp from 'pino-http';
import { apiRouter } from './api/routes';
import { logger } from './logger';

export const createApp = () => {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
    }),
  );

  app.use(apiRouter);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        error: 'Malformed JSON request body.',
      });
      return;
    }

    logger.error({ err }, 'Unhandled application error');
    res.status(500).json({
      error: 'Internal server error.',
    });
  });

  return app;
};
