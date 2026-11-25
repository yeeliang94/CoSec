import { z } from 'zod';
import { requireActor } from '@/server/auth';
import { endpoint } from '@/server/http';
import { changePerson, listPeople, MAX_PEOPLE_IDS } from '@/server/records/people';
import { personInput, recordId, searchParams } from '@/server/records/inputs';

/** Comma-separated person ids, for example `ids=a,b,c`. */
const idList = z
  .string()
  .transform((value) => value.split(',').filter(Boolean))
  .pipe(z.array(recordId).max(MAX_PEOPLE_IDS));

export async function GET(request: Request) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    const query = z
      .object({
        q: z.string().max(200).optional(),
        companyId: recordId.optional(),
        kind: z.enum(['individual', 'organisation']).optional(),
        ids: idList.optional(),
      })
      .parse(searchParams(request));
    return listPeople(actor, query);
  });
}

export async function POST(request: Request) {
  return endpoint(request, async () => {
    const actor = await requireActor(request);
    return changePerson(actor, personInput.parse(await request.json()));
  });
}
