import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { changeShareEntry, listShares } from '@/server/records/shares';
import { shareEntryInput } from '@/server/records/inputs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    return listShares(actor, (await params).id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const body = shareEntryInput.parse(await request.json());
    return changeShareEntry(actor, (await params).id, body);
  });
}
