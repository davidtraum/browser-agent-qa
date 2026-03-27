import { backendConfig } from './config';

export interface RunFromIssueResponse {
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

export interface RunStatusResponse {
  jobId: string;
  status: string;
  attemptsMade: number;
  progress?: {
    stage:
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
    message: string;
    detail?: string;
    stepNumber?: number;
    sequence?: number;
    timestamp?: string;
    screenshot?: string;
  };
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
      branch?: string | null;
    };
  };
}

export interface ManagedTaskSummaryResponse {
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
  progress?: RunStatusResponse['progress'];
}

export interface ManagedTaskListResponse {
  running: ManagedTaskSummaryResponse[];
  pending: ManagedTaskSummaryResponse[];
}

export interface StopTaskResult {
  jobId: string;
  action: 'removed' | 'cancellation_requested';
  previousStatus: string;
  message: string;
}

export interface ShopwareBranchResponse {
  defaultBranch: string;
  branches: Array<{
    name: string;
    commitSha: string;
  }>;
}

const readJson = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with ${response.status}.`);
  }

  return payload;
};

export const listShopwareBranches = async (query?: string): Promise<ShopwareBranchResponse> => {
  const search = query ? `?q=${encodeURIComponent(query)}` : '';
  const response = await fetch(`${backendConfig.browserAgentServiceUrl}/shopware/branches${search}`, {
    method: 'GET',
    cache: 'no-store',
  });

  return readJson<ShopwareBranchResponse>(response);
};

export const queueIssueRun = async (issueUrl: string, branch: string): Promise<RunFromIssueResponse> => {
  const response = await fetch(`${backendConfig.browserAgentServiceUrl}/run-test-from-issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      branch,
      issueUrl,
    }),
    cache: 'no-store',
  });

  return readJson<RunFromIssueResponse>(response);
};

export const streamIssueRun = async (issueUrl: string, branch: string): Promise<Response> =>
  fetch(`${backendConfig.browserAgentServiceUrl}/run-test-from-issue/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify({
      branch,
      issueUrl,
    }),
    cache: 'no-store',
  });

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

export const listManagedTasks = async (limit?: number): Promise<ManagedTaskListResponse> => {
  const search =
    typeof limit === 'number' && Number.isFinite(limit) ? `?limit=${encodeURIComponent(String(limit))}` : '';
  const response = await fetch(`${backendConfig.browserAgentServiceUrl}/tasks${search}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  return readJson<ManagedTaskListResponse>(response);
};

export const stopManagedTask = async (jobId: string): Promise<StopTaskResult> => {
  const response = await fetch(`${backendConfig.browserAgentServiceUrl}/tasks/${encodeURIComponent(jobId)}/stop`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
  });

  return readJson<StopTaskResult>(response);
};
