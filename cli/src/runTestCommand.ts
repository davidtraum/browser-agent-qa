import { getBooleanFlag, parseArgs, requireStringFlag } from './args';
import { fetchTestStatus, queueTestFromIssue } from './client';
import {
  formatCompactStatusSummary,
  formatVerboseStatusDetails,
  isTerminalStatus,
  sleep,
} from './output';

const POLL_INTERVAL_MS = 3000;

const usage = `Usage:
  run-test --issueUrl URL --url URL --serviceUrl URL [--poll] [--verbose]

Examples:
  run-test --issueUrl https://github.com/acme/app/issues/123 --url http://localhost:5000 --serviceUrl http://localhost:3000
  run-test --issueUrl https://github.com/acme/app/issues/123 --url http://localhost:5000 --serviceUrl http://localhost:3000 --poll
  run-test --issueUrl https://github.com/acme/app/issues/123 --url http://localhost:5000 --serviceUrl http://localhost:3000 --poll --verbose`;

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
  const isVerbose = getBooleanFlag(parsed, 'verbose');

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
  if (isVerbose) {
    for (const step of queued.generatedSteps) {
      console.log(`- ${step}`);
    }
  }

  let previousStatus = '';
  for (;;) {
    const status = await fetchTestStatus({
      serviceUrl,
      testId: queued.jobId,
    });

    if (status.status !== previousStatus && !isTerminalStatus(status.status)) {
      console.log(`status: ${status.status}`);
      previousStatus = status.status;
    }

    if (isTerminalStatus(status.status)) {
      console.log(formatCompactStatusSummary(status));
      if (isVerbose) {
        const verboseDetails = formatVerboseStatusDetails(status);
        if (verboseDetails) {
          console.log(verboseDetails);
        }
      }
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
};
