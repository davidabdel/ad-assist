'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/Session';
import { Button, Callout, cn, Field, inputClass, TextButton } from '@/components/ui';
import { ACCEPT_ATTR, type UploadKind } from '@/lib/uploads';
import { uploadFile, type UploadedFile } from '@/lib/upload-client';
import { PRODUCT_TYPES, spec, type InputMode, type ProductType } from '@/lib/product-type';
import {
  clearDraft, loadDraft, MIN_TEXT, normaliseUrl, REGIONS, saveDraft, titleFromFileName,
  titleFromUrl, toCreateBody, validateStep, withProductType,
  type Draft, type StepErrors,
} from '@/lib/wizard-draft';

/**
 * Five questions, then a summary. One question per screen on purpose: the whole
 * point of this screen is that somebody who has never seen the app can get a
 * campaign running without being told what any of it means.
 *
 * WHAT IS BEING SOLD IS ASKED FIRST, and it is not a preference — it changes
 * every screen after it. A physical product is read off a shop; an ebook has no
 * shop, so the book itself is the source; a vehicle is one specific thing that
 * nobody buys online, so it gets five pages instead of twenty and a phone
 * number instead of a checkout. Those rules live in `lib/product-type.ts` and
 * this screen reads them rather than restating them.
 *
 * Nothing here spends money and nothing here is irreversible. The last button
 * creates a campaign row and starts the pipeline, which is free until the ad
 * ideas are approved much later — and the summary says so.
 */

const STEPS = [
  { title: 'What are you selling?', rail: 'Selling' },
  { title: 'Tell us about it', rail: 'About it' },
  { title: 'How do people buy it?', rail: 'Buying' },
  { title: 'Who are we advertising to?', rail: 'Audience' },
  { title: 'Check it over', rail: 'Check' },
];

const GLYPH: Record<ProductType, string> = { ecom: '▢', ebook: '▤', vehicle: '◉' };

/** Big inputs for the one answer a step is really asking for. */
const bigInput = cn(inputClass, 'px-[18px] py-4 text-lg');

