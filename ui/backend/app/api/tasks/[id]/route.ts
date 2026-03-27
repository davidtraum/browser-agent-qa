import { fetchRunStatus } from '../../../../lib/browserAgentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: {
    params: Promise<{
      id: string;
    }>;
  },
) {
  const { id } = await context.params;
  const status = await fetchRunStatus(id);

  return Response.json(status, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
