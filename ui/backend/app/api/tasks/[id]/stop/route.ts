import { stopManagedTask } from '../../../../../lib/browserAgentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  context: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  const { id } = await context.params;
  const result = await stopManagedTask(id);

  return Response.json(result, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
