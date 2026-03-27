const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const backendConfig = {
  browserAgentServiceUrl: (process.env.BROWSER_AGENT_SERVICE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 2500),
} as const;
