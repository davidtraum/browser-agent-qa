import { listShopwareBranches } from '../../../../lib/browserAgentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') ?? undefined;
  const branches = await listShopwareBranches(query);

  return Response.json(branches);
}
