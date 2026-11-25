import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { addImportFile, MAX_IMPORT_FILE_BYTES } from '@/server/imports/store';
import { DomainError } from '@/domain/access';
const MAX_REQUEST_BYTES = MAX_IMPORT_FILE_BYTES + 64 * 1024;
/** One file of a company folder. Files that will not be read are listed without their bytes. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const declared = Number(request.headers.get('content-length'));
    if (!declared) throw new DomainError('The upload size is unavailable. Try again.', 'SIZE', 411);
    if (declared > MAX_REQUEST_BYTES)
      throw new DomainError('Files must be 50 MB or smaller.', 'SIZE', 413);
    const form = await request.formData();
    const file = form.get('file');
    return addImportFile(actor, (await params).id, {
      rowId: String(form.get('rowId') ?? ''),
      path: String(form.get('path') ?? ''),
      size: Number(form.get('size') ?? 0) || 0,
      file: file instanceof File ? file : null,
    });
  });
}
