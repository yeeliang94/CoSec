import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { changeImportRow, getImportCompany, readRow, rowActionInput } from '@/server/imports/store';
import { applyImportCompany, applyInput, applyPlan } from '@/server/imports/apply';
type Params = { params: Promise<{ id: string; rowId: string }> };
export async function GET(request: Request, { params }: Params) {
  return endpoint(request, async () => {
    const { id, rowId } = await params;
    const detail = await getImportCompany(await requireActor(request), id, rowId);
    return { ...detail, plan: applyPlan(await readRow(rowId)) };
  });
}
export async function POST(request: Request, { params }: Params) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const { id, rowId } = await params;
    const body = await request.json();
    if (body?.action === 'apply')
      return applyImportCompany(actor, id, rowId, applyInput.parse(body));
    return changeImportRow(actor, id, rowId, rowActionInput.parse(body));
  });
}
