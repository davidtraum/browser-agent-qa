export type FeedEvent =
  | {
      type: 'accepted';
      issueUrl: string;
      targetAppUrl: string;
      serviceUrl: string;
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

export interface TimelineItem {
  id: string;
  label: string;
  detail: string;
  tone: 'info' | 'success' | 'warning' | 'danger';
}

