import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { changeCharge, listCharges } from '@/server/records/charges';
import { chargeInput } from '@/server/records/inputs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    return listCharges(actor, (await params).id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const body = chargeInput.parse(await request.json());
    return changeCharge(actor, (await params).id, body);
  });
}
