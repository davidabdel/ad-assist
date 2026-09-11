# AdToCart — what this app actually does

Written from the code, not from memory. Every number below comes from a
constant or a migration in this repo.

---

## The elevator pitch

**One line**

> AdToCart turns one product page into twenty buyers, twenty landing pages and
> sixty ads — each one written for a different reason somebody would buy.

**Thirty seconds**

> Every ecommerce store runs the same ad at everybody. But nobody adds to cart
> for the same reason — one person is buying on price, one on time, one because
> they've been burnt before. AdToCart takes your product URL, works out twenty
> genuinely different buyers, writes each of them their own landing page, then
> goes and reads Meta's ad library to see what's actually working right now, and
> writes three ads per buyer in those shapes. You approve what you like, one row
> at a time. Two cents an image. You paste it into Ads Manager and go.

**Sixty seconds, for someone who runs ads**

> You already know the bottleneck isn't the media buying, it's the creative. You
> need twenty angles and you've got one product and one set of photos, so you
> end up running four variations of the same idea and calling it testing.
>
> AdToCart starts at the buyer instead of the creative. Give it your product URL
> and it reads the page — features, price, the actual customer reviews — and
> builds twenty buyer profiles that don't overlap. Each one gets a real landing
> page on its own URL, in your brand's colours, arguing the case that buyer
> cares about, with the seven things everybody cares about underneath.
>
> Then it scans the Meta ad library for ads that have been running live for
> between three months and a year — because Meta publishes no spend or
> impression data for commercial ads, and an ad still running after a quarter is
> running because it pays for itself. It reads those for *format*: the hook, the
> order the argument arrives in, where the offer sits. And it writes three ads
> per buyer in those shapes, pointed at that buyer's page.
>
> Nothing generates until you press a button. A picture is two cents, a ten
> second video is a dollar twenty-four, and there's a spend ceiling on the
> campaign you can't accidentally go through.

---

## What it is

A pipeline with nine stages and two places a human is required. You give it one
product. It gives you a set of landing pages and a table of ads, each ad tied to
the buyer and the page it belongs to.

It does **not** publish to Meta. The output is copy, pictures and URLs you paste
into Ads Manager.

---

## What you give it

| Input | Required | Notes |
|---|---|---|
| What kind of sale | yes | Physical product, digital ebook, or one specific vehicle |
| Product URL, pasted text, or a PDF | yes | Which of the three depends on the kind of sale |
| Checkout URL | no | The CTA points at the product page without one, and says so |
| Current offer | no | Free shipping, 20% off, whatever is live |
| Region | no | AU, US, GB, or all three. Defaults to AU. Decides which ad library gets read |
| Statics vs video per buyer | no | Defaults to 2 statics + 1 video, capped at 3 |
| Your own photographs | sometimes | Compulsory for a vehicle and an ebook, which have no storefront gallery |

**How many pages you get is a property of the sale, not a setting.** Twenty for
anything with unlimited supply. Five for a vehicle, because there is exactly one
of it, and twenty pages for one ute is twenty pages competing for the same sale.

---

## The pipeline, start to finish

Each stage is one unit of work. Nothing is held in memory — the campaign's
status plus what rows exist in the database *is* the progress, so a timeout, a
deploy or a closed laptop loses nothing.

### 1. Read the source

The server fetches the page itself and reads the structured data behind it —
Shopify's product JSON, JSON-LD — in about a second. Stores that refuse a plain
request are handed to a real Chrome on the Mac, which is slower and needs the
machine awake. A PDF is read on the server; there is no browser fallback,
because Chrome cannot read a PDF's text either.

Out: the page title, the price, the features, and **the real customer reviews**.

### 2. Write the product brief and read the brand

One call turns the raw page into a brief: what it is, what it does, the features
worth arguing, and verbatim review quotes. It also records the **gaps** — what it
could not find — rather than filling them in.

In the same step it reads your site's brand: primary and accent colour, fonts,
logo. Low confidence is flagged as low confidence. No site to read means neutral
pages rather than invented ones.

### 3. ⏸ The main page — **you approve this**

It writes one landing page: hero headline, ten reasons to buy, testimonials
pulled from real review quotes, the offer, the button.

**Everything stops here.** Reasons four to ten of this page get copied unchanged
onto every persona page, so a wrong main page is twenty wrong pages. It is the
one artefact in the run worth thirty seconds of your attention and the only
place a mistake is cheap.

If no real reviews were found it tells you here, before you approve, because
that means twenty pages with no proof section.

### 4. Pictures for the main page

Only after approval — you review the words wearing the clothes the buyer will
see them in, not a grey page.

It looks at every photograph available: your uploads first, then anything found
on the page. It captions each one, decides which are usable as editorial, and
places them.

**A reason whose picture nobody has genuinely photographed stays blank.** It
renders as text rather than borrowing an unrelated photo. That is deliberate and
it is the rule everywhere in this app.

### 5. Twenty buyers, five at a time

Each buyer gets a name, the pain point that actually moves them, what they
really want, the angle that hooks them, their own hero headline and their own
first three reasons. Reasons four to ten are the approved page's.

