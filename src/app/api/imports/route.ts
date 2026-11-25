import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { createImport, createImportInput, listImports } from '@/server/imports/store';
export async function GET(request: Request) {
  return endpoint(request, async () => listImports(await requireActor(request)));
}
export async function POST(request: Request) {
  return endpoint(request, async () =>
    createImport(await requireActor(request), createImportInput.parse(await request.json())),
  );
}
