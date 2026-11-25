import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { msicDescription, searchMsic } from '@/server/ar1/msic';

/** MSIC 2008 codes in mTool's wording: `?q=` searches, `?code=` describes one code. */
export async function GET(request: Request) {
  return endpoint(request, async () => {
    await requireActor(request);
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    if (code) return { code, description: msicDescription(code) };
    return { codes: searchMsic((url.searchParams.get('q') ?? '').slice(0, 100)) };
  });
}