A batch that duplicates an existing pain point is rejected and rerun. **Three
empty batches in a row and it stops** and tells you the product may not support
twenty genuinely different buyers — rather than shipping near-identical pages.

Every buyer's page goes live at its own public URL, in your brand, with view
tracking and click tracking on it. Pages for a sale that closes on a phone call
— a vehicle — also carry a tap-to-call button and an enquiry form; pages that
close at a checkout do not, because the button is the conversion.

### 6. Read Meta's ad library

Queued to the Mac, because **Meta only shows its ad library to a real browser**.
This is the one stage that needs the machine awake.

Two things about how it searches that are easy to get wrong:

- **It searches ad-copy phrases, not your product category.** The library
  matches text inside the ad, so a niche term returns a niche — a handful of
  ads from a handful of advertisers, half of them the same company. We are not
  looking for competitors, we are looking for *format*, and format travels
  between categories.
- **The filter is run time and only run time.** Currently active, and started
  between 90 days and one year ago. Meta publishes no impressions, spend or
  reach for commercial ads — those fields exist only on political ads — so there
  is nothing else in the page to sort on. An ad live a full quarter is live
  because it pays for itself. The upper bound is there because an advertiser
  2,596 days in is a business that never turns its ads off, not a winner.

Ceiling of 300 ads per search, and it says so in the notes when it hits it
rather than truncating silently.

### 7. Extract the formats

It reads the qualifying ads and writes down their shape: the hook, the order the
argument arrives in, where the offer sits, how the CTA lands. Statics and video
separately, because they are different crafts.

**No formats at all is a hard stop.** Every ad idea is built on an observed
shape; with none observed, this stage would be a copywriter with no brief
pretending to have one.

### 8. Write the ads — one buyer per call

Up to three per buyer, built on the observed formats and pointed at that buyer's
landing page. Each idea carries the full Facebook field set: primary text,
headline, display link, button, and the picture or video instruction.

If no format of one type came out of the scan, those slots go to the other type
and it says so — rather than quietly shipping three statics when you asked for a
video.

For an ad none of your photographs honestly fit, it writes **the scene** to be
drawn instead — and the scene is the buyer's situation, not a fake photo of your
product.

**Nothing has cost anything yet.** Every stage above is text.

### 9. The table — this is where money starts

You get a table of up to sixty ads. Two buttons spend:

- **Make the picture** — $0.02. Draws it so you can look at it before deciding.
  For a static that picture *is* the ad, so approving afterwards is free. For a
  video it is the frame the shot opens on.
- **Approve** — submits it.

A made picture can be pushed onto that buyer's landing page as its hero with one
press, so the ad and the page it lands on show the same image. That costs
nothing; it is the same file.

---

## What it costs

| Thing | Credits | USD |
|---|---|---|
| A static built from your photograph (`nano-banana-edit`) | 4 | $0.02 |
| A static drawn from nothing (`nano-banana`) | 4 | $0.02 |
| A 10-second video, 720p, 9:16 (`seedance-2-fast`) | 248 | $1.24 |
| …plus its opening frame, if it hasn't been drawn yet | 4 | $0.02 |
| Everything else — briefs, pages, buyers, the scan, the ideas | — | model tokens only, roughly $1 a campaign |

A full sixty-ad campaign approved end to end, at the default 2:1 split, is about
**$26**. You approve them one at a time, so that is a ceiling and not a bill.

There is a **per-campaign spend ceiling, $150 by default**, enforced when the
spend is reserved rather than when it lands — so two clicks arriving together
cannot both squeeze through a limit only one of them fits under.

---

## How it runs when nobody is watching

Campaigns do not need a browser tab open. The Mac worker pokes the server every
ten seconds and the server moves every campaign along one unit. Lock your phone,
close the laptop, the run carries on.

(Vercel's own scheduler would be the obvious home for that and can't be: on the
Hobby plan a cron job fires once a day.)

---

## What it will not do

Worth knowing before you pitch it to anybody.

- **It does not publish to Meta.** You paste into Ads Manager.
- **"Winning ad" is a proxy, not a measurement.** Meta gives out no performance
  data for commercial ads. Still active after 90 days is the best evidence that
  exists, and it is evidence, not proof.
- **The ad-library scan needs the Mac awake** with a signed-in Facebook session
  in it. Every other stage runs on the server.
- **It never invents a photograph of your product.** A picture slot with no
  honest source stays empty.
- **Testimonials only come from real reviews found on the page.** No reviews
  means no testimonial section, and it warns you at the approval gate.
- **It will refuse to write twenty buyers that aren't really different.** Some
  products don't have twenty.

---

## Where things live

| | |
|---|---|
| App | Next.js on Vercel |
| Database | Supabase |
| The Mac's job | Ad-library scanning in real Chrome, and poking the server every 10s |
| Image and video models | KIE — `nano-banana`, `nano-banana-edit`, `seedance-2-fast` |
| Public landing pages | `/p/<campaign>/<buyer>` |
| The dashboard | `/campaigns/<id>` |
