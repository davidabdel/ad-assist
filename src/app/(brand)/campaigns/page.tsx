import { Authed } from '@/components/Authed';
import { Home } from '@/components/Home';

/**
 * Signed in, this is the campaign list, or the wizard directly when there is
 * nothing in the list yet. Signed out, `Authed` sends you to /login.
 *
 * Client-rendered on purpose. Every read goes through an API route that verifies
 * a Supabase access token, so there is one authorisation path in the app rather
 * than a server-rendered one and a browser one that can disagree.
 */
export const metadata = {
  title: 'Your campaigns — AdToCart',
};

export default function Page() {
  return (
    <Authed>
      <Home />
    </Authed>
  );
}
