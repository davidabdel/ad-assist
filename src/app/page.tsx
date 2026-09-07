import { Authed } from '@/components/Authed';
import { Home } from '@/components/Home';

/**
 * The front door. Signed out it is a login; signed in it is the campaign list,
 * or the wizard directly when there is nothing in the list yet.
 *
 * Client-rendered on purpose. Every read goes through an API route that verifies
 * a Supabase access token, so there is one authorisation path in the app rather
 * than a server-rendered one and a browser one that can disagree.
 */
export const metadata = {
  title: 'Ad Assist',
  description: 'One thing to sell in, a landing page per buyer out.',
};

export default function Page() {
  return (
    <Authed>
      <Home />
    </Authed>
  );
}
