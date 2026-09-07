'use client';

import { useState } from 'react';

/**
 * The other half of the vehicle CTA.
 *
 * A tap-to-call button only converts the buyer who is free to talk right now.
 * On a used vehicle the person scrolling a listicle at 10pm is the buyer, and
 * the form is the only way to catch them — so the two sit together and neither
 * one is the fallback.
 *
 * IT POSTS TO OUR OWN API, NOT TO SUPABASE. The anon key ships in the browser
 * on every one of these pages, so an anon insert grant on `leads` would be a
 * spam queue with a schema. The route writes with the service role, which means
 * the only way to add a row is through a check we control.
 *
 * NO CLIENT-SIDE VALIDATION BEYOND `required`. Every rule that matters is on the
 * server, and a second copy here would be one more thing to drift.
 */

type State = 'idle' | 'sending' | 'sent' | 'error';

export function EnquiryForm({
  campaignId, personaId, phone,
}: { campaignId: string; personaId: string | null; phone: string | null }) {
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setState('sending');
    setError(null);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaign_id: campaignId,
          persona_id: personaId,
          name: form.get('name'),
          phone: form.get('phone'),
          email: form.get('email') || undefined,
          message: form.get('message') || undefined,
          // Honeypot. A real person never sees this field, so anything in it
          // came from something filling every input on the page.
          website: form.get('website') || undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body as { error?: string })?.error ?? 'That did not send.');
      setState('sent');
    } catch (err) {
      setError((err as Error).message);
      setState('error');
    }
  }

  if (state === 'sent') {
    return (
      <div
        id="enquire"
        className="mt-8 rounded-[var(--brand-radius)] p-6 text-center sm:p-8"
        style={{ background: 'var(--brand-tint)' }}
      >
        <p className="text-lg font-semibold">Thanks — that came through.</p>
        <p className="mt-2 leading-relaxed" style={{ color: 'var(--brand-muted)' }}>
          You will get a call back about this one.
          {phone ? ' If you would rather not wait, ring the number above.' : ''}
        </p>
      </div>
    );
  }

  return (
    <form
      id="enquire"
      onSubmit={onSubmit}
      className="mt-8 rounded-[var(--brand-radius)] p-6 text-left sm:p-8"
      style={{ background: 'var(--brand-tint)' }}
    >
      <p className="text-lg font-semibold">Or leave your number</p>
      <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--brand-muted)' }}>
        Ask anything — the service history, whether it is still available, when you could
        come and look at it.
      </p>

      <div className="mt-5 space-y-3">
        <Input name="name" label="Your name" required autoComplete="name" />
        <Input name="phone" label="Best number" required type="tel" autoComplete="tel" />
        <Input name="email" label="Email (optional)" type="email" autoComplete="email" />
        <label className="block">
          <span className="text-sm font-semibold">Your question (optional)</span>
          <textarea
            name="message"
            rows={3}
            maxLength={2000}
            className="mt-1.5 w-full rounded-[var(--brand-radius)] border px-3.5 py-2.5 text-base"
            style={{ borderColor: 'var(--brand-rule)', background: 'var(--brand-surface)' }}
          />
        </label>

        {/* Honeypot: off-screen rather than display:none, which some bots skip. */}
        <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
          <label>
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
      </div>

      {error ? <p className="mt-4 text-sm font-medium text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={state === 'sending'}
        className="mt-5 w-full rounded-[var(--brand-radius)] px-6 py-3.5 text-base font-semibold
                   transition hover:opacity-90 disabled:opacity-50"
        style={{ background: 'var(--brand-primary)', color: 'var(--brand-on-primary)' }}
      >
        {state === 'sending' ? 'Sending…' : 'Send my details'}
      </button>
    </form>
  );
}

function Input({
  name, label, ...rest
}: { name: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-sm font-semibold">{label}</span>
      <input
        {...rest}
        name={name}
        className="mt-1.5 w-full rounded-[var(--brand-radius)] border px-3.5 py-2.5 text-base"
        style={{ borderColor: 'var(--brand-rule)', background: 'var(--brand-surface)' }}
      />
    </label>
  );
}
