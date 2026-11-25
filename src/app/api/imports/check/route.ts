import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { checkGateway } from '@/server/imports/store';
export async function POST(request: Request) {
  return endpoint(request, async () => checkGateway(await requireActor(request)));
}
