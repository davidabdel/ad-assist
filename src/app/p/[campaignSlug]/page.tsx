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

/**
 * The un-personalised base page. Useful as a control against the 20 variants,
 * and it is what the approval screen links to.
 *
 * `preview` is on here and nowhere else: this page is the operator's proof
 * sheet, so an unfilled picture slot should be drawn as a labelled box saying
 * what belongs in it. The twenty live persona URLs are ad destinations and
 * render an unfilled slot as nothing at all.
 */
export default async function BasePage({ params }: Props) {
  const { campaignSlug } = await params;
  const page = await getPublicPage(campaignSlug);
  if (!page) notFound();
  return <Listicle page={page} preview />;
}
