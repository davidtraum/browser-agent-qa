import { getStringFlag, parseArgs } from './args';
import { fetchManagedTasks } from './client';
import { formatManagedTaskList } from './output';

const usage = `Usage:
  test-tasks --serviceUrl URL [--limit NUMBER]

Examples:
  test-tasks --serviceUrl http://localhost:3000
  test-tasks --serviceUrl http://localhost:3000 --limit 20`;

export const runListTasksCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }

  const parsed = parseArgs(argv);
  const serviceUrl = getStringFlag(parsed, 'serviceUrl');
  if (!serviceUrl) {
    throw new Error('Missing required flag --serviceUrl.');
  }

  const rawLimit = getStringFlag(parsed, 'limit');
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  const tasks = await fetchManagedTasks({
    serviceUrl,
    limit: typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined,
  });

  console.log(formatManagedTaskList(tasks));
};
