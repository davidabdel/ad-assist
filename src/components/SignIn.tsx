'use client';

import { useState } from 'react';
import { useSession } from '@/components/Session';
import { Button, Callout, Card, Field, inputClass, Shell } from '@/components/ui';

export function SignIn() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="mb-8">
        <h1 className="text-5xl font-bold">
          Ad Assist<span className="text-accent">.</span>
        </h1>
        <p className="mt-3 text-lg text-zinc-500">Sign in to build a campaign.</p>
      </div>
      <Card>
        <form onSubmit={submit} className="space-y-5">
          <Field label="Email">
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          {error ? <Callout tone="error">{error}</Callout> : null}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
      <p className="mt-6 text-sm text-zinc-500">
        There is one account. If the password does not work, it can be reset from the
        Supabase dashboard under Authentication → Users.
      </p>
    </Shell>
  );
}
