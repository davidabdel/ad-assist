'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/Session';
import { Button, Callout, Card, Field, inputClass } from '@/components/ui';
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
  'What are you selling?',
  'Tell us about it',
  'How do people buy it?',
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
          {step === 1 && <StepKind draft={draft} setDraft={setDraft} />}
          {step === 2 && <StepSource draft={draft} set={set} errors={errors} />}
          {step === 3 && <StepBuying draft={draft} set={set} errors={errors} />}
          {step === 4 && <StepAudience draft={draft} set={set} />}
          {step === 5 && <StepReview draft={draft} onEdit={setStep} />}
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

/** Step 1. Three choices, and each one says what it will change. */
function StepKind({
  draft, setDraft,
}: { draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>> }) {
  return (
    <>
      <p className="text-base leading-7 text-zinc-600">
        This is the only answer that changes the rest of the app — where we read the facts
        from, how many pages get built, and how the page asks for the sale.
      </p>

      <div className="grid gap-3">
        {PRODUCT_TYPES.map((t) => (
          <ChoiceCard
            key={t.value}
            active={draft.product_type === t.value}
            onClick={() => setDraft((d) => withProductType(d, t.value))}
            title={t.label}
            body={`${t.blurb} ${t.personaTarget} landing ${t.personaTarget === 1 ? 'page' : 'pages'}, `
              + `ending in ${t.ctaKind === 'contact' ? 'a phone number and an enquiry form' : 'your checkout link'}.`}
          />
        ))}
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
      <p className="text-base leading-7 text-zinc-600">
        {vehicle
          ? 'Point us at the one you are selling. Every page we build describes this exact '
            + 'vehicle and nothing else, so whatever you give us here is what a buyer reads.'
          : ebook
            ? 'Give us the book. We read it ourselves and build the pages from what it '
              + 'actually teaches, not from what its cover says.'
            : 'Point us at one product. Everything after this — the buyers, the pages, the '
              + 'ads — is built from this one thing, so pick the product you actually want '
              + 'to sell more of.'}
      </p>

      {kind.modes.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {kind.modes.map((m) => (
            <ModeTab key={m} active={draft.mode === m} onClick={() => set('mode', m)}>
              {MODE_LABEL[draft.product_type][m]}
            </ModeTab>
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
            className={inputClass}
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
            className={`${inputClass} min-h-40`}
            placeholder={vehicle
              ? '2019 Ford Ranger Wildtrak, 96,400 km, auto, dual cab, full service history…'
              : 'A merino wool running shoe made in Australia, $160, for commuters who…'}
            value={draft.raw_input_text}
            onChange={(e) => set('raw_input_text', e.target.value)}
          />
        </Field>
      )}

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
        kind="image"
        multiple
        error={errors.images}
        value={draft.images}
        onChange={(files) => set('images', files)}
      />

      <Field
        label="Campaign name"
        help="Just for you, so you can find this again in the list. Nobody else sees it."
        error={errors.title}
      >
        <input
          className={inputClass}
          placeholder={vehicle ? '2019 Ranger Wildtrak' : 'Tree Runner — spring'}
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
        />
      </Field>

      {draft.mode === 'url' ? (
        <Callout tone="info" title="What happens when you press Start">
          We read the page ourselves, in about a second — you do not need to leave anything
          running. Some sites refuse to be read that way; Amazon is one, and the big car
          listing sites often are too. If yours is one of them the next screen says so and
          hands that page to Chrome on your Mac instead.
        </Callout>
      ) : null}
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
      <p className="text-base leading-7 text-zinc-600">
        {contact
          ? 'Nobody buys a vehicle from a landing page, so these pages do not pretend '
            + 'otherwise. Every one ends in a button that rings you, and a short form '
            + 'underneath it for the buyer who is reading this at ten at night.'
          : 'Every page we build ends in a button. This is where that button sends people.'}
      </p>

      {contact ? (
        <>
          <Field
            label="Phone number buyers should ring"
            help="It becomes a tap-to-call button on every page and is printed in the button
                  itself, so somebody on a desktop can still read it."
            error={errors.contact_phone}
          >
            <input
              className={inputClass}
              type="tel"
              placeholder="0412 345 678"
              value={draft.contact_phone}
              onChange={(e) => set('contact_phone', e.target.value)}
            />
          </Field>

          <Field
            label="Who should they ask for? (optional)"
            help="Only used so you know which of your campaigns an enquiry came from."
          >
            <input
              className={inputClass}
              placeholder="Dave"
              value={draft.contact_name}
              onChange={(e) => set('contact_name', e.target.value)}
            />
          </Field>

          <Callout tone="info" title="Where the form goes">
            Enquiries land in this app, on the campaign&rsquo;s own screen, and each one records
            which of the five pages the buyer was reading when they filled it in. That is the
            whole reason for building five different pages instead of one.
          </Callout>
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
            className={inputClass}
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
          className={inputClass}
          placeholder={contact ? 'Priced to sell, inspections this weekend' : '20% off + free shipping, ends Sunday'}
          value={draft.current_offer}
          onChange={(e) => set('current_offer', e.target.value)}
        />
      </Field>
    </>
  );
}

function StepAudience({ draft, set }: { draft: Draft; set: SetFn }) {
  const target = spec(draft.product_type).personaTarget;

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
        The parts that use them — studying Meta&apos;s ad library and writing the ad ideas —
        are not built yet. Your answers are saved with the campaign and will be used when
        they are. What runs today stops after the {target} landing pages.
      </Callout>
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
        Pressing the button reads what you gave us, invents {kind.personaTarget} different kinds
        of buyer, and puts {kind.personaTarget} landing pages live. No ads are made and nothing
        is charged — that only happens much later, when you approve individual ad ideas one at
        a time.
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
  label, help, kind, multiple = false, error, value, onChange,
}: {
  label: string;
  help: string;
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

  async function choose(list: FileList | null) {
    if (!list?.length) return;
    const files = Array.from(list);
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

  return (
    <Field label={label} help={help} error={error ?? failed}>
      <input
        ref={input}
        type="file"
        accept={ACCEPT_ATTR[kind]}
        multiple={multiple}
        onChange={(e) => choose(e.target.files)}
        className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0
                   file:bg-zinc-900 file:px-4 file:py-2.5 file:text-sm file:font-semibold
                   file:text-white hover:file:bg-zinc-700"
      />

      {busy > 0 ? (
        <p className="mt-2 text-sm font-medium text-zinc-600">
          Uploading {busy} file{busy === 1 ? '' : 's'}…
        </p>
      ) : null}

      {value.length ? (
        <ul className="mt-3 space-y-1.5">
          {value.map((f) => (
            <li key={f.url} className="flex items-center gap-3 text-sm text-zinc-700">
              <span className="flex-1 truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((v) => v.url !== f.url))}
                className="shrink-0 font-semibold text-zinc-500 underline hover:text-zinc-900"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Field>
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
