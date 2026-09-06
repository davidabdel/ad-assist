import { Authed } from '@/components/Authed';
import { CampaignProgress } from '@/components/CampaignProgress';

// Next 16: params is a Promise. Synchronous access was removed in this major.
type Props = { params: Promise<{ id: string }> };

export const metadata = { title: 'Building — Ad Assist' };

export default async function CampaignPage({ params }: Props) {
  const { id } = await params;
  return (
    <Authed>
      <CampaignProgress id={id} />
    </Authed>
  );
}
