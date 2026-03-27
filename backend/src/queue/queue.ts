import { Queue } from 'bullmq';
import { config } from '../config';
import { redisConnection } from './connection';
import { defaultJobOptions, TEST_JOB_NAME } from './worker';
import type { RunTestJobData, RunTestResult } from '../types/runTest';

export const browserTestQueue = new Queue<RunTestJobData, RunTestResult>(
  config.queueName,
  {
    connection: redisConnection,
    defaultJobOptions,
  },
);

export const enqueueBrowserTest = async (payload: RunTestJobData) => {
  return browserTestQueue.add(TEST_JOB_NAME, payload);
};

