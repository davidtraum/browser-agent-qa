import type { Request, Response } from 'express';
import { browserTestQueue, enqueueBrowserTest } from '../queue/queue';
import { config } from '../config';
import { logger } from '../logger';
import { getGitHubIssueSummary } from '../services/githubIssue';
import { deriveTestPlanFromIssue } from '../services/issueTestPlanner';
import { listShopwareBranches } from '../services/shopwareBranches';
import { prepareShopwareAdministration } from '../services/shopwareProvisioner';
import {
  appendTaskHistoryEvents,
  clearTaskHistory,
  clearTaskProgressEvents,
  getTaskHistoryEvents,
  getTaskProgressEvents,
  isTaskCancellationRequested,
  listManagedTasks,
  clearTaskCancellation,
  requestTaskCancellation,
} from '../queue/taskControl';
import type {
  ClearFinishedTasksResponse,
  ManagedTaskListResponse,
  ProgressEventPayload,
  RunTestFromIssueRequestBody,
  RunTestJobData,
  RunTestRequestBody,
  RunTestResult,
  RunTestFromIssueStreamEvent,
  RunTestStatusResponse,
  StopTaskResponse,
} from '../types/runTest';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseRequestBody = (body: unknown): { data?: RunTestRequestBody; error?: string } => {
  if (!isObject(body)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const task = typeof body.task === 'string' ? body.task.trim() : '';
  const branch = typeof body.branch === 'string' ? body.branch.trim() : config.shopwareDefaultBranch;

  if (!task) {
    return { error: 'Field "task" is required.' };
  }

  return {
    data: {
      task,
      branch,
    },
  };
};

const parseIssueRequestBody = (
  body: unknown,
): { data?: RunTestFromIssueRequestBody; error?: string } => {
  if (!isObject(body)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const issueUrl = typeof body.issueUrl === 'string' ? body.issueUrl.trim() : '';
  const branch = typeof body.branch === 'string' ? body.branch.trim() : config.shopwareDefaultBranch;

  if (!issueUrl) {
    return { error: 'Field "issueUrl" is required.' };
  }

  try {
    const parsedIssueUrl = new URL(issueUrl);
    if (parsedIssueUrl.hostname !== 'github.com') {
      return { error: 'Field "issueUrl" must point to github.com.' };
    }
  } catch {
    return { error: 'Field "issueUrl" must be a valid absolute URL.' };
  }

  return {
    data: {
      issueUrl,
      branch,
    },
  };
};

const buildFailureResult = (summary: string, logs: string[] = []): RunTestResult => ({
  success: false,
  summary,
  steps: [],
  logs,
});

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const toIssueReference = (issue: Awaited<ReturnType<typeof getGitHubIssueSummary>>) => ({
  url: issue.url,
  title: issue.title,
  repository: issue.repository,
  number: issue.number,
});

const createProgressEvent = (event: ProgressEventPayload): RunTestFromIssueStreamEvent => ({
  type: 'progress',
  timestamp: event.timestamp ?? new Date().toISOString(),
  ...event,
});

const deriveExposedStatus = (state: string, result?: RunTestResult, cancellationRequested?: boolean): string => {
  if (state === 'completed' && result?.metadata?.cancelled) {
    return 'cancelled';
  }

  if (state === 'active' && cancellationRequested) {
    return 'cancelling';
  }

  return state;
};

const normalizeProgress = (value: unknown): ProgressEventPayload | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.stage !== 'string' || typeof record.message !== 'string') {
    return undefined;
  }

  return {
    stage: record.stage as ProgressEventPayload['stage'],
    message: record.message,
    detail: typeof record.detail === 'string' ? record.detail : undefined,
    stepNumber: typeof record.stepNumber === 'number' ? record.stepNumber : undefined,
    sequence: typeof record.sequence === 'number' ? record.sequence : undefined,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
    screenshot: typeof record.screenshot === 'string' ? record.screenshot : undefined,
  };
};

