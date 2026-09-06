'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/Session';
import { Button, Callout, Card, Field, inputClass } from '@/components/ui';
import {
  clearDraft, loadDraft, MIN_TEXT, normaliseUrl, REGIONS, saveDraft, titleFromUrl,
  toCreateBody, validateStep, type Draft, type StepErrors,
} from '@/lib/wizard-draft';

/**
 * Four questions, then a summary. One question per screen on purpose: the whole
 * point of this screen is that somebody who has never seen the app can get a
 * campaign running without being told what any of it means.
 *
 * Nothing here spends money and nothing here is irreversible. The last button
 * creates a campaign row and starts the pipeline, which is free until the ad
 * ideas are approved much later — and the summary says so.
 */

const STEPS = [
  'What are you selling?',
  'Where do people buy it?',
  'Who are we advertising to?',
  'Check it over',
];

export function Wizard({ onCancel }: { onCancel?: () => void }) {
  const router = useRouter();
  const { api } = useSession();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [errors, setErrors] = useState<StepErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { saveDraft(draft); }, [draft]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function next() {
    const found = validateStep(step, draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    setStep((s) => Math.min(s + 1, STEPS.length));
  }

  async function start() {
    setBusy(true);
    setSubmitError(null);
    try {
      const { campaign } = await api<{ campaign: { id: string } }>('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify(toCreateBody(draft)),
      });
      clearDraft();
      router.push(`/campaigns/${campaign.id}`);
    } catch (e) {
      setSubmitError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <ol className="mb-6 flex gap-2" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`h-1.5 flex-1 rounded-full ${i + 1 <= step ? 'bg-zinc-900' : 'bg-zinc-300'}`}
          />
        ))}
      </ol>

      <Card>
        <p className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Step {step} of {STEPS.length}
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">{STEPS[step - 1]}</h2>

        <div className="mt-6 space-y-6">
          {step === 1 && <StepProduct draft={draft} set={set} errors={errors} />}
          {step === 2 && <StepCheckout draft={draft} set={set} errors={errors} />}
          {step === 3 && <StepAudience draft={draft} set={set} />}
          {step === 4 && <StepReview draft={draft} onEdit={setStep} />}
        </div>

        {submitError ? (
          <div className="mt-6"><Callout tone="error" title="It did not start">{submitError}</Callout></div>
        ) : null}

        <div className="mt-8 flex items-center justify-between gap-3">
          {step > 1 ? (
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={busy}>Back</Button>
          ) : (
            <span>{onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}</span>
          )}

          {step < STEPS.length
            ? <Button onClick={next}>Next</Button>
            : <Button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Build my campaign'}</Button>}
        </div>
      </Card>
    </div>
  );
}

type SetFn = <K extends keyof Draft>(key: K, value: Draft[K]) => void;

function StepProduct({ draft, set, errors }: { draft: Draft; set: SetFn; errors: StepErrors }) {
  return (
    <>
      <p className="text-base leading-7 text-zinc-600">
        Point us at one product. Everything after this — the buyers, the pages, the ads —
        is built from this one thing, so pick the product you actually want to sell more of.
      </p>

      <div className="flex gap-2">
        <ModeTab active={draft.mode === 'url'} onClick={() => set('mode', 'url')}>
          I have a link
        </ModeTab>
        <ModeTab active={draft.mode === 'text'} onClick={() => set('mode', 'text')}>
          I will type it out
        </ModeTab>
      </div>

      {draft.mode === 'url' ? (
        <Field
          label="Product page address"
          help="Copy the address from your browser when you are looking at the product, and paste it here."
          error={errors.source_url}
        >
          <input
            className={inputClass}
            placeholder="https://yourshop.com/products/your-product"
            value={draft.source_url}
            onChange={(e) => {
              set('source_url', e.target.value);
              // Only fills a name the operator has not touched, so it never
              // overwrites a deliberate one.
              if (!draft.title.trim()) {
                const guess = titleFromUrl(e.target.value);
                if (guess) set('title', guess);
              }
            }}
          />
        </Field>
      ) : (
        <Field
          label="Describe the product"
          help={`What it is, who it is for, what it costs, and what makes it better than the
                 obvious alternative. A short paragraph is enough. Minimum ${MIN_TEXT} characters.`}
          error={errors.raw_input_text}
        >
          <textarea
            className={`${inputClass} min-h-40`}
            placeholder="A merino wool running shoe made in Australia, $160, for commuters who…"
            value={draft.raw_input_text}
            onChange={(e) => set('raw_input_text', e.target.value)}
          />
        </Field>
      )}

      <Field
        label="Campaign name"
        help="Just for you, so you can find this again in the list. Nobody else sees it."
        error={errors.title}
      >
        <input
          className={inputClass}
          placeholder="Tree Runner — spring"
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
        />
      </Field>

      {draft.mode === 'url' ? (
        <Callout tone="info" title="What happens when you press Start">
          We read the page ourselves, in about a second — you do not need to leave anything
          running. A few shops refuse to be read that way; Amazon is one. If yours is one of
          them the next screen says so and hands that page to Chrome on your Mac instead.
        </Callout>
      ) : null}
    </>
  );
}

