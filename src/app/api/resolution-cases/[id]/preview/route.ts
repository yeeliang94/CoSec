import { z } from 'zod';
import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { previewCase } from '@/server/resolution/selection';

const body = z.object({ candidateVersionId: z.string().min(1).max(100).optional() });

/** Compiles the saved draft against live records, optionally with wording being tried out; nothing is stored. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const { candidateVersionId } = body.parse(await request.json().catch(() => ({})));
    return previewCase(actor, (await params).id, candidateVersionId);
  });
}