const queueIssueRun = async (
  data: RunTestFromIssueRequestBody,
  onEvent?: (event: RunTestFromIssueStreamEvent) => void,
) => {
  const branch = data.branch?.trim() || config.shopwareDefaultBranch;
  const queuedHistoryEvents: RunTestFromIssueStreamEvent[] = [];
  const emit = (event: RunTestFromIssueStreamEvent) => {
    queuedHistoryEvents.push(event);
    onEvent?.(event);
  };

  emit(
    createProgressEvent({
      stage: 'issue',
      message: 'Fetching GitHub issue details.',
      detail: data.issueUrl,
    }),
  );
  const issue = await getGitHubIssueSummary(data.issueUrl);

  emit({
    type: 'issue',
    issue: toIssueReference(issue),
  });

  emit(
    createProgressEvent({
      stage: 'planning',
      message: 'Generating a browser test plan from the GitHub issue.',
    }),
  );
  const plan = await deriveTestPlanFromIssue(issue);

  emit({
    type: 'plan',
    summary: plan.summary,
    generatedTask: plan.task,
    generatedSteps: plan.steps,
  });

  emit(
    createProgressEvent({
      stage: 'branch',
      message: `Preparing Shopware branch ${branch}.`,
    }),
  );
  const shopware = await prepareShopwareAdministration(
    branch,
    (event) => {
      emit(createProgressEvent(event));
    },
  );

  emit(
    createProgressEvent({
      stage: 'queue',
      message: 'Queueing the browser test job.',
      detail: shopware.adminUrl,
    }),
  );

  const payload: RunTestJobData = {
    url: shopware.adminUrl,
    task: plan.task,
    branch: shopware.branch,
    maxSteps: config.agentMaxSteps,
    timeoutSeconds: config.jobTimeoutSeconds,
    submittedAt: new Date().toISOString(),
    source: {
      issueUrl: issue.url,
      issueTitle: issue.title,
      repository: issue.repository,
    },
    shopware: {
      branch: shopware.branch,
      adminUrl: shopware.adminUrl,
      workspaceDir: shopware.workspaceDir,
      adminUsername: shopware.adminUsername,
      adminPassword: shopware.adminPassword,
    },
  };

  const job = await enqueueBrowserTest(payload);

  logger.info(
    {
      jobId: job.id,
      branch: payload.branch,
      adminUrl: payload.url,
      issueUrl: issue.url,
    },
    'Queued Shopware browser test job from GitHub issue',
  );

  const response = {
    jobId: job.id,
    status: 'queued',
    branch: payload.branch,
    adminUrl: payload.url,
    issue: toIssueReference(issue),
    generatedTask: plan.task,
    generatedSteps: plan.steps,
    summary: plan.summary,
  };

  emit({
    type: 'job',
    jobId: String(job.id),
    branch: response.branch,
    adminUrl: response.adminUrl,
  });

  await clearTaskHistory(String(job.id));
  await appendTaskHistoryEvents(String(job.id), queuedHistoryEvents);

  return response;
};

export const runTest = async (req: Request, res: Response): Promise<void> => {
  const parsed = parseRequestBody(req.body);

  if (!parsed.data) {
    res.status(400).json({
      error: parsed.error,
    });
    return;
  }

  const shopware = await prepareShopwareAdministration(parsed.data.branch);
  const payload: RunTestJobData = {
    task: parsed.data.task,
    branch: shopware.branch,
    url: shopware.adminUrl,
    maxSteps: config.agentMaxSteps,
    timeoutSeconds: config.jobTimeoutSeconds,
    submittedAt: new Date().toISOString(),
    shopware: {
      branch: shopware.branch,
      adminUrl: shopware.adminUrl,
      workspaceDir: shopware.workspaceDir,
      adminUsername: shopware.adminUsername,
      adminPassword: shopware.adminPassword,
    },
  };

  const job = await enqueueBrowserTest(payload);

  logger.info(
    {
      jobId: job.id,
      branch: payload.branch,
      adminUrl: payload.url,
    },
    'Queued Shopware browser test job',
  );

  res.status(202).json({
    jobId: job.id,
    status: 'queued',
    branch: payload.branch,
    adminUrl: payload.url,
  });
};

export const runTestFromIssue = async (req: Request, res: Response): Promise<void> => {
  const parsed = parseIssueRequestBody(req.body);

  if (!parsed.data) {
    res.status(400).json({
      error: parsed.error,
    });
    return;
  }

  const response = await queueIssueRun(parsed.data);

  res.status(202).json(response);
};

