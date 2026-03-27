import { backendConfig } from './config';

export interface RunFromIssueResponse {
  jobId: string;
  status: string;
  issue: {
    url: string;
    title: string;
    repository: string;
    number: number;
  };
  generatedTask: string;
  generatedSteps: string[];
  summary: string;
}

export interface RunStatusResponse {
  jobId: string;
  status: string;
  attemptsMade: number;
  result?: {
    success: boolean;
    summary: string;
    steps: string[];
    logs: string[];
    errors?: string[];
    metadata?: {
      durationSeconds?: number;
      attemptsMade?: number;
      finalUrl?: string | null;
    };
  };
}

const readJson = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with ${response.status}.`);
  }

  return payload;
};

export const queueIssueRun = async (issueUrl: string): Promise<RunFromIssueResponse> => {
  const response = await fetch(`${backendConfig.browserAgentServiceUrl}/run-test-from-issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      issueUrl,
      url: backendConfig.targetAppUrl,
    }),
    cache: 'no-store',
  });

  return readJson<RunFromIssueResponse>(response);
};

export const fetchRunStatus = async (jobId: string): Promise<RunStatusResponse> => {
  const response = await fetch(`${backendConfig.browserAgentServiceUrl}/run-test/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  return readJson<RunStatusResponse>(response);
};

