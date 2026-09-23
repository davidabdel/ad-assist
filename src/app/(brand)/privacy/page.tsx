import Image from 'next/image';
import Link from 'next/link';

/**
 * The privacy policy, and the reason it exists at a URL rather than in a
 * drawer somewhere.
 *
 * Meta will not take an app out of Development mode without a privacy policy
 * URL it can fetch, and until the app is out of Development mode no ad creative
 * can be created at all — a Page post from a development app is refused
 * outright (subcode 1885183), no matter whose ad account it is. So this page is
 * a dependency of the publish feature, not paperwork alongside it.
 *
 * It is written from the schema rather than from a template. Every category
 * below is something the app genuinely stores: enquiries are the four fields in
 * `public.leads`, the counts are the two bump RPCs, and the Meta section
 * describes exactly what the publish path does. If a future change starts
 * collecting something else, this page is wrong until it is edited — which is
 * the point of listing fields instead of saying "certain information".
 */

export const metadata = {
  title: 'Privacy — AdToCart',
  description: 'What AdToCart collects, why, who it goes to, and how to have it deleted.',
};

const UPDATED = '23 September 2026';

function Section({ id, heading, children }: { id?: string; heading: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="mt-12 text-[22px] font-bold tracking-tight text-zinc-900">{heading}</h2>
      <div className="mt-3 space-y-4 text-[15px] leading-relaxed text-zinc-600">{children}</div>
    </section>
  );
}

