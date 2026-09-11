'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadDraft, saveDraft, titleFromUrl } from '@/lib/wizard-draft';

/**
 * The link box in the hero. Whatever is pasted here is waiting in question two
 * of the wizard after login, so nobody types it twice. Nothing is checked here:
 * the wizard owns validation, and a landing page that refuses a link before you
 * have even signed up is a landing page that loses the visitor.
 */
export function HeroForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');

  function go(e: React.FormEvent) {
    e.preventDefault();
    const pasted = url.trim();
    if (pasted) {
      const draft = loadDraft();
      saveDraft({
        ...draft,
        product_type: 'ecom',
        mode: 'url',
        source_url: pasted,
        title: draft.title.trim() || titleFromUrl(pasted),
      });
    }
    router.push('/campaigns?new=1');
  }

  return (
    <form
      onSubmit={go}
      className="flex max-w-[620px] flex-wrap items-center gap-2.5 rounded-2xl border border-white/15 bg-white/[.06] p-2.5"
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
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
        Build my campaign <span aria-hidden>→</span>
      </button>
    </form>
  );
}
