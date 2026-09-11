import { Suspense } from 'react';
import { Login } from '@/components/Login';

export const metadata = { title: 'Log in — AdToCart' };

// Suspense because the screen reads ?next= and ?mode= from the URL, which a
// statically rendered route can only do on the client.
export default function Page() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
