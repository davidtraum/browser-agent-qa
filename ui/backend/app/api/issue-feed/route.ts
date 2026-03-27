import { backendConfig } from '../../../lib/config';
import { fetchRunStatus, queueIssueRun } from '../../../lib/browserAgentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type StreamEvent =
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
      result: NonNullable<Awaited<ReturnType<typeof fetchRunStatus>>['result']>;
    }
  | {
      type: 'error';
      message: string;
    };

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isGitHubIssueUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      parsed.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/issues\/\d+(?:\/|$)/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
};

const serializeEvent = (event: StreamEvent): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(event)}\n`);

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { issueUrl?: string } | null;
  const issueUrl = typeof body?.issueUrl === 'string' ? body.issueUrl.trim() : '';

  if (!issueUrl) {
    return Response.json({ error: 'Field "issueUrl" is required.' }, { status: 400 });
  }

  if (!isGitHubIssueUrl(issueUrl)) {
    return Response.json(
      { error: 'Field "issueUrl" must be a valid GitHub issue URL.' },
      { status: 400 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: StreamEvent) => {
        controller.enqueue(serializeEvent(event));
      };

      try {
        push({
          type: 'accepted',
          issueUrl,
          targetAppUrl: backendConfig.targetAppUrl,
          serviceUrl: backendConfig.browserAgentServiceUrl,
          timestamp: new Date().toISOString(),
        });

        const queuedRun = await queueIssueRun(issueUrl);

        push({
          type: 'issue',
          issue: queuedRun.issue,
        });

        push({
          type: 'plan',
          summary: queuedRun.summary,
          generatedTask: queuedRun.generatedTask,
          generatedSteps: queuedRun.generatedSteps,
        });

        push({
          type: 'job',
          jobId: queuedRun.jobId,
        });

        let previousStatus = '';
        for (;;) {
          const status = await fetchRunStatus(queuedRun.jobId);
          if (status.status !== previousStatus) {
            push({
              type: 'status',
              status: status.status,
              attemptsMade: status.attemptsMade,
            });
            previousStatus = status.status;
          }

          if (status.result) {
            push({
              type: 'result',
              result: status.result,
            });
            break;
          }

          if (status.status === 'failed') {
            push({
              type: 'error',
              message: 'The browser run failed before a result was returned.',
            });
            break;
          }

          await sleep(backendConfig.pollIntervalMs);
        }
      } catch (error) {
        push({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