function StepCheckout({ draft, set, errors }: { draft: Draft; set: SetFn; errors: StepErrors }) {
  return (
    <>
      <p className="text-base leading-7 text-zinc-600">
        Every page we build ends in a button. This is where that button sends people.
      </p>

      <Field
        label="Checkout or buy link"
        help="Usually your cart, or the product page itself. Leave it empty and the button
              points back at the product page you gave us — it still works, it is just not
              as direct."
        error={errors.checkout_url}
      >
        <input
          className={inputClass}
          placeholder="https://yourshop.com/cart"
          value={draft.checkout_url}
          onChange={(e) => set('checkout_url', e.target.value)}
        />
      </Field>

      <Field
        label="What is the current offer?"
        help="Written exactly as a customer should read it. It goes in the bar across the top
              of every page. Leave it empty if there is no offer on right now."
      >
        <input
          className={inputClass}
          placeholder="20% off + free shipping, ends Sunday"
          value={draft.current_offer}
          onChange={(e) => set('current_offer', e.target.value)}
        />
      </Field>
    </>
  );
}

function StepAudience({ draft, set }: { draft: Draft; set: SetFn }) {
  return (
    <>
      <p className="text-base leading-7 text-zinc-600">
        Two settings, and neither one changes the pages. They decide which country&apos;s ads we
        study, and what mix of ads we later suggest.
      </p>

      <Field label="Which country are you selling into?" help="Picking all three takes longer.">
        <select
          className={inputClass}
          value={draft.region}
          onChange={(e) => set('region', e.target.value as Draft['region'])}
        >
          {REGIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
      </Field>

      <Field
        label="For each buyer, how many ads should be video?"
        help="You get three ad ideas per buyer either way. Videos cost roughly 150 times what
              a picture costs to make, so start with one."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            active={draft.videos === 1}
            onClick={() => set('videos', 1)}
            title="2 pictures + 1 video"
            body="Recommended. Three ideas is a test of which angle works — pictures answer that faster and for almost nothing."
          />
          <ChoiceCard
            active={draft.videos === 2}
            onClick={() => set('videos', 2)}
            title="1 picture + 2 videos"
            body="For when you already know the angle that sells and you want more video in the market."
          />
        </div>
      </Field>

      <Callout tone="info" title="Both of these matter later, not today">
        The parts that use them — studying Meta&apos;s ad library and writing the 60 ad ideas —
        are not built yet. Your answers are saved with the campaign and will be used when
        they are. What runs today stops after the 20 landing pages.
      </Callout>
    </>
  );
}

function StepReview({ draft, onEdit }: { draft: Draft; onEdit: (step: number) => void }) {
  const region = REGIONS.find((r) => r.value === draft.region)?.label ?? draft.region;
  const rows: { label: string; value: string; step: number }[] = [
    { label: 'Campaign name', value: draft.title.trim(), step: 1 },
    {
      label: 'Product',
      value: draft.mode === 'url'
        ? (normaliseUrl(draft.source_url) ?? draft.source_url)
        : `${draft.raw_input_text.trim().slice(0, 120)}${draft.raw_input_text.trim().length > 120 ? '…' : ''}`,
      step: 1,
    },
    {
      label: 'Button sends people to',
      value: normaliseUrl(draft.checkout_url) ?? 'the product page',
      step: 2,
    },
    { label: 'Offer shown on every page', value: draft.current_offer.trim() || 'none', step: 2 },
    { label: 'Country', value: region, step: 3 },
    { label: 'Ads per buyer', value: `${3 - draft.videos} picture${3 - draft.videos === 1 ? '' : 's'} + ${draft.videos} video${draft.videos === 1 ? '' : 's'}`, step: 3 },
  ];

  return (
    <>
      <dl className="divide-y divide-zinc-200 border-y border-zinc-200">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-4 py-3">
            <dt className="w-44 shrink-0 text-sm font-semibold text-zinc-500">{row.label}</dt>
            <dd className="flex-1 break-words text-base text-zinc-900">{row.value}</dd>
            <button
              type="button"
              onClick={() => onEdit(row.step)}
              className="shrink-0 text-sm font-semibold text-zinc-500 underline hover:text-zinc-900"
            >
              Change
            </button>
          </div>
        ))}
      </dl>

      <Callout tone="good" title="This does not cost anything">
        Pressing the button reads your product, invents 20 different kinds of buyer, and puts
        20 landing pages live. No ads are made and nothing is charged — that only happens much
        later, when you approve individual ad ideas one at a time.
      </Callout>
    </>
  );
}

function ModeTab({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-4 py-2 text-sm font-semibold ring-1 ${
        active ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white text-zinc-600 ring-zinc-300'
      }`}
    >
      {children}
    </button>
  );
}

function ChoiceCard({
  active, onClick, title, body,
}: { active: boolean; onClick: () => void; title: string; body: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl p-4 text-left ring-1 transition-colors ${
        active ? 'bg-zinc-900 text-white ring-zinc-900' : 'bg-white text-zinc-900 ring-zinc-300 hover:bg-zinc-50'
      }`}
    >
      <span className="block text-base font-semibold">{title}</span>
      <span className={`mt-1 block text-sm leading-6 ${active ? 'text-zinc-300' : 'text-zinc-500'}`}>
        {body}
      </span>
    </button>
  );
}
