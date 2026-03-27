import type { TestStatusCliResponse } from './client';

const TERMINAL_STATES = new Set(['completed', 'failed']);

export const isTerminalStatus = (status: string): boolean => TERMINAL_STATES.has(status);

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const formatStatusSummary = (status: TestStatusCliResponse): string => {
  const lines = [
    `testId: ${status.jobId}`,
    `status: ${status.status}`,
    `attempts: ${status.attemptsMade}`,
  ];

  if (status.result) {
    lines.push(`success: ${status.result.success}`);
    lines.push(`summary: ${status.result.summary}`);
    if (status.result.steps.length > 0) {
      lines.push('steps:');
      for (const step of status.result.steps) {
        lines.push(`- ${step}`);
      }
    }

    if (status.result.logs.length > 0) {
      lines.push('logs:');
      for (const log of status.result.logs) {
        lines.push(`- ${log}`);
      }
    }
  }

  return lines.join('\n');
};

