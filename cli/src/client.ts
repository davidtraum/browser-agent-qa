import type { RunTestResult } from './types';

type ProgressStage =
  | 'issue'
  | 'planning'
  | 'branch'
  | 'checkout'
  | 'pull'
  | 'docker'
  | 'setup'
  | 'watch'
  | 'ready'
  | 'queue'
  | 'execution';

export interface ProgressSnapshot {
  stage: ProgressStage;
  message: string;
  detail?: string;
  stepNumber?: number;
  sequence?: number;
  screenshot?: string;
  timestamp?: string;
}

export type IssueRunStreamEvent =
  | {
      type: 'accepted';
      issueUrl: string;
      branch: string;
      timestamp: string;
    }
  | {
      type: 'progress';
      stage: ProgressStage;
      message: string;
      detail?: string;
      stepNumber?: number;
      sequence?: number;
      screenshot?: string;
      timestamp: string;
    }
  | {
      type: 'issue';
      issue: {
        url: string;
        title: string;
        repository: string;
        number: number;
      };
    }
  | {
      type: 'plan';
      summary: string;
      generatedTask: string;
      generatedSteps: string[];
    }
  | {
      type: 'job';
      jobId: string;
      branch: string;
      adminUrl: string;
    }
  | {
      type: 'status';
      status: string;
      attemptsMade: number;
    }
  | {
      type: 'result';
      result: RunTestResult;
    }
  | {
      type: 'error';
      message: string;
    };

export interface RunTestFromIssueCliResponse {
  jobId: string;
  status: string;
  branch: string;
  adminUrl: string;
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

export interface TestStatusCliResponse {
  jobId: string;
  status: string;
  attemptsMade: number;
  progress?: ProgressSnapshot;
  result?: RunTestResult;
}

export interface ManagedTaskSummaryCliResponse {
  jobId: string;
  status: string;
  attemptsMade: number;
  branch?: string;
  issueUrl?: string;
  issueTitle?: string;
  repository?: string;
  adminUrl?: string;
  submittedAt?: string;
  createdAt?: string;
  processedAt?: string;
  finishedAt?: string;
  cancellationRequested?: boolean;
  progress?: ProgressSnapshot;
}

export interface ManagedTaskListCliResponse {
  running: ManagedTaskSummaryCliResponse[];
  pending: ManagedTaskSummaryCliResponse[];
}

export interface StopTaskCliResponse {
  jobId: string;
  action: 'removed' | 'cancellation_requested';
  previousStatus: string;
  message: string;
}

const normalizeServiceUrl = (serviceUrl: string): string => serviceUrl.replace(/\/+$/, '');

const readJsonResponse = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    const errorMessage =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : `Request failed with ${response.status}.`;
    throw new Error(errorMessage);
  }

  return payload;
};

export const queueTestFromIssue = async (params: {
  branch?: string;
  issueUrl: string;
  serviceUrl: string;
}): Promise<RunTestFromIssueCliResponse> => {
  const response = await fetch(`${normalizeServiceUrl(params.serviceUrl)}/run-test-from-issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      branch: params.branch,
      issueUrl: params.issueUrl,
    }),
  });

  return readJsonResponse<RunTestFromIssueCliResponse>(response);
};

export const streamTestFromIssue = async (
  params: {
    branch?: string;
    issueUrl: string;
    serviceUrl: string;
  },
  onEvent: (event: IssueRunStreamEvent) => void,
): Promise<void> => {
  const response = await fetch(`${normalizeServiceUrl(params.serviceUrl)}/run-test-from-issue/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify({
      branch: params.branch,
      issueUrl: params.issueUrl,
    }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      onEvent(JSON.parse(trimmed) as IssueRunStreamEvent);
    }
  }

  const remaining = buffer.trim();
  if (remaining) {
    onEvent(JSON.parse(remaining) as IssueRunStreamEvent);
  }
};

export const fetchTestStatus = async (params: {
  serviceUrl: string;
  testId: string;
}): Promise<TestStatusCliResponse> => {
  const response = await fetch(
    `${normalizeServiceUrl(params.serviceUrl)}/run-test/${encodeURIComponent(params.testId)}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    },
  );

  return readJsonResponse<TestStatusCliResponse>(response);
};

export const fetchManagedTasks = async (params: {
  serviceUrl: string;
  limit?: number;
}): Promise<ManagedTaskListCliResponse> => {
  const search =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? `?limit=${encodeURIComponent(String(params.limit))}`
      : '';
  const response = await fetch(`${normalizeServiceUrl(params.serviceUrl)}/tasks${search}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  return readJsonResponse<ManagedTaskListCliResponse>(response);
};

export const stopManagedTask = async (params: {
  serviceUrl: string;
  testId: string;
}): Promise<StopTaskCliResponse> => {
  const response = await fetch(
    `${normalizeServiceUrl(params.serviceUrl)}/tasks/${encodeURIComponent(params.testId)}/stop`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
    },
  );

  return readJsonResponse<StopTaskCliResponse>(response);
};
