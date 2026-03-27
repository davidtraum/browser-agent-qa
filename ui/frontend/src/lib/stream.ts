import type {
  ClearFinishedTasksResponse,
  FeedEvent,
  ManagedTaskList,
  ShopwareBranchOption,
  StopTaskResponse,
  TaskStatusResponse,
} from '../types';

const configuredBackendUrl = (import.meta.env.VITE_UI_BACKEND_URL ?? '').trim().replace(/\/+$/, '');

const apiUrl = (path: string): string => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return configuredBackendUrl ? `${configuredBackendUrl}${normalizedPath}` : normalizedPath;
};

export const fetchBranches = async (query?: string): Promise<{
  defaultBranch: string;
  branches: ShopwareBranchOption[];
}> => {
  const search = query ? `?q=${encodeURIComponent(query)}` : '';
  const response = await fetch(apiUrl(`/api/shopware/branches${search}`));

  if (!response.ok) {
    throw new Error(`Failed to load Shopware branches (${response.status}).`);
  }

  return (await response.json()) as {
    defaultBranch: string;
    branches: ShopwareBranchOption[];
  };
};

export const streamIssueRun = async (
  issueUrl: string,
  branch: string,
  onEvent: (event: FeedEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await fetch(apiUrl('/api/issue-feed'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ issueUrl, branch }),
    signal,
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

      onEvent(JSON.parse(trimmed) as FeedEvent);
    }
  }

  const remaining = buffer.trim();
  if (remaining) {
    onEvent(JSON.parse(remaining) as FeedEvent);
  }
};

export const fetchTasks = async (limit = 25): Promise<ManagedTaskList> => {
  const response = await fetch(apiUrl(`/api/tasks?limit=${encodeURIComponent(String(limit))}`), {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Failed to load tasks (${response.status}).`);
  }

  return (await response.json()) as ManagedTaskList;
};

export const fetchTaskStatus = async (taskId: string): Promise<TaskStatusResponse> => {
  const response = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(taskId)}`), {
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to load task ${taskId} (${response.status}).`);
  }

  return (await response.json()) as TaskStatusResponse;
};

export const stopTask = async (taskId: string): Promise<StopTaskResponse> => {
  const response = await fetch(apiUrl(`/api/tasks/${encodeURIComponent(taskId)}/stop`), {
    method: 'POST',
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to stop task ${taskId} (${response.status}).`);
  }

  return (await response.json()) as StopTaskResponse;
};

export const clearFinishedTasks = async (): Promise<ClearFinishedTasksResponse> => {
  const response = await fetch(apiUrl('/api/tasks/clear-finished'), {
    method: 'POST',
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to clear finished tasks (${response.status}).`);
  }

  return (await response.json()) as ClearFinishedTasksResponse;
};
