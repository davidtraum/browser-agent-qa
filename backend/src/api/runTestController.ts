import type { Request, Response } from 'express';
import { browserTestQueue, enqueueBrowserTest } from '../queue/queue';
import { config } from '../config';
import { logger } from '../logger';
import { getGitHubIssueSummary } from '../services/githubIssue';
import { deriveTestPlanFromIssue } from '../services/issueTestPlanner';
import type {
  RunTestFromIssueRequestBody,
  RunTestJobData,
  RunTestRequestBody,
  RunTestResult,
  RunTestStatusResponse,
} from '../types/runTest';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseRequestBody = (body: unknown): { data?: RunTestRequestBody; error?: string } => {
  if (!isObject(body)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const task = typeof body.task === 'string' ? body.task.trim() : '';

  if (!url) {
    return { error: 'Field "url" is required.' };
  }

  if (!task) {
    return { error: 'Field "task" is required.' };
  }

  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { error: 'Field "url" must use http or https.' };
    }
  } catch {
    return { error: 'Field "url" must be a valid absolute URL.' };
  }

  return {
    data: {
      url,
      task,
    },
  };
};

const parseIssueRequestBody = (
  body: unknown,
): { data?: RunTestFromIssueRequestBody; error?: string } => {
  if (!isObject(body)) {
    return { error: 'Request body must be a JSON object.' };
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const issueUrl = typeof body.issueUrl === 'string' ? body.issueUrl.trim() : '';

  if (!url) {
    return { error: 'Field "url" is required.' };
  }

  if (!issueUrl) {
    return { error: 'Field "issueUrl" is required.' };
  }

  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { error: 'Field "url" must use http or https.' };
    }
  } catch {
    return { error: 'Field "url" must be a valid absolute URL.' };
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
      url,
      issueUrl,
    },
  };
};

const buildFailureResult = (summary: string, logs: string[] = []): RunTestResult => ({
  success: false,
  summary,
  steps: [],
  logs,
});

export const runTest = async (req: Request, res: Response): Promise<void> => {
  const parsed = parseRequestBody(req.body);

  if (!parsed.data) {
    res.status(400).json({
      error: parsed.error,
    });
    return;
  }

  const payload: RunTestJobData = {
    ...parsed.data,
    maxSteps: config.agentMaxSteps,
    timeoutSeconds: config.jobTimeoutSeconds,
    submittedAt: new Date().toISOString(),
  };

  const job = await enqueueBrowserTest(payload);

  logger.info(
    {
      jobId: job.id,
      url: payload.url,
    },
    'Queued browser test job',
  );

  res.status(202).json({
    jobId: job.id,
    status: 'queued',
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

  const issue = await getGitHubIssueSummary(parsed.data.issueUrl);
  const plan = await deriveTestPlanFromIssue(issue);

  const payload: RunTestJobData = {
    url: parsed.data.url,
    task: plan.task,
    maxSteps: config.agentMaxSteps,
    timeoutSeconds: config.jobTimeoutSeconds,
    submittedAt: new Date().toISOString(),
    source: {
      issueUrl: issue.url,
      issueTitle: issue.title,
    },
  };

  const job = await enqueueBrowserTest(payload);

  logger.info(
    {
      jobId: job.id,
      url: payload.url,
      issueUrl: issue.url,
    },
    'Queued browser test job from GitHub issue',
  );

  res.status(202).json({
    jobId: job.id,
    status: 'queued',
    issue: {
      url: issue.url,
      title: issue.title,
      repository: issue.repository,
      number: issue.number,
    },
    generatedTask: plan.task,
    generatedSteps: plan.steps,
    summary: plan.summary,
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
  const response: RunTestStatusResponse = {
    jobId: job.id ?? id,
    status: state,
    attemptsMade: job.attemptsMade,
  };

  if (state === 'completed') {
    response.result = job.returnvalue as RunTestResult;
  } else if (state === 'failed') {
    response.result = buildFailureResult(job.failedReason ?? 'Job failed.', [
      ...(job.stacktrace ?? []),
    ]);
  }

  res.json(response);
};
