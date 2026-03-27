import { config } from '../config';
import type { GitHubIssueSummary } from '../types/runTest';

const GITHUB_API_VERSION = '2022-11-28';
const MAX_COMMENTS = 5;
const MAX_FIELD_LENGTH = 4000;

const truncate = (value: string, maxLength = MAX_FIELD_LENGTH): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
};

const parseGitHubIssueUrl = (issueUrl: string) => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(issueUrl);
  } catch {
    throw new Error('Field "issueUrl" must be a valid absolute URL.');
  }

  if (parsedUrl.hostname !== 'github.com') {
    throw new Error('Field "issueUrl" must point to github.com.');
  }

  const match = parsedUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/|$)/);
  if (!match) {
    throw new Error('Field "issueUrl" must match https://github.com/<owner>/<repo>/issues/<number>.');
  }

  const [, owner, repo, issueNumber] = match;
  return {
    owner,
    repo,
    issueNumber: Number(issueNumber),
  };
};

const getHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'browser-agent-test-runner',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };

  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }

  return headers;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: getHeaders(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed with ${response.status}: ${body || response.statusText}`);
  }

  return (await response.json()) as T;
};

interface GitHubIssueApiResponse {
  url: string;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name?: string }>;
  comments_url: string;
  number: number;
}

interface GitHubIssueCommentApiResponse {
  user?: { login?: string };
  body?: string | null;
  created_at?: string;
}

export const getGitHubIssueSummary = async (issueUrl: string): Promise<GitHubIssueSummary> => {
  const { owner, repo, issueNumber } = parseGitHubIssueUrl(issueUrl);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;

  const issue = await fetchJson<GitHubIssueApiResponse>(apiUrl);
  const comments = await fetchJson<GitHubIssueCommentApiResponse[]>(issue.comments_url);

  return {
    url: issue.html_url,
    apiUrl: issue.url,
    repository: `${owner}/${repo}`,
    owner,
    repo,
    number: issue.number,
    title: truncate(issue.title ?? ''),
    body: truncate(issue.body ?? ''),
    state: issue.state,
    labels: issue.labels
      .map((label) => label.name?.trim())
      .filter((label): label is string => Boolean(label)),
    comments: comments.slice(0, MAX_COMMENTS).map((comment) => ({
      author: comment.user?.login?.trim() || 'unknown',
      body: truncate(comment.body ?? '', 2000),
      createdAt: comment.created_at ?? '',
    })),
  };
};
