import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { listReturns, startReturn } from '@/server/ar1/returns';
import { startReturnInput } from '@/server/ar1/inputs';

export async function GET(request: Request) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const companyId = new URL(request.url).searchParams.get('companyId') ?? undefined;
    return listReturns(actor, companyId);
  });
}

export async function POST(request: Request) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    return startReturn(actor, startReturnInput.parse(await request.json()));
  });
}
