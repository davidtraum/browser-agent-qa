import { parseArgs, requireStringFlag } from './args';
import { stopManagedTask } from './client';

const usage = `Usage:
  stop-test --serviceUrl URL --testId ID

Examples:
  stop-test --serviceUrl http://localhost:3000 --testId 42`;

export const runStopTestCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }

  const parsed = parseArgs(argv);
  const serviceUrl = requireStringFlag(parsed, 'serviceUrl');
  const testId = requireStringFlag(parsed, 'testId');

  const result = await stopManagedTask({
    serviceUrl,
    testId,
  });

  console.log(`testId: ${result.jobId}`);
  console.log(`action: ${result.action}`);
  console.log(`previousStatus: ${result.previousStatus}`);
  console.log(`message: ${result.message}`);
};
