'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { EMPTY_DRAFT, loadDraft, normaliseUrl, saveDraft, titleFromUrl } from '@/lib/wizard-draft';
import { Logo } from '@/components/ui';

type Preview = {
  url: string; title: string; brand: string | null; price: number | null; currency: string | null;
  imageCount: number; reviewCount: number; description: string; warnings: string[];
};

export function FreeScan() {
  const params = useSearchParams();
  const [url, setUrl] = useState(() => loadDraft().source_url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const started = useRef(false);

  async function scan(raw: string) {
    const address = normaliseUrl(raw);
    if (!address) { setError('Paste the address of a public product page.'); return; }
    setBusy(true); setError(null); setPreview(null);
    saveDraft({ ...EMPTY_DRAFT, source_url: address, title: titleFromUrl(address) });
    try {
      const response = await fetch('/api/free-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: address }), signal: AbortSignal.timeout(60_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The scan could not finish. Try again.');
      setPreview(data);
      saveDraft({ ...EMPTY_DRAFT, source_url: address, title: String(data.title).slice(0, 60) });
    } catch (e) {
      setError(e instanceof Error && e.name === 'TimeoutError'
        ? 'This store took too long to respond. Please try again.'
        : e instanceof Error ? e.message : 'The scan could not finish. Try again.');
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!started.current && params.get('scan') === '1') {
      started.current = true;
      void scan(loadDraft().source_url);
    }
  }, [params]);

  return (
    <main className="site min-h-screen bg-[#F5F8FC] text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
          <Link href="/" aria-label="AdtoCart home"><Logo size={36} /></Link>
          <Link href="/login" className="text-sm font-bold text-accent">Log in</Link>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <p className="text-sm font-bold uppercase tracking-widest text-accent">Step 1 · Your product</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-5xl">See what we find.<br />Start for free.</h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-zinc-600">Paste your product page. We’ll read its details before you create an account. No card needed.</p>
        <form onSubmit={(e) => { e.preventDefault(); void scan(url); }} className="mt-8 flex flex-col gap-3 sm:flex-row">
          <label className="flex-1">
            <span className="sr-only">Product page address</span>
            <input value={url} onChange={e => setUrl(e.target.value)} disabled={busy} required
              placeholder="yourshop.com/products/your-product" autoComplete="url"
              className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-4 text-base outline-none focus:border-accent" />
          </label>
          <button disabled={busy} className="bg-brand-gradient rounded-xl px-7 py-4 font-bold text-white disabled:opacity-60">
            {busy ? 'Reading your product…' : 'Start for free →'}
          </button>
        </form>
        {busy && <div role="status" aria-live="polite" className="mt-7 rounded-2xl border border-teal-line bg-white p-6">
          <p className="font-bold">Reading the store’s public product page</p>
          <p className="mt-2 text-base leading-relaxed text-zinc-600">Checking product details, available images and readable reviews. Some stores take longer or block automated access.</p>
          <p className="mt-4 text-sm text-accent">Your result will appear here when the scan finishes.</p>
        </div>}
        {error && <div role="alert" className="mt-6 rounded-xl border border-orange-200 bg-orange-50 p-5 text-orange-900">{error}</div>}
        {preview && <section aria-label="Product scan result" className="mt-8 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
          <div className="bg-navy px-6 py-5 text-white"><p className="text-sm font-bold text-teal">✓ Product scan complete</p><h2 className="mt-2 text-2xl font-bold">{preview.title}</h2></div>
          <div className="p-6">
            <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4">
              {[
                ['Brand', preview.brand || 'Not found'],
                ['Price', preview.price === null ? 'Not found' : `${preview.currency || 'Currency unconfirmed'} ${preview.price}`],
                ['Images found', String(preview.imageCount)], ['Reviews read', String(preview.reviewCount)],
              ].map(([label, value]) => <div key={label}><dt className="text-sm text-zinc-500">{label}</dt><dd className="mt-1 break-words text-base font-bold">{value}</dd></div>)}
            </dl>
            <h3 className="mt-7 font-bold">From your product page</h3>
            <p className="mt-2 whitespace-pre-line break-words text-base leading-relaxed text-zinc-600">{preview.description}</p>
            {preview.warnings.map(w => <p key={w} className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{w}</p>)}
            <div className="mt-7 border-t border-zinc-200 pt-6">
              <h3 className="text-xl font-bold">Ready to build your campaign?</h3>
              <p className="mt-2 text-base leading-relaxed text-zinc-600">Create a free account to continue with these details. Your scan is saved for 24 hours in this browser.</p>
              <Link href="/login?mode=up&next=%2Fcampaigns%3Fnew%3D1" className="bg-brand-gradient mt-5 inline-block rounded-xl px-6 py-4 font-bold text-white">Create account to continue →</Link>
              <p className="mt-3 text-sm text-zinc-500">Account creation is free. Generated media is a separate step.</p>
            </div>
          </div>
        </section>}
      </div>
    </main>
  );
}
