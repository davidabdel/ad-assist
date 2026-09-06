import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getPublicPage } from '@/lib/page-data';
import { Listicle } from '@/components/Listicle';

type Props = { params: Promise<{ campaignSlug: string }> };

export const revalidate = 60;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { campaignSlug } = await params;
  const page = await getPublicPage(campaignSlug).catch(() => null);
  if (!page) return {};
  return {
    title: page.page_title,
    description: page.meta_description ?? undefined,
    robots: { index: false, follow: false },
  };
}

/** The un-personalised base page. Useful as a control against the 20 variants. */
export default async function BasePage({ params }: Props) {
  const { campaignSlug } = await params;
  const page = await getPublicPage(campaignSlug);
  if (!page) notFound();
  return <Listicle page={page} />;
}
