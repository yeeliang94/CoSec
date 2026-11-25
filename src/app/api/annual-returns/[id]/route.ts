import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { getReturn, updateReturn } from '@/server/ar1/returns';
import { createDownload } from '@/server/ar1/download';
import { returnActionInput } from '@/server/ar1/inputs';
import type { ReturnAnswers } from '@/domain/ar1/returns';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => getReturn(await requireActor(request), (await params).id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const { id } = await params;
    const body = returnActionInput.parse(await request.json());
    if (body.action === 'create_download') return createDownload(actor, id, body);
    const { answers, application, rectificationDeclaration, courtOrderReference } = body;
    return updateReturn(actor, id, {
      requestId: body.requestId,
      expectedRevision: body.expectedRevision,
      application,
      rectificationDeclaration,
      courtOrderReference,
      answers: answers as ReturnAnswers | undefined,
    });
  });
}
