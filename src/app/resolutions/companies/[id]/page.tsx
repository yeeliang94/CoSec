import { redirect } from 'next/navigation';

/** Company resolution settings moved to a tab on the company record; old links land there. */
export default async function CompanyResolutionSettings({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect('/companies/' + encodeURIComponent(id) + '?tab=settings');
}
