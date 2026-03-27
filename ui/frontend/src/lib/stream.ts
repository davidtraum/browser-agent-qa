import type { FeedEvent } from '../types';

const backendUrl = (import.meta.env.VITE_UI_BACKEND_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

export const streamIssueRun = async (
  issueUrl: string,
  onEvent: (event: FeedEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const response = await fetch(`${backendUrl}/api/issue-feed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ issueUrl }),
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

