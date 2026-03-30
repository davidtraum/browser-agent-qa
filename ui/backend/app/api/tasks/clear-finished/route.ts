import { clearFinishedManagedTasks } from '../../../../lib/browserAgentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await clearFinishedManagedTasks();

  return Response.json(result, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
