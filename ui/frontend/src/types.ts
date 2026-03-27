export type FeedEvent =
  | {
      type: 'accepted';
      issueUrl: string;
      branch: string;
      timestamp: string;
    }
  | {
      type: 'progress';
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
      result: {
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
  | {
      type: 'error';
      message: string;
    };

export interface ProgressSnapshot {
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
  screenshot?: string;
  timestamp?: string;
}

export interface TimelineItem {
  id: string;
  label: string;
  detail: string;
  tone: 'info' | 'success' | 'warning' | 'danger';
  screenshot?: string;
}

export interface ShopwareBranchOption {
  name: string;
  commitSha: string;
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
  progress?: ProgressSnapshot;
}

export interface ManagedTaskList {
  running: ManagedTaskSummary[];
  pending: ManagedTaskSummary[];
  recent: ManagedTaskSummary[];
}

export interface TaskStatusResponse {
  jobId: string;
  status: string;
  attemptsMade: number;
  progress?: ProgressSnapshot;
  progressEvents?: ProgressSnapshot[];
  historyEvents?: FeedEvent[];
  result?: Extract<FeedEvent, { type: 'result' }>['result'];
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
