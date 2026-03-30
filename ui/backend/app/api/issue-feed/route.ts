import { streamIssueRun } from '../../../lib/browserAgentClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isGitHubReferenceUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (
      parsed.hostname === 'github.com' &&
      /^\/[^/]+\/[^/]+\/(issues|pull)\/\d+(?:\/|$)/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { input?: string; issueUrl?: string; branch?: string }
    | null;
  const input =
    typeof body?.input === 'string'
      ? body.input.trim()
      : typeof body?.issueUrl === 'string'
        ? body.issueUrl.trim()
        : '';
  const branch = typeof body?.branch === 'string' && body.branch.trim() ? body.branch.trim() : 'trunk';

  if (!input) {
    return Response.json({ error: 'Field "input" is required.' }, { status: 400 });
  }

  const upstream = await streamIssueRun(input, branch);

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(text || JSON.stringify({ error: `Request failed with ${upstream.status}.` }), {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
