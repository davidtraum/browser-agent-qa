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

