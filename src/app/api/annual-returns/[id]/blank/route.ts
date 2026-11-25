import { z } from 'zod';
import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { assertMayUploadBlank, uploadBlank } from '@/server/ar1/download';
import { DomainError } from '@/domain/access';
import { MAX_UPLOAD_BYTES } from '@/server/storage';

/** Room for the multipart boundaries and the small text fields sent with the file. */
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

/** Multipart: `file` (the blank .xlsx from mTool), `requestId`, `expectedRevision`. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const { id } = await params;
    // Company access and permission before the body is read.
    await assertMayUploadBlank(actor, id);
    // Reject before parsing: formData() buffers the whole body in memory.
    const declared = Number(request.headers.get('content-length'));
    if (!declared) throw new DomainError('The upload size is unavailable. Try again.', 'SIZE', 411);
    if (declared > MAX_REQUEST_BYTES)
      throw new DomainError('Files must be 15 MiB or smaller.', 'SIZE', 413);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new DomainError('Choose the blank workbook.');
    if (!file.name.toLowerCase().endsWith('.xlsx'))
      throw new DomainError('Upload the .xlsx workbook mTool saved.');
    const meta = z
      .object({ requestId: z.string().uuid(), expectedRevision: z.coerce.number().int().min(0) })
      .parse({ requestId: form.get('requestId'), expectedRevision: form.get('expectedRevision') });
    return uploadBlank(actor, id, { ...meta, file });
  });
}