export const runTestFromIssueStream = async (req: Request, res: Response): Promise<void> => {
  const parsed = parseIssueRequestBody(req.body);

  if (!parsed.data) {
    res.status(400).json({
      error: parsed.error,
    });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const push = (event: RunTestFromIssueStreamEvent) => {
    if (closed) {
      return;
    }

    res.write(`${JSON.stringify(event)}\n`);
    const streamResponse = res as unknown as { flush?: () => void };
    streamResponse.flush?.();
  };

  push({
    type: 'accepted',
    issueUrl: parsed.data.issueUrl,
    branch: parsed.data.branch?.trim() || config.shopwareDefaultBranch,
    timestamp: new Date().toISOString(),
  });

  try {
    const queuedRun = await queueIssueRun(parsed.data, push);
    await appendTaskHistoryEvents(String(queuedRun.jobId), [
      {
        type: 'accepted',
        issueUrl: parsed.data.issueUrl,
        branch: parsed.data.branch?.trim() || config.shopwareDefaultBranch,
        timestamp: new Date().toISOString(),
      },
    ]);
    let previousStatus = '';
    let lastProgressSequence = 0;
    let previousProgressSignature = '';

    for (;;) {
      if (closed) {
        break;
      }

      const job = await browserTestQueue.getJob(String(queuedRun.jobId));
      if (!job) {
        push({
          type: 'error',
          message: `No job found for id "${queuedRun.jobId}".`,
        });
        break;
      }

      const status = await job.getState();
      const completedResult =
        status === 'completed' ? ((job.returnvalue as RunTestResult | undefined) ?? undefined) : undefined;
      const cancellationRequested = await isTaskCancellationRequested(String(job.id ?? queuedRun.jobId));
      const exposedStatus = deriveExposedStatus(status, completedResult, cancellationRequested);
      if (exposedStatus !== previousStatus) {
        const statusEvent: RunTestFromIssueStreamEvent = {
          type: 'status',
          status: exposedStatus,
          attemptsMade: job.attemptsMade,
        };
        push(statusEvent);
        await appendTaskHistoryEvents(String(job.id ?? queuedRun.jobId), [statusEvent]);
        previousStatus = exposedStatus;
      }

      const progressEvents = await getTaskProgressEvents(String(job.id ?? queuedRun.jobId));
      for (const progressEvent of progressEvents) {
        const sequence = progressEvent.sequence ?? 0;
        if (sequence > lastProgressSequence) {
          push(createProgressEvent(progressEvent));
          lastProgressSequence = sequence;
        }
      }

      if (progressEvents.length === 0) {
        const progress = normalizeProgress(job.progress);
        const progressSignature = progress ? JSON.stringify(progress) : '';
        if (progress && progressSignature !== previousProgressSignature) {
          push(createProgressEvent(progress));
          previousProgressSignature = progressSignature;
        }
      }

      if (status === 'completed') {
        const resultEvent: RunTestFromIssueStreamEvent = {
          type: 'result',
          result: completedResult ?? buildFailureResult('The job completed without a result payload.'),
        };
        push(resultEvent);
        await appendTaskHistoryEvents(String(job.id ?? queuedRun.jobId), [resultEvent]);
        break;
      }

      if (status === 'failed') {
        const resultEvent: RunTestFromIssueStreamEvent = {
          type: 'result',
          result: buildFailureResult(job.failedReason ?? 'Job failed.', [...(job.stacktrace ?? [])]),
        };
        push(resultEvent);
        await appendTaskHistoryEvents(String(job.id ?? queuedRun.jobId), [resultEvent]);
        break;
      }

      await sleep(1000);
    }
  } catch (error) {
    const errorEvent: RunTestFromIssueStreamEvent = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
    push(errorEvent);
  } finally {
    if (!closed) {
      res.end();
    }
  }
};

export const getShopwareBranches = async (req: Request, res: Response): Promise<void> => {
  const rawQuery = req.query.q;
  const query = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  const branches = await listShopwareBranches(typeof query === 'string' ? query : undefined);

  res.json({
    defaultBranch: config.shopwareDefaultBranch,
    branches,
  });
};

export const getRunTestStatus = async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const job = await browserTestQueue.getJob(id);

  if (!job) {
    res.status(404).json({
      error: `No job found for id "${id}".`,
    });
    return;
  }

  const state = await job.getState();
  const completedResult =
    state === 'completed' ? ((job.returnvalue as RunTestResult | undefined) ?? undefined) : undefined;
  const cancellationRequested = await isTaskCancellationRequested(String(job.id ?? id));
  const response: RunTestStatusResponse = {
    jobId: String(job.id ?? id),
    status: deriveExposedStatus(state, completedResult, cancellationRequested),
    attemptsMade: job.attemptsMade,
  };

  const progress = normalizeProgress(job.progress);
  if (progress) {
    response.progress = progress;
  }

  response.progressEvents = await getTaskProgressEvents(String(job.id ?? id));
  response.historyEvents = await getTaskHistoryEvents(String(job.id ?? id));

  if (state === 'completed') {
    response.result = completedResult;
  } else if (state === 'failed') {
    response.result = buildFailureResult(job.failedReason ?? 'Job failed.', [
      ...(job.stacktrace ?? []),
    ]);
  }

  res.json(response);
};

