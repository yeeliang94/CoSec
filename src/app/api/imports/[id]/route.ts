import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { batchActionInput, changeImport, getImport } from '@/server/imports/store';
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) {
  return endpoint(request, async () => getImport(await requireActor(request), (await params).id));
}
export async function POST(request: Request, { params }: Params) {
  return endpoint(request, async () =>
    changeImport(
      await requireActor(request),
      (await params).id,
      batchActionInput.parse(await request.json()),
    ),
  );
}
