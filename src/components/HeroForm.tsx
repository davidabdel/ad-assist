'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EMPTY_DRAFT, normaliseUrl, saveDraft, titleFromUrl } from '@/lib/wizard-draft';

export function HeroForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  function go(e: React.FormEvent) {
    e.preventDefault();
    const pasted = normaliseUrl(url);
    if (!pasted) { setError('Paste a valid product page address to start.'); return; }
    saveDraft({ ...EMPTY_DRAFT, source_url: pasted, title: titleFromUrl(pasted) });
    router.push('/start?scan=1');
  }

  return (
    <form
      onSubmit={go}
      className="flex max-w-[620px] flex-wrap items-center gap-2.5 rounded-2xl border border-white/15 bg-white/[.06] p-2.5"
    >
      <input
        value={url}
        onChange={(e) => { setUrl(e.target.value); setError(''); }}
        required
        placeholder="https://yourshop.com/products/your-product"
        aria-label="Your product page address"
        className="min-w-[240px] flex-1 border-0 bg-transparent px-3.5 py-3.5 text-base font-medium text-white
                   outline-none placeholder:text-[#9AA4B2]"
      />
      <button
        type="submit"
        className="bg-brand-gradient flex items-center gap-[9px] whitespace-nowrap rounded-xl px-6 py-[15px] text-[15px]
                   font-extrabold text-white hover:brightness-[1.08]"
      >
        Start for free <span aria-hidden>→</span>
      </button>
      {error && <p role="alert" className="w-full px-3 text-sm text-orange-200">{error}</p>}
    </form>
  );
}
