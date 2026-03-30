import type {
  IssueRunStreamEvent,
  ManagedTaskListCliResponse,
  ManagedTaskSummaryCliResponse,
  TestStatusCliResponse,
} from './client';
import type { RunTestResult } from './types';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

export const isTerminalStatus = (status: string): boolean => TERMINAL_STATES.has(status);

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const formatCompactStatusSummary = (status: TestStatusCliResponse): string => {
  const lines = [
    `testId: ${status.jobId}`,
    `status: ${status.status}`,
    `attempts: ${status.attemptsMade}`,
  ];

  if (status.result) {
    lines.push(`success: ${status.result.success}`);
    lines.push(`summary: ${status.result.summary}`);
    if (status.result.metadata?.branch) {
      lines.push(`branch: ${status.result.metadata.branch}`);
    }
  } else if (status.progress) {
    lines.push(`current: ${formatStatusProgress(status.progress)}`);
  }

  return lines.join('\n');
};

export const formatVerboseResultDetails = (result: RunTestResult): string => {
  const lines: string[] = [];

  if (result.steps.length > 0) {
    lines.push('steps:');
    for (const step of result.steps) {
      lines.push(`- ${step}`);
    }
  }

  if (result.logs.length > 0) {
    lines.push('logs:');
    for (const log of result.logs) {
      lines.push(`- ${log}`);
    }
  }

  return lines.join('\n');
};

export const formatVerboseStatusDetails = (status: TestStatusCliResponse): string =>
  status.result ? formatVerboseResultDetails(status.result) : '';

const stageLabels: Record<
  'issue' | 'planning' | 'branch' | 'checkout' | 'pull' | 'docker' | 'setup' | 'watch' | 'ready' | 'queue' | 'execution',
  string
> = {
  issue: 'issue',
  planning: 'planning',
  branch: 'branch',
  checkout: 'checkout',
  pull: 'pull',
  docker: 'docker',
  setup: 'setup',
  watch: 'watch',
  ready: 'ready',
  queue: 'queue',
  execution: 'execution',
};

export const formatProgressEvent = (event: Extract<IssueRunStreamEvent, { type: 'progress' }>): string => {
  const label = stageLabels[event.stage] ?? event.stage;
  return event.detail ? `progress:${label}: ${event.message} ${event.detail}` : `progress:${label}: ${event.message}`;
};

export const formatStatusProgress = (
  progress: NonNullable<TestStatusCliResponse['progress']>,
): string => (progress.detail ? `${progress.message} ${progress.detail}` : progress.message);

const formatTaskLine = (task: ManagedTaskSummaryCliResponse): string => {
  const label = task.issueTitle || task.issueUrl || task.sourceInput || `Task ${task.jobId}`;
  const branch = task.branch ? `branch=${task.branch}` : undefined;
  const progress = task.progress ? `progress=${formatStatusProgress(task.progress)}` : undefined;
  const cancelling = task.cancellationRequested ? 'cancellation=requested' : undefined;

  return [
    `${task.jobId}`,
    `[${task.status}]`,
    label,
    branch,
    `attempts=${task.attemptsMade}`,
    progress,
    cancelling,
  ]
    .filter(Boolean)
    .join(' | ');
};

export const formatManagedTaskList = (tasks: ManagedTaskListCliResponse): string => {
  const lines: string[] = [];

  lines.push('running:');
  if (tasks.running.length === 0) {
    lines.push('- none');
  } else {
    for (const task of tasks.running) {
      lines.push(`- ${formatTaskLine(task)}`);
    }
  }

  lines.push('pending:');
  if (tasks.pending.length === 0) {
    lines.push('- none');
  } else {
    for (const task of tasks.pending) {
      lines.push(`- ${formatTaskLine(task)}`);
    }
  }

  return lines.join('\n');
};
