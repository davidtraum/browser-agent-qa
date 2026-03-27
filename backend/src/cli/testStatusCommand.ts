import { parseArgs, requireStringFlag } from './args';
import { fetchTestStatus } from './client';
import { formatStatusSummary } from './output';

const usage = `Usage:
  test-status --serviceUrl URL --testId ID

Example:
  test-status --serviceUrl http://localhost:3000 --testId 42`;

export const runTestStatusCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }

  const parsed = parseArgs(argv);
  const serviceUrl = requireStringFlag(parsed, 'serviceUrl');
  const testId = requireStringFlag(parsed, 'testId');

  const status = await fetchTestStatus({
    serviceUrl,
    testId,
  });

  console.log(formatStatusSummary(status));
};

