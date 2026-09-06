import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getPublicPage, listPublicPaths } from '@/lib/page-data';
import { Listicle } from '@/components/Listicle';
import { ViewPing } from '@/components/ViewPing';

// Next 16: params is a Promise. Synchronous access was removed in this major.
type Props = { params: Promise<{ campaignSlug: string; personaSlug: string }> };

// Meta's ad review crawler must get a fast, complete HTML response or it can
// reject the destination. Pre-render every known persona URL; anything created
// after the last build still renders on demand.
export const revalidate = 60;

export async function generateStaticParams() {
  return listPublicPaths();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { campaignSlug, personaSlug } = await params;
  const page = await getPublicPage(campaignSlug, personaSlug).catch(() => null);
  if (!page) return {};
  return {
    title: page.page_title,
    description: page.meta_description ?? undefined,
    openGraph: {
      title: page.page_title,
      description: page.meta_description ?? undefined,
    },
    // These pages exist to be landed on from a paid ad, not to rank. Indexing
    // 20 near-identical pages is a thin-content problem we do not need.
    robots: { index: false, follow: false },
  };
}

export default async function PersonaPage({ params }: Props) {
  const { campaignSlug, personaSlug } = await params;
  const page = await getPublicPage(campaignSlug, personaSlug);
  if (!page) notFound();
  return (
    <>
      <ViewPing personaId={page.persona_id} />
      <Listicle page={page} />
    </>
  );
}