export const getManagedTasks = async (req: Request, res: Response): Promise<void> => {
  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const parsedLimit =
    typeof rawLimit === 'string' && rawLimit.trim() ? Number.parseInt(rawLimit.trim(), 10) : undefined;
  const tasks: ManagedTaskListResponse = await listManagedTasks(
    typeof parsedLimit === 'number' && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
  );
  res.json(tasks);
};

export const stopManagedTask = async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const job = await browserTestQueue.getJob(id);

  if (!job) {
    res.status(404).json({
      error: `No job found for id "${id}".`,
    });
    return;
  }

  const state = await job.getState();

  if (state === 'active') {
    job.discard();
    await requestTaskCancellation(id);
    await job.updateProgress({
      stage: 'execution',
      message: 'Cancellation requested.',
      detail: 'Stopping after the current browser step.',
      timestamp: new Date().toISOString(),
      sequence: Date.now(),
    });

    const response: StopTaskResponse = {
      jobId: id,
      action: 'cancellation_requested',
      previousStatus: state,
      message: 'Cancellation requested. The worker will stop this run at the next safe checkpoint.',
    };

    res.json(response);
    return;
  }

  if (state === 'waiting' || state === 'prioritized' || state === 'delayed') {
    await requestTaskCancellation(id);
    await job.remove();
    await Promise.all([clearTaskCancellation(id), clearTaskHistory(id), clearTaskProgressEvents(id)]);

    const response: StopTaskResponse = {
      jobId: id,
      action: 'removed',
      previousStatus: state,
      message: 'The queued task was removed before execution started.',
    };

    res.json(response);
    return;
  }

  if (state === 'completed' || state === 'failed') {
    await job.remove();
    await Promise.all([clearTaskCancellation(id), clearTaskHistory(id), clearTaskProgressEvents(id)]);

    const response: StopTaskResponse = {
      jobId: id,
      action: 'removed',
      previousStatus: state,
      message: 'The finished task was removed from the task list.',
    };

    res.json(response);
    return;
  }

  res.status(409).json({
    error: `Task "${id}" is in state "${state}" and cannot be stopped from this endpoint.`,
  });
};

export const clearFinishedTasks = async (_req: Request, res: Response): Promise<void> => {
  const finishedJobs = await browserTestQueue.getJobs(['completed', 'failed'], 0, 199, false);
  const clearedJobIds: string[] = [];

  for (const job of finishedJobs) {
    const jobId = String(job.id);
    await job.remove();
    await Promise.all([
      clearTaskCancellation(jobId),
      clearTaskHistory(jobId),
      clearTaskProgressEvents(jobId),
    ]);
    clearedJobIds.push(jobId);
  }

  const response: ClearFinishedTasksResponse = {
    clearedJobIds,
    removedCount: clearedJobIds.length,
    message:
      clearedJobIds.length > 0
        ? `Removed ${clearedJobIds.length} finished tasks from the task list.`
        : 'There were no finished tasks to remove.',
  };

  res.json(response);
};
