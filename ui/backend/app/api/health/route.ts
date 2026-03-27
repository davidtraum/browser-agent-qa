import { NextResponse } from 'next/server';
import { backendConfig } from '../../../lib/config';

export async function GET() {
  return NextResponse.json({
    ok: true,
    serviceUrl: backendConfig.browserAgentServiceUrl,
  });
}