export function Wizard({
  onCancel, onStep,
}: {
  onCancel?: () => void;
  /** Told the step on screen (1–5), so the page can move its progress bar. */
  onStep?: (step: number) => void;
}) {
  const router = useRouter();
  const { api } = useSession();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [errors, setErrors] = useState<StepErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { saveDraft(draft); }, [draft]);
  useEffect(() => { onStep?.(step); }, [step, onStep]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function go(to: number) {
    setErrors({});
    setStep(to);
    window.scrollTo({ top: 0 });
  }

  function next() {
    const found = validateStep(step, draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    go(Math.min(step + 1, STEPS.length));
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

  const last = step === STEPS.length;

  return (
    <div>
      <ol className="m-0 flex list-none gap-2.5 p-0" aria-label="Progress">
        {STEPS.map((s, i) => {
          const done = i + 1 < step;
          const here = i + 1 === step;
          return (
            <li key={s.rail} className="flex flex-1 flex-col gap-[7px]" aria-current={here ? 'step' : undefined}>
              <span
                className={cn(
                  'flex justify-between text-[11px] font-bold tracking-[0.14em] transition-colors duration-400',
                  here ? 'text-zinc-900' : done ? 'text-accent' : 'text-zinc-400',
                )}
              >
                <span>{`0${i + 1}`}</span>
                <span className="hidden font-semibold uppercase tracking-[0.04em] sm:inline">{s.rail}</span>
              </span>
              <span
                className={cn(
                  'h-1 rounded-sm transition-colors duration-400',
                  here ? 'bg-zinc-900' : done ? 'bg-gradient-to-r from-accent to-teal' : 'bg-zinc-200',
                )}
              />
            </li>
          );
        })}
      </ol>

      <form
        key={step}
        noValidate
        onSubmit={(e) => { e.preventDefault(); if (!last) next(); }}
        className="animate-rise mx-auto mt-12 flex max-w-[720px] flex-col gap-[22px] sm:mt-16"
      >
        <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-accent">
          Step {step} of {STEPS.length}
        </p>
        <h1 className="m-0 text-[34px] leading-[1.05] sm:text-[44px]">{STEPS[step - 1].title}</h1>

        {step === 1 && <StepKind draft={draft} setDraft={setDraft} />}
        {step === 2 && <StepSource draft={draft} set={set} errors={errors} />}
        {step === 3 && <StepBuying draft={draft} set={set} errors={errors} />}
        {step === 4 && <StepAudience draft={draft} set={set} />}
        {step === 5 && <StepReview draft={draft} onEdit={go} />}

        {submitError ? <Callout tone="error" title="It did not start">{submitError}</Callout> : null}

        <div className="mt-1 flex items-center justify-between gap-3">
          {step > 1 ? (
            <TextButton onClick={() => go(step - 1)} disabled={busy}>Back</TextButton>
          ) : onCancel ? (
            <TextButton onClick={onCancel}>Cancel</TextButton>
          ) : <span />}

          {last ? (
            <Button type="button" variant="gradient" onClick={start} disabled={busy} className="px-[30px] py-[17px] text-base">
              {busy ? 'Starting…' : <>Build my campaign <span aria-hidden>→</span></>}
            </Button>
          ) : (
            <Button type="submit">Next <span aria-hidden>→</span></Button>
          )}
        </div>
      </form>
    </div>
  );
}

type SetFn = <K extends keyof Draft>(key: K, value: Draft[K]) => void;

function Intro({ children }: { children: React.ReactNode }) {
  return <p className="m-0 max-w-[620px] text-base leading-[1.6] text-zinc-500">{children}</p>;
}

/** Step 1. Three choices, and each one says what it will change. */
function StepKind({
  draft, setDraft,
}: { draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>> }) {
  return (
    <>
      <Intro>
        This is the only answer that changes the rest of the app: where we read the facts from,
        how many pages get built, and how the page asks for the sale.
      </Intro>

      <div className="mt-2 grid gap-3" role="radiogroup">
        {PRODUCT_TYPES.map((t) => {
          const on = draft.product_type === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setDraft((d) => withProductType(d, t.value))}
              className={cn(
                'flex items-center gap-[18px] rounded-[14px] border-2 px-[22px] py-[18px] text-left transition-all duration-250',
                on ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 bg-white text-zinc-900 hover:border-accent',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-11 shrink-0 items-center justify-center rounded-xl text-xl font-extrabold transition-all duration-250',
                  on ? 'bg-white/[.12] text-teal' : 'bg-accent-tint text-accent',
                )}
              >
                {GLYPH[t.value]}
              </span>
              <span className="flex flex-col gap-[3px]">
                <span className="text-[17px] font-bold tracking-[-0.01em]">{t.label}</span>
                <span className={cn('text-sm leading-normal', on ? 'text-[#B7C0CC]' : 'text-zinc-500')}>
                  {`${t.blurb} ${t.personaTarget} landing ${t.personaTarget === 1 ? 'page' : 'pages'}, `
                    + `ending in ${t.ctaKind === 'contact' ? 'a phone number and an enquiry form' : 'your checkout link'}.`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Step 2. The facts about the thing, plus any photographs of it. */
function StepSource({
  draft, set, errors,
}: { draft: Draft; set: SetFn; errors: StepErrors }) {
  const kind = spec(draft.product_type);
  const vehicle = draft.product_type === 'vehicle';
  const ebook = draft.product_type === 'ebook';

  return (
    <>
      <Intro>
        {vehicle
          ? 'Point us at the one you are selling. Every page we build describes this exact '
            + 'vehicle and nothing else, so whatever you give us here is what a buyer reads.'
          : ebook
            ? 'Give us the book. We read it ourselves and build the pages from what it '
              + 'actually teaches, not from what its cover says.'
            : 'Point us at one product. Everything after this — the buyers, the pages, the '
              + 'ads — is built from this one thing, so pick the product you actually want '
              + 'to sell more of.'}
      </Intro>

      {kind.modes.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {kind.modes.map((m) => (
            <Chip key={m} active={draft.mode === m} onClick={() => set('mode', m)} small>
              {MODE_LABEL[draft.product_type][m]}
            </Chip>
          ))}
        </div>
      ) : null}

      {draft.mode === 'url' ? (
        <Field
          label={vehicle ? 'Listing address' : 'Product page address'}
          help={vehicle
            ? 'The Carsales, Boatsales, Marketplace or Gumtree listing — whatever page a '
              + 'buyer would land on today.'
            : 'Copy the address from your browser when you are looking at it, and paste it here.'}
          error={errors.source_url}
        >
          <input
            className={bigInput}
            aria-invalid={!!errors.source_url}
            autoFocus
            placeholder={vehicle
              ? 'https://www.carsales.com.au/cars/details/…'
              : 'https://yourshop.com/products/your-product'}
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
      ) : draft.mode === 'pdf' ? (
        <FileField
          label="The ebook"
          help="The PDF you sell. We read its text on our own server — it is never published,
                and it does not go on any of the pages."
          prompt="Drop the PDF here, or click to choose"
          kind="pdf"
          error={errors.source_file}
          value={draft.source_file ? [draft.source_file] : []}
          onChange={(files) => {
            const file = files[0] ?? null;
            set('source_file', file);
            if (file && !draft.title.trim()) {
              const guess = titleFromFileName(file.name);
              if (guess) set('title', guess);
            }
          }}
        />
      ) : (
        <Field
          label={vehicle ? 'Describe the vehicle' : 'Describe the product'}
          help={vehicle
            ? `Year, make, model, variant, kilometres or engine hours, transmission, colour,
               registration and when it expires, service history, price, and anything a buyer
               would ask on the phone. Minimum ${MIN_TEXT} characters — but the more you put
               here, the less the pages have to leave out.`
            : `What it is, who it is for, what it costs, and what makes it better than the
               obvious alternative. A short paragraph is enough. Minimum ${MIN_TEXT} characters.`}
          error={errors.raw_input_text}
        >
          <textarea
            className={cn(inputClass, 'min-h-[130px] resize-y px-[18px] py-4 text-base leading-normal')}
            aria-invalid={!!errors.raw_input_text}
            placeholder={vehicle
              ? '2019 Ford Ranger Wildtrak, 96,400 km, auto, dual cab, full service history…'
              : 'A merino wool running shoe made in Australia, $160, for commuters who…'}
            value={draft.raw_input_text}
            onChange={(e) => set('raw_input_text', e.target.value)}
          />
        </Field>
      )}

      <div className="grid gap-[18px] sm:grid-cols-2">
        <FileField
          label={vehicle ? 'Photos of it' : 'Your own photos (optional)'}
          help={vehicle
            ? 'Your own photos of this vehicle. These become the pictures on every page, so put '
              + 'up as many good ones as you have — outside, inside, dash, engine bay, tow bar, '
              + 'anything a buyer would zoom in on.'
            : ebook
              ? 'A PDF has no photographs we can use, so anything visual on these pages comes '
                + 'from here — the cover, a mockup, a screenshot of what is inside.'
              : 'Only if you have shots that are not on the product page. We already read every '
                + 'photo that is.'}
          prompt="Drop photos here, or click to choose"
          kind="image"
          multiple
          error={errors.images}
          value={draft.images}
          onChange={(files) => set('images', files)}
        />

        <Field
          label="Campaign name"
          help="Just for you, so you can find this again. Nobody else sees it."
          error={errors.title}
        >
          <input
            className={inputClass}
            aria-invalid={!!errors.title}
            placeholder={vehicle ? '2019 Ranger Wildtrak' : 'Tree Runner — spring'}
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>
      </div>
    </>
  );
}

const MODE_LABEL: Record<ProductType, Record<InputMode, string>> = {
  ecom: { url: 'I have a link', text: 'I will type it out', pdf: 'Upload a PDF' },
  ebook: { pdf: 'Upload the PDF', url: 'Use its sales page', text: 'I will type it out' },
  vehicle: { url: 'I have the listing link', text: 'I will type it out', pdf: 'Upload a PDF' },
};

/** Step 3. Where the button on every page sends people. */
function StepBuying({
  draft, set, errors,
}: { draft: Draft; set: SetFn; errors: StepErrors }) {
  const contact = spec(draft.product_type).ctaKind === 'contact';

  return (
    <>
      <Intro>
        {contact
          ? 'Nobody buys a vehicle from a landing page, so these pages do not pretend '
            + 'otherwise. Every one ends in a button that rings you, and a short form '
            + 'underneath it for the buyer who is reading this at ten at night.'
          : 'Every page we build ends in a button. This is where that button sends people.'}
      </Intro>

      {contact ? (
        <>
          <Field
            label="Phone number buyers should ring"
            help="It becomes a tap-to-call button on every page and is printed in the button
                  itself, so somebody on a desktop can still read it."
            error={errors.contact_phone}
          >
            <input
              className={bigInput}
              aria-invalid={!!errors.contact_phone}
              type="tel"
              autoFocus
              placeholder="0412 345 678"
              value={draft.contact_phone}
              onChange={(e) => set('contact_phone', e.target.value)}
            />
          </Field>

          <Field
            label="Who should they ask for? (optional)"
            help="Enquiries land on the campaign's own screen, each one saying which of the five
                  pages the buyer was reading."
          >
            <input
              className={inputClass}
              placeholder="Dave"
              value={draft.contact_name}
              onChange={(e) => set('contact_name', e.target.value)}
            />
          </Field>
        </>
      ) : (
        <Field
          label="Checkout or buy link"
          help="Usually your cart, or the product page itself. Leave it empty and the button
                points back at the page you gave us — it still works, it is just not
                as direct."
          error={errors.checkout_url}
        >
          <input
            className={bigInput}
            aria-invalid={!!errors.checkout_url}
            autoFocus
            placeholder="https://yourshop.com/cart"
            value={draft.checkout_url}
            onChange={(e) => set('checkout_url', e.target.value)}
          />
        </Field>
      )}

      <Field
        label="What is the current offer?"
        help="Written exactly as a customer should read it. It goes in the bar across the top
              of every page. Leave it empty if there is no offer on right now."
      >
        <input
          className={bigInput}
          placeholder={contact ? 'Priced to sell, inspections this weekend' : '20% off + free shipping, ends Sunday'}
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
      <Intro>
        Two settings, and neither one changes the pages. They decide which country&apos;s ads we
        study, and what mix of ads we later suggest.
      </Intro>

      <div className="flex flex-col gap-2.5">
        <span className="text-sm font-bold">Which country are you selling into?</span>
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {REGIONS.map((r) => (
            <Chip key={r.value} active={draft.region === r.value} onClick={() => set('region', r.value)}>
              {r.label}
            </Chip>
          ))}
        </div>
        <span className="text-[13px] text-zinc-400">Picking all three takes longer.</span>
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-sm font-bold">For each buyer, how many ads should be video?</span>
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
          {([
            [1, '2 pictures + 1 video', 'Recommended. Three ideas is a test of which angle works; pictures answer that faster and for almost nothing.'],
            [2, '1 picture + 2 videos', 'For when you already know the angle that sells and you want more video in the market.'],
          ] as const).map(([videos, title, body]) => {
            const on = draft.videos === videos;
            return (
              <button
                key={videos}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set('videos', videos)}
                className={cn(
                  'flex flex-col gap-1.5 rounded-[14px] border-2 px-5 py-[18px] text-left transition-all duration-250',
                  on ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 bg-white text-zinc-900 hover:border-accent',
                )}
              >
                <span className="text-base font-bold">{title}</span>
                <span className={cn('text-[13px] leading-normal', on ? 'text-[#B7C0CC]' : 'text-zinc-500')}>{body}</span>
              </button>
            );
          })}
        </div>
        <span className="text-[13px] text-zinc-400">
          You get three ad ideas per buyer either way. Videos cost roughly 150 times what a
          picture costs to make, so start with one.
        </span>
      </div>
    </>
  );
}

function StepReview({ draft, onEdit }: { draft: Draft; onEdit: (step: number) => void }) {
  const kind = spec(draft.product_type);
  const region = REGIONS.find((r) => r.value === draft.region)?.label ?? draft.region;

  const sourceValue = draft.mode === 'url'
    ? (normaliseUrl(draft.source_url) ?? draft.source_url)
    : draft.mode === 'pdf'
      ? (draft.source_file?.name ?? 'no file yet')
      : `${draft.raw_input_text.trim().slice(0, 120)}${draft.raw_input_text.trim().length > 120 ? '…' : ''}`;

  const rows: { label: string; value: string; step: number }[] = [
    { label: 'Selling', value: kind.label, step: 1 },
    { label: 'Campaign name', value: draft.title.trim(), step: 2 },
    { label: draft.mode === 'pdf' ? 'The book' : 'Source', value: sourceValue, step: 2 },
    {
      label: 'Your photos',
      value: draft.images.length ? `${draft.images.length} uploaded` : 'none',
      step: 2,
    },
    kind.ctaKind === 'contact'
      ? { label: 'Buyers ring', value: draft.contact_phone.trim() || 'not set', step: 3 }
      : {
        label: 'Button sends people to',
        value: normaliseUrl(draft.checkout_url) ?? 'the product page',
        step: 3,
      },
    { label: 'Offer shown on every page', value: draft.current_offer.trim() || 'none', step: 3 },
    { label: 'Country', value: region, step: 4 },
    {
      label: 'Ads per buyer',
      value: `${3 - draft.videos} picture${3 - draft.videos === 1 ? '' : 's'} + ${draft.videos} video${draft.videos === 1 ? '' : 's'}`,
      step: 4,
    },
  ];

  return (
    <>
      <dl className="m-0 border-t border-zinc-300">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-zinc-300 py-[13px]">
            <dt className="w-full shrink-0 text-[13px] font-bold text-zinc-500 sm:w-[190px]">{row.label}</dt>
            <dd className="m-0 min-w-0 flex-1 break-words text-[15px] text-zinc-900">{row.value}</dd>
            <button
              type="button"
              onClick={() => onEdit(row.step)}
              className="shrink-0 text-[13px] font-bold text-accent underline underline-offset-[3px] hover:text-zinc-900"
            >
              Change
            </button>
          </div>
        ))}
      </dl>

      <Callout tone="good">
        <strong>This does not cost anything.</strong> Pressing the button reads what you gave us,
        invents {kind.personaTarget} different kinds of buyer, and puts {kind.personaTarget} landing
        pages live. No ads are made and nothing is charged. That only happens much later, when you
        approve individual ad ideas one at a time.
      </Callout>
    </>
  );
}

/**
 * Upload happens on choosing the file, not on submit.
 *
 * A 40 MB book uploading while the operator reads the summary screen is time
 * they were spending anyway; the same upload starting when they press the last
 * button is a minute of staring at "Starting…" wondering whether it hung. The
 * file goes straight to storage — see `lib/upload-client.ts` for why it does
 * not pass through our own server.
 */
function FileField({
  label, help, prompt, kind, multiple = false, error, value, onChange,
}: {
  label: string;
  help: string;
  prompt: string;
  kind: UploadKind;
  multiple?: boolean;
  error?: string;
  value: UploadedFile[];
  onChange: (files: UploadedFile[]) => void;
}) {
  const { api } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  async function choose(list: FileList | null) {
    if (!list?.length) return;
    const accepted = ACCEPT_ATTR[kind].split(',');
    const files = Array.from(list).filter((f) => accepted.includes(f.type)).slice(0, multiple ? undefined : 1);
    if (!files.length) {
      setFailed(kind === 'pdf' ? 'That is not a PDF.' : 'Only PNG, JPEG or WebP photos.');
      return;
    }
    setFailed(null);
    setBusy((n) => n + files.length);

    // Sequential rather than parallel: eight phone photos at once saturates a
    // home connection and the whole batch appears to stall. One at a time, each
    // lands as it finishes and the count goes down where he can see it.
    const done: UploadedFile[] = [];
    for (const file of files) {
      try {
        done.push(await uploadFile(api, kind, file));
      } catch (e) {
        setFailed((e as Error).message);
      } finally {
        setBusy((n) => n - 1);
      }
    }
    if (done.length) onChange(multiple ? [...value, ...done] : done.slice(0, 1));
    if (input.current) input.current.value = '';
  }

  const message = error ?? failed;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-bold">{label}</span>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files); }}
        className={cn(
          'flex items-center gap-3 rounded-xl border-2 border-dashed p-[18px] text-left text-[13px] leading-normal text-zinc-500 transition-colors',
          over ? 'border-accent bg-accent-tint' : message ? 'border-[#F97316]' : 'border-zinc-300 hover:border-accent',
        )}
      >
        <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-accent-tint text-lg font-extrabold text-accent">
          +
        </span>
        {busy > 0 ? `Uploading ${busy} file${busy === 1 ? '' : 's'}…` : prompt}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT_ATTR[kind]}
        multiple={multiple}
        onChange={(e) => choose(e.target.files)}
        className="hidden"
      />

      {value.length ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {value.map((f) => (
            <li key={f.url} className="flex items-center gap-3 text-[13px] text-zinc-700">
              <span className="flex-1 truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v.url !== f.url))}
                className="shrink-0 font-bold text-zinc-500 hover:text-zinc-900"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <span className={cn('text-[13px] leading-normal', message ? 'font-medium text-[#C2410C]' : 'text-zinc-400')}>
        {message ?? help}
      </span>
    </div>
  );
}

function Chip({
  active, onClick, small = false, children,
}: { active: boolean; onClick: () => void; small?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'rounded-full border-2 font-bold transition-all duration-200',
        small ? 'px-4 py-[9px] text-[13px]' : 'px-[18px] py-2.5 text-sm',
        active
          ? 'border-zinc-900 bg-zinc-900 text-white'
          : 'border-zinc-300 bg-white text-zinc-900 hover:border-zinc-900',
      )}
    >
      {children}
    </button>
  );
}