export default function Page() {
  return (
    <div className="min-h-full bg-white">
      <header className="border-b border-zinc-200">
        <div className="mx-auto flex max-w-[760px] items-center justify-between px-5 py-6 sm:px-7">
          <Link href="/">
            <Image
              src="/brand/adtocart-lockup.png"
              alt="adtocart.cc"
              width={217}
              height={46}
              className="h-[38px] w-auto"
            />
          </Link>
          <Link href="/" className="text-[13px] font-semibold text-zinc-500 hover:text-zinc-900">
            Back to site
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-5 pb-24 pt-10 sm:px-7">
        <h1 className="text-[34px] font-bold leading-tight tracking-tight text-zinc-900">
          Privacy Policy
        </h1>
        <p className="mt-3 text-[15px] text-zinc-500">
          Last updated {UPDATED}
        </p>

        <div className="mt-8 space-y-4 text-[15px] leading-relaxed text-zinc-600">
          <p>
            AdToCart is operated by <strong className="font-semibold text-zinc-900">UConnect
            (International) Pty Limited</strong> (ABN 38 159 803 611), an Australian company.
            This policy covers adtocart.cc, the AdToCart application, and the landing pages
            AdToCart publishes on behalf of the businesses that use it.
          </p>
          <p>
            It is written to be specific. Where it lists what is stored, that is the whole
            list — not an example.
          </p>
        </div>

        <Section heading="Who the two kinds of people are">
          <p>
            <strong className="font-semibold text-zinc-900">Customers</strong> are businesses
            that sign in and use AdToCart to build landing pages and ads for their own
            products.
          </p>
          <p>
            <strong className="font-semibold text-zinc-900">Visitors</strong> are members of
            the public who arrive on a landing page AdToCart published for one of those
            businesses. A visitor&rsquo;s details belong to that business, not to us. We hold
            them on its behalf.
          </p>
        </Section>

        <Section heading="What we collect from customers">
          <ul className="list-disc space-y-2 pl-5">
            <li>An email address and password, to sign in.</li>
            <li>
              The product page address you give us, and the contents of that page — its
              description, images, price and any customer reviews shown publicly on it.
            </li>
            <li>The campaigns, landing pages and ad copy the app produces for you.</li>
            <li>
              A record of what was generated and what it cost, so spending against your
              limit can be shown to you.
            </li>
          </ul>
          <p>
            We do not take payment details on this site, and we do not store card numbers
            anywhere.
          </p>
        </Section>

        <Section heading="What we collect from visitors">
          <p>
            A landing page published by AdToCart collects nothing at all unless the visitor
            fills in the enquiry form. If they do, we store exactly four things:
            <strong className="font-semibold text-zinc-900"> name, phone number, email
            address if given, and the message they wrote</strong> — along with which page
            they were on, so the business knows which of its ads produced the enquiry.
          </p>
          <p>
            Separately, each landing page keeps two running counts: how many times it was
            viewed, and how many times its button was clicked. These are numbers only. They
            are not tied to a person, a device or an address, and they cannot be traced back
            to any individual visitor.
          </p>
          <p>
            <strong className="font-semibold text-zinc-900">AdToCart&rsquo;s own landing
            pages set no cookies and run no advertising or analytics trackers.</strong> A
            business using AdToCart may choose to add its own Meta pixel to its pages; where
            it has, that business is responsible for disclosing it, and Meta&rsquo;s own
            privacy terms apply to what the pixel collects.
          </p>
        </Section>

        <Section heading="Why we hold it">
          <p>
            To run the service: to sign you in, to build the pages and ads you asked for, to
            pass you the enquiries your pages produce, and to show you what you have spent.
            We do not use customer content or visitor enquiries to train models of our own,
            and we do not sell or rent personal information to anybody.
          </p>
        </Section>

        <Section heading="Who else sees it">
          <p>
            AdToCart sends data to a small number of processors, and only what each one
            needs to do its job:
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="font-semibold text-zinc-900">Supabase</strong> — the database
              and file storage holding everything described above.
            </li>
            <li>
              <strong className="font-semibold text-zinc-900">Vercel</strong> — hosting, which
              handles the web requests themselves.
            </li>
            <li>
              <strong className="font-semibold text-zinc-900">OpenAI</strong> — receives the
              product information you supply, in order to write the pages and ad copy. It
              never receives visitor enquiries.
            </li>
            <li>
              <strong className="font-semibold text-zinc-900">KIE.ai</strong> — receives the
              image and video instructions the app writes, in order to generate the pictures.
              It never receives visitor enquiries.
            </li>
            <li>
              <strong className="font-semibold text-zinc-900">Meta Platforms</strong> — only
              when you connect an ad account, and only as described below.
            </li>
          </ul>
          <p>
            Some of these operate outside Australia, so information you give us may be
            processed overseas.
          </p>
        </Section>

        <Section id="meta" heading="Connecting a Meta ad account">
          <p>
            Connecting Meta is optional, and AdToCart works without it. If you do connect
            one, the app reads the list of ad accounts, Facebook Pages and pixels you already
            have access to, so it can show them to you in a dropdown.
          </p>
          <p>
            When you publish, the app creates a campaign, ad sets, creatives and ads in the
            ad account you chose, from the copy and pictures you approved. Every one of them
            is created <strong className="font-semibold text-zinc-900">paused</strong>.
            AdToCart never starts an ad running and never changes a budget on an ad it did
            not create.
          </p>
          <p>
            We do not read your Meta advertising results, your customer lists, your audiences
            or your Page messages, and we never post to your Page other than the ad creatives
            you approved.
          </p>
        </Section>

        <Section heading="How long it is kept">
          <p>
            Campaign content is kept for as long as your account is open. Visitor enquiries
            are kept until the business that received them deletes them or closes its
            account. When an account is deleted, its campaigns, pages, generated files and
            enquiries are deleted with it.
          </p>
        </Section>

        <Section id="data-deletion" heading="Getting your data deleted">
          <p>
            Email <a className="font-semibold text-zinc-900 underline" href="mailto:david@uconnect.com.au">david@uconnect.com.au</a> from
            the address on the account, or — if you are a visitor who filled in a form — from
            the address you used, saying what you want removed.
          </p>
          <p>
            We will confirm within 7 days and complete the deletion within 30. Deletion
            removes the records from the live database and from file storage. Where a landing
            page was published publicly, it is taken down at the same time.
          </p>
          <p>
            You can also ask for a copy of what we hold, or ask us to correct it, the same
            way.
          </p>
        </Section>

        <Section heading="Security">
          <p>
            Data is held in access-controlled databases, and the keys that can reach it are
            held server-side only — they are never sent to a browser. No system is perfect,
            and we do not claim otherwise; if a breach ever put personal information at
            serious risk we would notify the people affected and the Office of the Australian
            Information Commissioner, as the Privacy Act requires.
          </p>
        </Section>

        <Section heading="Children">
          <p>
            AdToCart is a business tool and is not directed at anybody under 18. We do not
            knowingly collect information from children.
          </p>
        </Section>

        <Section heading="Complaints">
          <p>
            If you think we have mishandled your information, write
            to <a className="font-semibold text-zinc-900 underline" href="mailto:david@uconnect.com.au">david@uconnect.com.au</a> and
            we will respond within 30 days. If you are not satisfied with our answer you can
            complain to the Office of the Australian Information Commissioner
            at <a className="font-semibold text-zinc-900 underline" href="https://www.oaic.gov.au" rel="noopener noreferrer" target="_blank">oaic.gov.au</a>.
          </p>
        </Section>

        <Section heading="Changes">
          <p>
            If this policy changes, the date at the top changes with it. Material changes
            affecting customers will also be told to customers by email.
          </p>
        </Section>
      </main>

      <footer className="border-t border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-[760px] flex-wrap items-center justify-between gap-4 px-5 py-8 text-[13px] text-zinc-400 sm:px-7">
          <span>UConnect (International) Pty Limited · ABN 38 159 803 611</span>
          <Link href="/" className="font-semibold text-zinc-500 hover:text-zinc-900">adtocart.cc</Link>
        </div>
      </footer>
    </div>
  );
}
