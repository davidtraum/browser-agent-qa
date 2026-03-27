import { parseArgs, requireStringFlag } from './args';
import { fetchTestStatus } from './client';
import { formatCompactStatusSummary, formatVerboseStatusDetails } from './output';

const usage = `Usage:
  test-status --serviceUrl URL --testId ID [--verbose]

Example:
  test-status --serviceUrl http://localhost:3000 --testId 42
  test-status --serviceUrl http://localhost:3000 --testId 42 --verbose`;

export const runTestStatusCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }

  const parsed = parseArgs(argv);
  const serviceUrl = requireStringFlag(parsed, 'serviceUrl');
  const testId = requireStringFlag(parsed, 'testId');
  const isVerbose = parsed.flags.get('verbose') === true;

  const status = await fetchTestStatus({
    serviceUrl,
    testId,
  });

  console.log(formatCompactStatusSummary(status));
  if (isVerbose) {
    const verboseDetails = formatVerboseStatusDetails(status);
    if (verboseDetails) {
      console.log(verboseDetails);
    }
  }
};
