import { requireActor } from '@/server/auth';
import { attachment, endpoint } from '@/server/http';
import { readImportFile } from '@/server/imports/store';
import { openFile, ReadError } from '@/server/imports/readers';
import { knownIdentities, maskIdentities } from '@/server/imports/store';

const INLINE: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
type Params = { params: Promise<{ id: string; fileId: string }> };
/**
 * A source file for the review screen: shown inline (PDFs and images), or with ?page=N the text
 * of that page as the app read it, so the quoted value can be marked.
 */
export async function GET(request: Request, { params }: Params) {
  const { id, fileId } = await params;
  const page = Number(new URL(request.url).searchParams.get('page') ?? 0);
  let found: Awaited<ReturnType<typeof readImportFile>> | undefined;
  let unmasked = false;
  const error = await endpoint(request, async () => {
    const actor = await requireActor(request);
    unmasked = actor.capabilities.includes('view_identity');
    found = await readImportFile(actor, id, fileId);
    return { ok: true };
  });
  if (!found) return error;
  const { file, bytes } = found;
  if (page > 0)
    return endpoint(request, async () => {
      try {
        const opened = await openFile(file.kind, file.name, bytes);
        const index = Math.min(page, opened.pages.length) - 1;
        return {
          pages: opened.pages.length,
          page: index + 1,
          text: unmasked
            ? (opened.pages[index] ?? '')
            : maskIdentities(opened.pages[index] ?? '', knownIdentities(found!.row)),
          visual: opened.visual[index] ?? true,
        };
      } catch (e) {
        if (e instanceof ReadError) return { pages: 0, page: 0, text: '', visual: true };
        throw e;
      }
    });
  const ext = file.name.split('.').pop()!.toLowerCase();
  const type = INLINE[ext];
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': type ?? 'application/octet-stream',
      'Content-Disposition': type
        ? `inline; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"`
        : attachment(file.name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      // Shown in a frame on the review screen, from this site only.
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",
    },
  });
}
