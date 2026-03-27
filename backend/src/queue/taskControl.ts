import type { Job, JobType } from 'bullmq';
import { browserTestQueue } from './queue';
import { redisConnection } from './connection';
import type {
  ManagedTaskListResponse,
  ManagedTaskSummary,
  ProgressEventPayload,
  RunTestFromIssueStreamEvent,
  RunTestJobData,
  RunTestResult,
} from '../types/runTest';
import { config } from '../config';

const RUNNING_STATES: JobType[] = ['active'];
const PENDING_STATES: JobType[] = ['waiting', 'prioritized', 'delayed'];
const RECENT_STATES: JobType[] = ['completed', 'failed'];
const CANCELLATION_TTL_SECONDS = 24 * 60 * 60;
const PROGRESS_HISTORY_LIMIT = 200;
const TASK_HISTORY_LIMIT = 400;

const toIsoString = (value?: number): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;

const cancellationKey = (jobId: string): string => `${config.queueName}:cancel:${jobId}`;
const progressHistoryKey = (jobId: string): string => `${config.queueName}:progress:${jobId}`;
const taskHistoryKey = (jobId: string): string => `${config.queueName}:history:${jobId}`;

export const requestTaskCancellation = async (jobId: string): Promise<void> => {
  await redisConnection.set(cancellationKey(jobId), '1', 'EX', CANCELLATION_TTL_SECONDS);
};

export const clearTaskCancellation = async (jobId: string): Promise<void> => {
  await redisConnection.del(cancellationKey(jobId));
};

export const clearTaskHistory = async (jobId: string): Promise<void> => {
  await redisConnection.del(taskHistoryKey(jobId));
};

export const clearTaskProgressEvents = async (jobId: string): Promise<void> => {
  await redisConnection.del(progressHistoryKey(jobId));
};

export const isTaskCancellationRequested = async (jobId: string): Promise<boolean> => {
  const value = await redisConnection.get(cancellationKey(jobId));
  return value === '1';
};

const normalizeProgress = (progress: unknown): ProgressEventPayload | undefined => {
  if (!progress || typeof progress !== 'object') {
    return undefined;
  }

  const candidate = progress as Record<string, unknown>;
  if (typeof candidate.stage !== 'string' || typeof candidate.message !== 'string') {
    return undefined;
  }

  return {
    stage: candidate.stage as ProgressEventPayload['stage'],
    message: candidate.message,
    detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
    stepNumber: typeof candidate.stepNumber === 'number' ? candidate.stepNumber : undefined,
    sequence: typeof candidate.sequence === 'number' ? candidate.sequence : undefined,
    timestamp: typeof candidate.timestamp === 'string' ? candidate.timestamp : undefined,
    screenshot: typeof candidate.screenshot === 'string' ? candidate.screenshot : undefined,
  };
};

export const getTaskProgressEvents = async (jobId: string, limit = PROGRESS_HISTORY_LIMIT): Promise<ProgressEventPayload[]> => {
  const safeLimit = Math.max(1, Math.min(limit, PROGRESS_HISTORY_LIMIT));
  const values = await redisConnection.lrange(progressHistoryKey(jobId), 0, safeLimit - 1);
  const events: ProgressEventPayload[] = [];

  for (const value of values) {
    try {
      const candidate = JSON.parse(value) as unknown;
      const normalized = normalizeProgress(candidate);
      if (normalized) {
        events.push(normalized);
      }
    } catch {
      // Ignore malformed progress history entries.
    }
  }

  return events;
};

export const appendTaskHistoryEvents = async (
  jobId: string,
  events: RunTestFromIssueStreamEvent[],
): Promise<void> => {
  if (events.length === 0) {
    return;
  }

  const serializedEvents = events.map((event) => JSON.stringify(event));
  await redisConnection.rpush(taskHistoryKey(jobId), ...serializedEvents);
  await redisConnection.ltrim(taskHistoryKey(jobId), -TASK_HISTORY_LIMIT, -1);
  await redisConnection.expire(taskHistoryKey(jobId), CANCELLATION_TTL_SECONDS);
};

export const getTaskHistoryEvents = async (
  jobId: string,
  limit = TASK_HISTORY_LIMIT,
): Promise<RunTestFromIssueStreamEvent[]> => {
  const safeLimit = Math.max(1, Math.min(limit, TASK_HISTORY_LIMIT));
  const values = await redisConnection.lrange(taskHistoryKey(jobId), 0, safeLimit - 1);
  const events: RunTestFromIssueStreamEvent[] = [];

  for (const value of values) {
    try {
      const candidate = JSON.parse(value) as RunTestFromIssueStreamEvent;
      if (candidate && typeof candidate === 'object' && 'type' in candidate) {
        events.push(candidate);
      }
    } catch {
      // Ignore malformed task history entries.
    }
  }

  return events;
};

const deriveExposedStatus = (
  state: string,
  result?: RunTestResult,
  cancellationRequested?: boolean,
): string => {
  if (state === 'completed' && result?.metadata?.cancelled) {
    return 'cancelled';
  }

  if (state === 'active' && cancellationRequested) {
    return 'cancelling';
  }

  return state;
};

const buildTaskSummary = async (job: Job<RunTestJobData, RunTestResult>): Promise<ManagedTaskSummary> => {
  const state = await job.getState();
  const result =
    state === 'completed' ? ((job.returnvalue as RunTestResult | undefined) ?? undefined) : undefined;
  const cancellationRequested = await isTaskCancellationRequested(String(job.id));

  return {
    jobId: String(job.id),
    status: deriveExposedStatus(state, result, cancellationRequested),
    attemptsMade: job.attemptsMade,
    resultSuccess:
      state === 'failed'
        ? false
        : typeof result?.success === 'boolean'
          ? result.success
          : undefined,
    branch: job.data.branch || job.data.shopware?.branch,
    issueUrl: job.data.source?.issueUrl,
    issueTitle: job.data.source?.issueTitle,
    repository: job.data.source?.repository,
    adminUrl: job.data.shopware?.adminUrl || job.data.url,
    submittedAt: job.data.submittedAt,
    createdAt: toIsoString(job.timestamp),
    processedAt: toIsoString(job.processedOn),
    finishedAt: toIsoString(job.finishedOn),
    cancellationRequested,
    progress: normalizeProgress(job.progress),
  };
};

const sortTasks = (tasks: ManagedTaskSummary[]): ManagedTaskSummary[] =>
  [...tasks].sort((left, right) => {
    const leftTime = Date.parse(left.submittedAt ?? left.createdAt ?? '') || 0;
    const rightTime = Date.parse(right.submittedAt ?? right.createdAt ?? '') || 0;
    return rightTime - leftTime;
  });

export const listManagedTasks = async (limit = 25): Promise<ManagedTaskListResponse> => {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const [runningJobs, pendingJobs, recentJobs] = await Promise.all([
    browserTestQueue.getJobs(RUNNING_STATES, 0, safeLimit - 1, false),
    browserTestQueue.getJobs(PENDING_STATES, 0, safeLimit - 1, false),
    browserTestQueue.getJobs(RECENT_STATES, 0, safeLimit - 1, false),
  ]);

  const [running, pending, recent] = await Promise.all([
    Promise.all(runningJobs.map((job) => buildTaskSummary(job))),
    Promise.all(pendingJobs.map((job) => buildTaskSummary(job))),
    Promise.all(recentJobs.map((job) => buildTaskSummary(job))),
  ]);

  return {
    running: sortTasks(running),
    pending: sortTasks(pending),
    recent: sortTasks(recent),
  };
};
