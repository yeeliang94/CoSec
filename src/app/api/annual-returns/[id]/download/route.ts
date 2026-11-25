import { requireActor } from '@/server/auth';
import { attachment, endpoint } from '@/server/http';
import { downloadVersion } from '@/server/ar1/download';
import { XLSX_MIME } from '@/server/storage';

/** The stored file of one version (`?version=n`); hash-checked and audited. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let file: Awaited<ReturnType<typeof downloadVersion>> | undefined;
  const error = await endpoint(request, async () => {
    const version = Number(new URL(request.url).searchParams.get('version'));
    file = await downloadVersion(await requireActor(request), (await params).id, version);
    return { ok: true };
  });
  if (!file) return error;
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': attachment(file.fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
