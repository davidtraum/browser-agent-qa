import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const ENV_CANDIDATES = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
];

for (const candidate of ENV_CANDIDATES) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
  }
}

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseNumber(process.env.PORT, 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  queueName: process.env.QUEUE_NAME ?? 'browser-tests',
  jobTimeoutSeconds: parseNumber(process.env.JOB_TIMEOUT_SECONDS, 120),
  agentMaxSteps: parseNumber(process.env.AGENT_MAX_STEPS, 20),
  openAiApiKey: process.env.OPENAI_API_KEY ?? '',
  issuePlannerModel: process.env.ISSUE_PLANNER_MODEL ?? 'gpt-4o-mini',
  githubToken: process.env.GITHUB_TOKEN ?? '',
  jobAttempts: 3,
} as const;
