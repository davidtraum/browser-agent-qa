export interface RunTestRequestBody {
  url: string;
  task: string;
}

export interface RunTestFromIssueRequestBody {
  url: string;
  issueUrl: string;
}

export interface RunTestJobData {
  url: string;
  task: string;
  maxSteps: number;
  timeoutSeconds: number;
  submittedAt: string;
  source?: {
    issueUrl?: string;
    issueTitle?: string;
  };
}

export interface RunTestResult {
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
}

export interface RunTestStatusResponse {
  jobId: string;
  status: string;
  attemptsMade: number;
  result?: RunTestResult;
}

export interface GitHubIssueSummary {
  url: string;
  apiUrl: string;
  repository: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: Array<{
    author: string;
    body: string;
    createdAt: string;
  }>;
}

export interface DerivedIssueTestPlan {
  task: string;
  steps: string[];
  summary: string;
}
