import Image from 'next/image';
import Link from 'next/link';
import { HeroForm } from '@/components/HeroForm';
import { Logo } from '@/components/ui';

/**
 * adtocart.cc — the page that sells the app. Every call to action goes to the
 * wizard, which goes through login first when nobody is signed in.
 *
 * The six hero ads are real: Buzz Cleaning copy and photos from a live
 * campaign, kept as the launch demo. The six buyers under "The problem" are
 * sample copy for a merino running shoe and say nothing about any customer.
 *
 * Pricing is not on this page on purpose — plans and credits are explained
 * inside the app, after sign-up.
 */

const START = '/campaigns?new=1';

const HERO_ADS = [
  { img: '/brand/buzz-grapes.png', pos: '50% 60%', text: 'Gentle enough to clean fruit and veg without rinsing. Made from water, salt and vinegar.', headline: 'Spray it on the grapes', cta: 'Shop Now' },
  { img: '/brand/buzz-unbox.png', pos: '50% 40%', text: 'Snack areas, toys, hands and paws. Rethink what belongs on the family counter.', headline: 'Rethink the family spray', cta: 'Learn More' },
  { img: '/brand/buzz-kid-dog-book.jpg', pos: '60% 50%', text: 'Safe for children, pets and adults when used as directed. 99.9% of germs, gone.', headline: 'Safe around the small ones', cta: 'Learn More' },
  { img: '/brand/buzz-tap.jpg', pos: '50% 50%', text: 'Fill with tap water, squeeze in one capsule, plug it in. Ready in 7 minutes.', headline: 'Just add water', cta: 'Get Offer' },
  { img: '/brand/buzz-wipe.jpg', pos: '50% 50%', text: 'Counters, handles and the spots everyone touches on the way in. HOCL, made at home.', headline: 'Sanitise high-touch spots', cta: 'Get Offer' },
  { img: '/brand/buzz-kid-dog.jpg', pos: '50% 50%', text: 'One reusable BPA-free bottle. No more disposable sprays under the sink.', headline: 'Refill. Reuse. Buzz.', cta: 'Shop Now' },
];

const PILLARS = [
  { glyph: '◍', label: 'Unique customers' },
  { glyph: '▤', label: 'Smarter ads' },
  { glyph: '▢', label: 'More sales' },
  { glyph: '✦', label: 'A more personal shopping world' },
];

const TAG_TONES = [
  'bg-accent-tint text-accent',
  'bg-amber-tint text-amber-ink',
  'bg-[#E6F7F4] text-teal-deep',
];

const BUYERS = [
  ['The commuter', 'Buying on time. Forty minutes each way and sweaty feet by 9am.', 'Time'],
  ['The nervous first-timer', 'Buying on risk. Has never spent $160 on a shoe.', 'Risk'],
  ['The gift buyer', "Buying on certainty. Doesn't know their size.", 'Certainty'],
  ['The burnt-before', 'Buying on proof. Last "sustainable" pair lasted a month.', 'Proof'],
  ['The upgrader', 'Buying on novelty. Third pair of the same brand.', 'Novelty'],
  ['The wool sceptic', 'Buying on disbelief. Cannot picture wool in summer.', 'Doubt'],
];

const STEPS = [
  ['01', 'It reads your product page', 'Features, price and the actual customer reviews, straight off the page, in about a second.'],
  ['02', 'It writes the main page — you approve it', 'The one checkpoint. Seven of its ten reasons are copied onto every buyer page, so a mistake here is a mistake twenty times.'],
  ['03', 'Twenty buyers who do not overlap', "Each gets a real landing page on its own URL, in your brand's colours, arguing the case that buyer cares about."],
  ['04', "It reads Meta's ad library", 'Only ads live between three months and a year. It keeps the shape, never the words.'],
  ['05', 'Sixty ads, approved one row at a time', 'Primary text, headline, button, picture and where it points. Paste it into Ads Manager and go.'],
];

const STATS = [
  ['90–365', 'Days an ad must have been live to qualify'],
  ['300', 'Ads read per search, ceiling stated not hidden'],
  ['0', 'Words of theirs that travel into your ads'],
];

