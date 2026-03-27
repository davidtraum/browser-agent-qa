import type { RunTestResult } from './types';

export interface RunTestFromIssueCliResponse {
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

export interface TestStatusCliResponse {
  jobId: string;
  status: string;
  attemptsMade: number;
  result?: RunTestResult;
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
  issueUrl: string;
  serviceUrl: string;
  url: string;
}): Promise<RunTestFromIssueCliResponse> => {
  const response = await fetch(`${normalizeServiceUrl(params.serviceUrl)}/run-test-from-issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      issueUrl: params.issueUrl,
      url: params.url,
    }),
  });

  return readJsonResponse<RunTestFromIssueCliResponse>(response);
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

