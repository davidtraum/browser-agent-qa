import { createServer } from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';
import { browserTestQueue } from './queue/queue';
import { redisConnection } from './queue/connection';

const app = createApp();
const server = createServer(app);

const start = async () => {
  server.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        queueName: config.queueName,
      },
      'Backend API listening',
    );
  });
};

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down backend API');

  server.close(async (serverError?: Error) => {
    if (serverError) {
      logger.error({ err: serverError }, 'Error while closing HTTP server');
      process.exitCode = 1;
    }

    await browserTestQueue.close();
    await redisConnection.quit();
    process.exit();
  });
};

void start();

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

