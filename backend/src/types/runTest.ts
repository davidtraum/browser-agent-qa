export interface RunTestRequestBody {
  task: string;
  branch?: string;
}

export interface RunTestFromIssueRequestBody {
  issueUrl: string;
  branch?: string;
}

export interface RunTestJobData {
  url: string;
  task: string;
  branch: string;
  maxSteps: number;
  timeoutSeconds: number;
  submittedAt: string;
  source?: {
    issueUrl?: string;
    issueTitle?: string;
    repository?: string;
  };
  shopware?: {
    branch: string;
    adminUrl: string;
    workspaceDir: string;
    adminUsername: string;
    adminPassword: string;
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
    branch?: string | null;
    cancelled?: boolean;
  };
}

export interface RunTestStatusResponse {
  jobId: string;
  status: string;
  attemptsMade: number;
  progress?: ProgressEventPayload;
  progressEvents?: ProgressEventPayload[];
  historyEvents?: RunTestFromIssueStreamEvent[];
  result?: RunTestResult;
}

export interface ManagedTaskSummary {
  jobId: string;
  status: string;
  attemptsMade: number;
  resultSuccess?: boolean;
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
  progress?: ProgressEventPayload;
}

export interface ManagedTaskListResponse {
  running: ManagedTaskSummary[];
  pending: ManagedTaskSummary[];
  recent: ManagedTaskSummary[];
}

export interface StopTaskResponse {
  jobId: string;
  action: 'removed' | 'cancellation_requested';
  previousStatus: string;
  message: string;
}

export interface ClearFinishedTasksResponse {
  clearedJobIds: string[];
  removedCount: number;
  message: string;
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

export interface ShopwareBranchInfo {
  name: string;
  commitSha: string;
}

export interface ShopwareBranchListResponse {
  defaultBranch: string;
  branches: ShopwareBranchInfo[];
}

export interface PreparedShopwareInstance {
  branch: string;
  workspaceDir: string;
  adminUrl: string;
  adminUsername: string;
  adminPassword: string;
}

export interface ProgressEventPayload {
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
}

export interface StreamedIssueReference {
  url: string;
  title: string;
  repository: string;
  number: number;
}

export type RunTestFromIssueStreamEvent =
  | {
      type: 'accepted';
      issueUrl: string;
      branch: string;
      timestamp: string;
    }
  | ({
      type: 'progress';
      timestamp: string;
    } & ProgressEventPayload)
  | {
      type: 'issue';
      issue: StreamedIssueReference;
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