const LIMITS = [
  ['It does not publish to Meta', 'The output is copy, pictures and URLs you paste into Ads Manager.'],
  ['"Winning ad" is a proxy, not a measurement', 'Meta gives out no performance data for commercial ads. Still active after 90 days is the best evidence that exists.'],
  ['It never invents a photograph of your product', 'A picture slot with no honest source stays empty rather than borrowing an unrelated photo.'],
  ['Testimonials only come from real reviews', 'No reviews found means no testimonial section, and it warns you before you approve.'],
  ["It refuses to write twenty buyers that aren't really different", 'Some products do not have twenty. It stops and says so.'],
];

const eyebrow = 'text-xs font-bold uppercase tracking-[0.14em] text-accent';
const h2 = 'm-0 text-[clamp(30px,3.4vw,44px)] leading-[1.08]';

export function Landing() {
  return (
    <div className="site flex flex-1 flex-col bg-white text-zinc-900">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-3.5 sm:px-7">
          <Link href="/" aria-label="adtocart.cc home"><Logo size={36} /></Link>
          <nav className="order-3 flex flex-[1_0_100%] flex-wrap justify-center gap-x-6 gap-y-2.5 text-sm font-semibold text-zinc-500 lg:order-none lg:flex-none">
            <a href="#how" className="whitespace-nowrap hover:text-zinc-900">How it works</a>
            <a href="#proof" className="whitespace-nowrap hover:text-zinc-900">Why these ads</a>
            <a href="#limits" className="whitespace-nowrap hover:text-zinc-900">What it won&rsquo;t do</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login" className="whitespace-nowrap px-1.5 py-2.5 text-sm font-bold text-zinc-900 hover:text-accent">
              Log in
            </Link>
            <Link
              href={START}
              className="whitespace-nowrap rounded-full bg-zinc-900 px-5 py-[11px] text-sm font-bold text-white transition-colors hover:bg-accent"
            >
              Start a campaign
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-navy text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'radial-gradient(900px 420px at 78% 8%,rgba(8,199,178,.22),transparent 65%),'
              + 'radial-gradient(800px 460px at 12% 90%,rgba(8,125,232,.28),transparent 60%)',
          }}
        />
        <div className="relative mx-auto grid max-w-[1180px] items-center gap-14 px-5 pt-16 sm:px-7 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,.95fr)] lg:pt-[92px]">
          <div className="flex min-w-0 flex-col gap-[26px]">
            <div className="self-start rounded-full border border-white/20 px-3.5 py-[7px] text-xs font-bold uppercase tracking-[0.1em] text-teal">
              Personalise · Convert · Grow
            </div>
            <h1 className="m-0 text-[clamp(40px,5.2vw,68px)] leading-[1.02] tracking-[-0.04em]">
              Your customers are unique.<br />
              <span className="text-brand-gradient">Why aren&rsquo;t your ads?</span>
            </h1>
            <p className="m-0 max-w-[600px] text-[clamp(17px,1.5vw,21px)] leading-[1.55] text-[#C3CDD9]">
              AdToCart turns one product page into twenty buyers, twenty landing pages and sixty
              ads — each one written for a different reason somebody would buy.
            </p>
            <HeroForm />
            <div className="flex flex-wrap gap-x-[22px] gap-y-1 text-[13px] text-[#93A1B1]">
              <span>Free to start</span><span aria-hidden>·</span>
              <span>No card up front</span><span aria-hidden>·</span>
              <span>No Meta account connected</span>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3 pb-[68px]">
            <div className="flex justify-between text-[11px] font-bold uppercase tracking-[0.12em] text-[#6E8099]">
              <span>One product</span><span>Sixty ads</span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
              {HERO_ADS.map((ad) => (
                <div
                  key={ad.headline}
                  className="overflow-hidden rounded-xl bg-white text-zinc-900 shadow-[0_18px_40px_-24px_rgba(0,0,0,.7)]"
                >
                  <div className="flex items-center gap-[7px] px-2.5 pb-1.5 pt-[9px]">
                    <span className="flex size-5 items-center justify-center rounded-full bg-[#0FA3B1] text-[9px] font-extrabold text-white">b</span>
                    <span className="whitespace-nowrap text-[10px] font-bold">Buzz Cleaning</span>
                  </div>
                  <p className="m-0 min-h-[42px] px-2.5 pb-2 text-[10px] leading-[1.4] text-zinc-600">{ad.text}</p>
                  <div className="relative aspect-square bg-[#EEF2F6]">
                    <Image
                      src={ad.img}
                      alt=""
                      fill
                      sizes="(min-width: 1024px) 180px, 45vw"
                      className="object-cover"
                      style={{ objectPosition: ad.pos }}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 bg-[#F0F2F5] px-2.5 py-[7px]">
                    <span className="min-w-0 text-[10px] font-extrabold leading-[1.2]">{ad.headline}</span>
                    <span className="whitespace-nowrap rounded bg-[#E4E6EB] px-1.5 py-1 text-[9px] font-bold">{ad.cta}</span>
                  </div>
                </div>
              ))}
            </div>
            <p className="m-0 text-xs text-[#6E8099]">
              Six of sixty for Buzz Cleaning. Each one written for a different buyer and pointed at
              that buyer&rsquo;s own page.
            </p>
          </div>
        </div>
      </section>

      {/* Pillars */}
      <section className="border-b border-zinc-200 bg-zinc-50">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-6 px-5 py-[26px] sm:px-7">
          {PILLARS.map((p) => (
            <div key={p.label} className="flex items-center gap-3">
              <span aria-hidden className="text-[22px]">{p.glyph}</span>
              <span className="text-xs font-semibold uppercase leading-normal tracking-[0.16em]">{p.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* The problem */}
      <section className="mx-auto grid w-full max-w-[1180px] items-center gap-16 px-5 py-24 sm:px-7 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-[22px]">
          <div className={eyebrow}>The problem</div>
          <h2 className={h2}>Every ecommerce store runs the same ad at everybody.</h2>
          <p className="m-0 text-lg leading-[1.65] text-zinc-600">
            But nobody adds to cart for the same reason — one person is buying on price, one on
            time, one because they&rsquo;ve been burnt before.
          </p>
          <p className="m-0 text-[17px] leading-[1.65] text-zinc-500">
            You already know the bottleneck isn&rsquo;t the media buying, it&rsquo;s the creative. You need
            twenty angles and you&rsquo;ve got one product and one set of photos, so you end up running
            four variations of the same idea and calling it testing.
          </p>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-3.5 sm:grid-cols-2">
          {BUYERS.map(([name, pain, tag], i) => (
            <div key={name} className="flex flex-col gap-[7px] rounded-[14px] border border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold tracking-[0.1em] text-accent">{String(i + 1).padStart(2, '0')}</span>
                <span className={`rounded-full px-2 py-[3px] text-[10px] font-bold ${TAG_TONES[i % 3]}`}>{tag}</span>
              </div>
              <div className="text-[15px] font-bold leading-[1.25]">{name}</div>
              <div className="text-[13px] leading-normal text-zinc-500">{pain}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-20 bg-navy text-white">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-[52px] px-5 py-24 sm:px-7">
          <div className="flex flex-wrap items-end justify-between gap-8">
            <h2 className="m-0 max-w-[640px] text-[clamp(30px,3.4vw,46px)] leading-[1.06]">
              AdToCart starts at the buyer instead of the creative.
            </h2>
            <p className="m-0 max-w-[380px] text-base leading-[1.6] text-[#93A1B1]">
              Five things happen after you paste a link. One of them needs you; the rest run whether
              your laptop is open or not.
            </p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] border-t border-white/15">
            {STEPS.map(([n, title, body]) => (
              <div key={n} className="flex flex-col gap-3 border-r border-white/10 pb-[30px] pr-[26px] pt-[26px]">
                <div className="text-xs font-extrabold tracking-[0.14em] text-teal">{n}</div>
                <div className="text-[19px] font-bold leading-[1.25] tracking-[-0.02em]">{title}</div>
                <div className="text-sm leading-[1.6] text-[#A9B6C4]">{body}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href={START}
              className="rounded-full bg-white px-[26px] py-[15px] text-[15px] font-extrabold text-zinc-900 transition-colors hover:bg-teal"
            >
              See the wizard →
            </Link>
            <span className="text-sm text-[#93A1B1]">Five questions, about ninety seconds.</span>
          </div>
        </div>
      </section>

      {/* Why these ads */}
      <section id="proof" className="mx-auto grid w-full max-w-[1180px] scroll-mt-20 items-center gap-16 px-5 py-24 sm:px-7 lg:grid-cols-[minmax(0,.95fr)_minmax(0,1.05fr)]">
        <div className="relative aspect-[4/3] min-w-0 overflow-hidden rounded-[18px] border border-zinc-200 shadow-[0_30px_60px_-36px_rgba(6,22,46,.45)]">
          <Image
            src="/brand/meta-adlibrary-blurred.png"
            alt="Meta ad library, filtered to active image ads running since before July"
            fill
            sizes="(min-width: 1024px) 540px, 100vw"
            className="object-cover object-left-top"
          />
          <div className="absolute bottom-3.5 left-3.5 flex items-center gap-2 rounded-full bg-navy/90 px-3.5 py-2 text-xs font-bold text-white">
            <span className="size-2 rounded-full bg-teal" />
            Active ads · running 90+ days · Australia
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-[22px]">
          <div className={eyebrow}>Why these ads</div>
          <h2 className={h2}>It copies the shape of ads that have been paying for themselves for months.</h2>
          <p className="m-0 text-[17px] leading-[1.65] text-zinc-600">
            Then it scans the Meta ad library for ads that have been running live for between three
            months and a year — because Meta publishes no spend or impression data for commercial
            ads, and an ad still running after a quarter is running because it pays for itself.
          </p>
          <p className="m-0 text-[17px] leading-[1.65] text-zinc-500">
            It reads those for <em>format</em>: the hook, the order the argument arrives in, where the
            offer sits. And it writes three ads per buyer in those shapes, pointed at that
            buyer&rsquo;s page.
          </p>
          <div className="flex flex-wrap gap-8 border-t border-zinc-200 pt-[22px]">
            {STATS.map(([n, label]) => (
              <div key={n} className="flex flex-col gap-1">
                <span className="text-[30px] font-extrabold tabular-nums tracking-[-0.03em]">{n}</span>
                <span className="text-[13px] leading-[1.4] text-zinc-500">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What it will not do */}
      <section id="limits" className="mx-auto flex w-full max-w-[1180px] scroll-mt-20 flex-col gap-9 px-5 py-24 sm:px-7">
        <div className="flex flex-wrap items-end justify-between gap-8">
          <h2 className="m-0 max-w-[520px] text-[clamp(28px,3.2vw,40px)] leading-[1.08]">What it will not do</h2>
          <p className="m-0 max-w-[460px] text-base leading-[1.6] text-zinc-500">
            Worth knowing before you start. The app says the same things on screen, at the moment
            they matter.
          </p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
          {LIMITS.map(([title, body]) => (
            <div key={title} className="flex flex-col gap-2 rounded-[14px] border border-zinc-200 px-[22px] py-5">
              <div className="text-base font-bold leading-[1.3]">{title}</div>
              <div className="text-sm leading-[1.6] text-zinc-500">{body}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Closing CTA */}
      <section
        className="text-white"
        style={{ background: 'linear-gradient(100deg,#06162E 0%,#0A2E5C 48%,#07695F 100%)' }}
      >
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-9 px-5 py-[88px] sm:px-7">
          <div className="flex max-w-[620px] flex-col gap-3.5">
            <h2 className="m-0 text-[clamp(30px,3.6vw,46px)] leading-[1.05] tracking-[-0.04em]">
              One product page in. Sixty ads out.
            </h2>
            <p className="m-0 text-[17px] leading-[1.6] text-[#C3CDD9]">
              You approve what you like, one row at a time. You paste it into Ads Manager and go.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href={START}
              className="rounded-full bg-white px-[30px] py-[17px] text-base font-extrabold text-zinc-900 transition-colors hover:bg-teal"
            >
              Start a campaign →
            </Link>
            <Link
              href="/login"
              className="rounded-full border border-white/35 px-[26px] py-[17px] text-base font-bold text-white transition-colors hover:border-white"
            >
              Log in
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-5 px-5 py-[34px] sm:px-7">
          <Image
            src="/brand/adtocart-lockup.png"
            alt="adtocart.cc — Your customers are unique. Why aren't your ads?"
            width={217}
            height={46}
            className="h-[46px] w-auto"
          />
          <div className="text-[13px] text-zinc-400">Different customer. Different ad. Better path to cart.</div>
          <div className="flex gap-[22px] text-[13px] font-semibold text-zinc-500">
            <a href="#how" className="hover:text-zinc-900">How it works</a>
            <Link href="/login" className="hover:text-zinc-900">Log in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
