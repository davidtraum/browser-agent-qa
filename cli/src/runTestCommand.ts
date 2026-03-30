import { getBooleanFlag, getStringFlag, parseArgs, requireStringFlag } from './args';
import type { IssueRunStreamEvent, TestStatusCliResponse } from './client';
import { queueTestFromIssue, streamTestFromIssue } from './client';
import { formatCompactStatusSummary, formatProgressEvent, formatVerboseResultDetails } from './output';
const DEFAULT_BRANCH = 'trunk';

const usage = `Usage:
  run-test (--input TEXT | --issueUrl URL) --serviceUrl URL [--branch BRANCH] [--poll] [--verbose]

Examples:
  run-test --input "Open profile settings and verify the avatar is visible" --serviceUrl http://localhost:3000
  run-test --issueUrl https://github.com/shopware/shopware/issues/15805 --serviceUrl http://localhost:3000
  run-test --issueUrl https://github.com/shopware/shopware/pull/12345 --serviceUrl http://localhost:3000
  run-test --issueUrl https://github.com/shopware/shopware/issues/15805 --serviceUrl http://localhost:3000 --branch trunk --poll
  run-test --issueUrl https://github.com/shopware/shopware/issues/15805 --serviceUrl http://localhost:3000 --branch trunk --poll --verbose`;

export const runRunTestCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }

  const parsed = parseArgs(argv);
  const input = getStringFlag(parsed, 'input') || getStringFlag(parsed, 'issueUrl');
  if (!input) {
    throw new Error('Either --input or --issueUrl is required.');
  }
  const serviceUrl = requireStringFlag(parsed, 'serviceUrl');
  const shouldPoll = getBooleanFlag(parsed, 'poll');
  const isVerbose = getBooleanFlag(parsed, 'verbose');
  const branch = getStringFlag(parsed, 'branch') || DEFAULT_BRANCH;

  if (!shouldPoll) {
    const queued = await queueTestFromIssue({
      branch,
      input,
      serviceUrl,
    });

    console.log(`testId: ${queued.jobId}`);
    console.log(`branch: ${queued.branch}`);
    return;
  }

  const finalStatus: TestStatusCliResponse = {
    jobId: 'pending',
    status: 'queued',
    attemptsMade: 0,
  };

  await streamTestFromIssue(
    {
      branch,
      input,
      serviceUrl,
    },
    (event: IssueRunStreamEvent) => {
      switch (event.type) {
        case 'accepted':
          console.log(`stream: accepted ${event.sourceKind} input on branch ${event.branch}`);
          console.log(`branch: ${event.branch}`);
          break;
        case 'progress':
          console.log(formatProgressEvent(event));
          break;
        case 'issue':
          console.log(`${event.issue.kind === 'pull_request' ? 'pr' : 'issue'}: ${event.issue.title} (${event.issue.url})`);
          break;
        case 'plan':
          console.log(`plan: ${event.summary}`);
          if (isVerbose) {
            for (const step of event.generatedSteps) {
              console.log(`- ${step}`);
            }
          }
          break;
        case 'job':
          finalStatus.jobId = event.jobId;
          console.log(`testId: ${event.jobId}`);
          console.log(`admin: ${event.adminUrl}`);
          break;
        case 'status':
          finalStatus.status = event.status;
          finalStatus.attemptsMade = event.attemptsMade;
          console.log(`status: ${event.status}`);
          break;
        case 'result':
          finalStatus.result = event.result;
          finalStatus.status = event.result.success ? 'completed' : 'failed';
          console.log(formatCompactStatusSummary(finalStatus));
          if (isVerbose) {
            const verboseDetails = formatVerboseResultDetails(event.result);
            if (verboseDetails) {
              console.log(verboseDetails);
            }
          }
          break;
        case 'error':
          throw new Error(event.message);
      }
    },
  );
};
