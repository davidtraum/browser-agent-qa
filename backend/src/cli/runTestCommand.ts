import { getBooleanFlag, parseArgs, requireStringFlag } from './args';
import { fetchTestStatus, queueTestFromIssue } from './client';
import { formatStatusSummary, isTerminalStatus, sleep } from './output';

const POLL_INTERVAL_MS = 3000;

const usage = `Usage:
  run-test --issueUrl URL --url URL --serviceUrl URL [--poll]

Examples:
  run-test --issueUrl https://github.com/acme/app/issues/123 --url http://localhost:5000 --serviceUrl http://localhost:3000
  run-test --issueUrl https://github.com/acme/app/issues/123 --url http://localhost:5000 --serviceUrl http://localhost:3000 --poll`;

export const runRunTestCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }

  const parsed = parseArgs(argv);
  const issueUrl = requireStringFlag(parsed, 'issueUrl');
  const url = requireStringFlag(parsed, 'url');
  const serviceUrl = requireStringFlag(parsed, 'serviceUrl');
  const shouldPoll = getBooleanFlag(parsed, 'poll');

  const queued = await queueTestFromIssue({
    issueUrl,
    serviceUrl,
    url,
  });

  console.log(`testId: ${queued.jobId}`);

  if (!shouldPoll) {
    return;
  }

  console.log(`issue: ${queued.issue.title} (${queued.issue.url})`);
  console.log(`plan: ${queued.summary}`);
  for (const step of queued.generatedSteps) {
    console.log(`- ${step}`);
  }

  let previousStatus = '';
  for (;;) {
    const status = await fetchTestStatus({
      serviceUrl,
      testId: queued.jobId,
    });

    if (status.status !== previousStatus) {
      console.log(`status: ${status.status}`);
      previousStatus = status.status;
    }

    if (isTerminalStatus(status.status)) {
      console.log(formatStatusSummary(status));
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
};

