import { listManagedTasks } from '../../../lib/browserAgentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get('limit');
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  const tasks = await listManagedTasks(
    typeof parsedLimit === 'number' && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
  );

  return Response.json(tasks, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
