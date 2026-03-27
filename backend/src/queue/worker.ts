import type { JobsOptions } from 'bullmq';
import { config } from '../config';

export const TEST_JOB_NAME = 'run-browser-test';

export const defaultJobOptions: JobsOptions = {
  attempts: config.jobAttempts,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: {
    age: 60 * 60,
    count: 500,
  },
  removeOnFail: {
    age: 24 * 60 * 60,
    count: 500,
  },
};

