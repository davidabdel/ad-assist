# Handoff: AdToCart marketing site + campaign wizard

## Overview
Three linked screens for adtocart.cc, the SaaS front of the `davidabdel/ad-assist` Next.js app:

1. **Landing page** – sells the product (one product page in → 20 buyers, 20 landing pages, 60 ads out). Every CTA goes to Login.
2. **Login / Create account** – gate in front of the wizard. Logging in lands on the wizard.
3. **Campaign wizard** – the existing five-question `Wizard.tsx` flow redesigned as one question per screen, followed by the build pipeline (`CampaignProgress.tsx` stages), the approval gate on the main page, and the ad-ideas table.

Flow: Landing → Login → Wizard (5 steps) → Build progress → Approve main page → Ad ideas table.

## About the design files
The `.dc.html` files in this bundle are **design references written in HTML**. They are prototypes that show intended look and behaviour; they are not production code. The job is to **recreate them inside the existing Next.js / React / Tailwind codebase** (`src/app`, `src/components`, `src/lib`) using its patterns – reuse `wizard-draft.ts`, `product-type.ts`, `campaign-steps.ts`, `ad-fields.ts` for data and behaviour. Open each `.dc.html` in a browser to see it live (`support.js` and `image-slot.js` must sit beside them).

## Fidelity
**High-fidelity.** Colours, type, spacing, copy and interactions are final. Recreate pixel-close. The persona and ad copy in the wizard is sample data (a merino running shoe) – wire it to real campaign data. The six hero ad cards on the landing page use real Buzz Cleaning content from a live campaign; keep that content as the launch demo.

---

## Design tokens

Brand guidelines: `uploads/adtocart-brand-guidelines.md` in the original project (Manrope, navy, blue→teal gradient).

**Colours**
- Navy (primary text, dark surfaces, primary buttons): `#06162E`
- Blue (accent, links, eyebrows): `#087DE8`
- Mid blue (gradient stop): `#079FD5`
- Teal (gradient end, success, glow): `#08C7B2`
- Brand gradient: `linear-gradient(90deg,#087DE8,#079FD5,#08C7B2)`
- Body text secondary: `#5B6672`; tertiary: `#8B949E`; on-dark secondary: `#A9B6C4` / `#C3CDD9`; on-dark tertiary: `#93A1B1`
- Borders: `#E7EBF0` (light), `#DDE3EA` (inputs); row dividers `#EEF1F5`
- Surfaces: white; light grey band `#F6F8FA`; input tint `#F1F4F7`; page canvas (wizard doc) `#e9edf2`
- Tints: blue `#EEF6FE`; teal `#E6F7F4` / `#F0FBF9` (border `#BDEDE6`); amber `#FDF1E4` (text `#B4560B`); error text `#C2410C`, error bg `#FDF3EC`, error border `#F97316`
- Buzz page avatar: `#0FA3B1`

**Typography** – Manrope (Google Fonts, 400–800), `-webkit-font-smoothing:antialiased`.
- Display H1 landing: `clamp(40px,5.2vw,68px)` / 1.02 / 800 / letter-spacing `-.04em`
- H2 sections: `clamp(30px,3.4vw,44px)` / 1.08 / 800 / `-.035em`
- Wizard H1: 44px / 1.05 / 800 / `-.035em`; build view H1 38px; login H2 32px
- Eyebrow: 12px / 700 / letter-spacing `.14em` / uppercase / `#087DE8`
- Body large 17–18px / 1.6–1.65; body 15–16px / 1.5–1.6; small 13–14px; micro labels 11px / 700 / `.1em` uppercase
- Numbers use `font-variant-numeric: tabular-nums`

**Radii** – pills `999px`; cards 12–14px; large cards/panels 16–18px; inputs 12px; small chips 6–8px.

**Shadows** – card lift `0 18px 40px -24px rgba(0,0,0,.7)` (on dark); panel `0 30px 60px -30px rgba(6,22,46,.35)`; CTA glow `0 10px 24px -10px rgba(8,125,232,.7)`; logo tile glow `0 0 32px rgba(8,199,178,.45)`.

**Spacing** – section padding 96px vertical / 28px horizontal, content max-width 1180px. Wizard column 720px wide; wizard frame 1240×880 at desktop. Gaps: 22px between form groups, 12–14px between cards, 8–10px between chips.

**Motion** – step change: fade + 8px rise, 220ms ease. Pipeline card entry: `all .5s cubic-bezier(.2,.7,.2,1)` from `opacity 0; translateY(18px); scale(.96)`. Progress bars `width .3s linear`. Spinner `spin .8s linear infinite`. Hover: navy buttons → `#087DE8`; outline buttons → navy border.

---

## Screen 1 – Landing (`AdToCart Landing.dc.html`)

Fluid, max-width 1180. Sections top to bottom:

**Header** – sticky, `rgba(255,255,255,.9)` + `backdrop-filter: blur(12px)`, bottom border `#E7EBF0`, 14px/28px padding. Left: icon mark (36px) + wordmark "adtocart" (23px/800, `.cc` in `#8B949E`). Centre nav (14px/600 `#5B6672`, nowrap): How it works · Why these ads · What it won't do (anchors `#how #proof #limits`). Right: "Log in" text link and "Start a campaign" navy pill (11px 20px, 14px/700) → **Login**. Below ~900px the nav wraps onto its own row (`order:3; flex:1 0 100%`).

**Hero** – navy `#06162E` full-bleed, two radial glows (`rgba(8,199,178,.22)` top-right, `rgba(8,125,232,.28)` bottom-left). Grid `1.05fr / .95fr`, gap 56, padding 92px top.
- Left: pill badge "PERSONALISE · CONVERT · GROW" (teal text, 12px/700 `.1em`, border `rgba(255,255,255,.22)`); H1 "Your customers are unique. / Why aren't your ads?" (line 2 in brand gradient text); sub `clamp(17px,1.5vw,21px)` `#C3CDD9` – the one-line pitch; URL input group (`rgba(255,255,255,.06)` bg, `rgba(255,255,255,.16)` border, radius 16, padding 10) with transparent input 16px and gradient button "Build my ads →" (15px 24px, radius 12, 15px/800) → **Login**; trust line 13px `#93A1B1`: "Free to start · No card up front · No Meta account connected".
- Right: label row "ONE PRODUCT / SIXTY ADS" (11px `#6E8099`); grid `repeat(auto-fit,minmax(150px,1fr))` gap 12 of six mini Meta-feed cards (white, radius 12, shadow). Card: header with 20px teal circle "b" + "Buzz Cleaning" (10px/700, nowrap); primary text 10px `#3E4A59` min-height 42; square image (`object-fit:cover`); footer `#F0F2F5` with headline 10px/800 + CTA chip (`#E4E6EB`, 9px/700). Caption 12px `#6E8099`: "Six of sixty for Buzz Cleaning. Each one written for a different buyer and pointed at that buyer's own page."

Card content (image → text → headline → CTA):
1. `buzz-grapes.png` (object-position 50% 60%) — "Gentle enough to clean fruit and veg without rinsing. Made from water, salt and vinegar." — "Spray it on the grapes" — Shop Now
2. `buzz-unbox.png` (50% 40%) — "Snack areas, toys, hands and paws. Rethink what belongs on the family counter." — "Rethink the family spray" — Learn More
3. `buzz-kid-dog-book.jpg` (60% 50%) — "Safe for children, pets and adults when used as directed. 99.9% of germs, gone." — "Safe around the small ones" — Learn More
4. `buzz-tap.jpg` — "Fill with tap water, squeeze in one capsule, plug it in. Ready in 7 minutes." — "Just add water" — Get Offer
5. `buzz-wipe.jpg` — "Counters, handles and the spots everyone touches on the way in. HOCL, made at home." — "Sanitise high-touch spots" — Get Offer
6. `buzz-kid-dog.jpg` — "One reusable BPA-free bottle. No more disposable sprays under the sink." — "Refill. Reuse. Buzz." — Shop Now

**Pillars band** – `#F6F8FA`, 26px padding, four items (glyph 22px + 12px/600 `.16em` uppercase): Unique customers · Smarter ads · More sales · A more personal shopping world.

**The problem** – two columns gap 64. Left: eyebrow "The problem"; H2 "Every ecommerce store runs the same ad at everybody."; p 18px `#3E4A59`: "But nobody adds to cart for the same reason — one person is buying on price, one on time, one because they've been burnt before."; p 17px `#5B6672`: the "bottleneck isn't the media buying" paragraph (verbatim from the pitch). Right: 2×3 persona cards (border `#E7EBF0`, radius 14, padding 16): number `01`–`06` (11px blue), tag chip (10px/700; blue/amber/teal tints cycling), name 15px/700, pain 13px `#5B6672`. Sample: The commuter (Time) · The nervous first-timer (Risk) · The gift buyer (Certainty) · The burnt-before (Proof) · The upgrader (Novelty) · The wool sceptic (Doubt). *Swap to Buzz personas if you prefer one product throughout.*

**How it works** (`#how`) – navy band. H2 "AdToCart starts at the buyer instead of the creative." + intro 16px `#93A1B1` "Five things happen after you paste a link. One of them needs you; the rest run whether your laptop is open or not." Five columns (`auto-fit minmax(220px,1fr)`, top border `rgba(255,255,255,.16)`, right dividers `.1`): 01 It reads your product page · 02 It writes the main page — you approve it · 03 Twenty buyers who do not overlap · 04 It reads Meta's ad library · 05 Sixty ads, approved one row at a time (body copy in the file). White pill "See the wizard →" → **Login**, caption "Five questions, about ninety seconds."

**Why these ads** (`#proof`) – grid `.95fr / 1.05fr`. Left: 4:3 image `assets/meta-adlibrary-blurred.png` (radius 18, border, `object-position: top left`) with a navy pill overlay bottom-left "● Active ads · running 90+ days · Australia" (teal dot). Right: eyebrow "Why these ads"; H2 "It copies the shape of ads that have been paying for themselves for months."; two paragraphs from the pitch (ad library 3–12 months; "reads those for *format*"); stat row (30px/800 + 13px label): 90–365 "Days an ad must have been live to qualify" · 300 "Ads read per search, ceiling stated not hidden" · 0 "Words of theirs that travel into your ads".

**What it will not do** (`#limits`) – H2 + intro, then `auto-fit minmax(280px,1fr)` cards (radius 14, padding 20/22, title 16px/700, body 14px): It does not publish to Meta · "Winning ad" is a proxy, not a measurement · It never invents a photograph of your product · Testimonials only come from real reviews · It refuses to write twenty buyers that aren't really different.

**Closing CTA** – gradient band `linear-gradient(100deg,#06162E 0%,#0A2E5C 48%,#07695F 100%)`. H2 "One product page in. Sixty ads out." + "You approve what you like, one row at a time. You paste it into Ads Manager and go." Buttons: white pill "Start a campaign →" → Login; outline pill "Log in" → Login.

**Footer** – full lockup `assets/adtocart-lockup.png` (46px tall), tagline "Different customer. Different ad. Better path to cart.", links How it works · Log in.

Pricing was deliberately removed from the landing page: plans and credits are explained inside the app after sign-up.

---

## Screen 2 – Login (`AdToCart Login.dc.html`)

Full-height grid `1fr / 1.05fr`.

**Left panel** – navy with two radial glows. Top: logo = 48px white tile (radius 12, `0 0 0 1px rgba(255,255,255,.18), 0 0 32px rgba(8,199,178,.45)`) holding the 36px icon, + "adtocart.cc" wordmark 26px/800 white. Middle: H1 `clamp(30px,3.2vw,44px)` "Your customers are unique. / Why aren't your ads?" (gradient line 2), sub 16px `#A9B6C4`. Bottom: three check rows (18px teal-tint circle ✓, 14px `#C3CDD9`): Twenty buyer profiles that do not overlap · Ad shapes read from Meta's live ad library · Nothing generates until you press a button.

**Right panel** – centred 400px column, gap 20.
- H2 32px + sub 15px: Log in → "Welcome back" / "Pick up where your campaigns left off."; Create → "Start your first campaign" / "One product page is all you need to begin. No card, no Meta account."
- Segmented control (`#F1F4F7` pill, padding 4; active tab white with `0 1px 3px rgba(6,22,46,.14)`): Log in | Create account.
- Google button (white, 1.5px `#DDE3EA` border, radius 12, 13px padding, 15px/700): "Continue with Google" / "Sign up with Google". → Wizard.
- "or" divider.
- Work email input (1.5px border, radius 12, padding 14/16, 15px; focus border `#087DE8`; error border `#F97316`).
- Password field (log-in mode only) with "Forgot it?" link.
- Error block (`#FDF3EC` / `#F6D6BE` / text `#C2410C`): "That does not look like an email address."
- Gradient submit (radius 12, 16px padding, 15px/800, glow shadow): "Log in →" / "Create my account →". Enter submits.
- Create-account success (`#F0FBF9` / `#BDEDE6`): "Check **{email}** — there's a sign-in link waiting. It expires in fifteen minutes."
- Footnote toggle ("No account yet? Create one" / "Already have one? Log in") and a 12px note: "Joining is free. Plans and credits are explained once you're in."

Behaviour: validate `/.+@.+\..+/`; log-in success navigates to the wizard; create-account shows the magic-link message.

---

## Screen 3 – Campaign wizard (`AdToCart Wizard.dc.html`)

Desktop frame 1240×880, white, radius 16. Top 3px brand-gradient progress bar scaled `(step+1)/7` through the questions, 72→100% through the build. Header: icon + wordmark left; right shows "{campaign title} · {status label}" once in the pipeline, plus a "Start over" outline pill. During the five questions a five-segment rail sits under the header (labels Selling · About it · Buying · Audience · Check; 11px uppercase; active segment navy bar, done segments gradient, pending `#E7EBF0`). Each step: eyebrow "Step n of 5", H1 44px, intro 16px, controls, then a Back text link and a navy "Next →" pill. Step transitions fade/rise 220ms.

**Step 1 – What are you selling?** Three large radio cards (2px border, radius 14, padding 18/22, 44px glyph tile). Selected = navy fill, white text. Options and copy from `product-type.ts`: Physical product (20 pages, ends in checkout link) · Digital ebook (upload PDF or sales page) · Motor vehicle or boat (5 pages, ends in phone number + enquiry form). Intro: "This is the only answer that changes the rest of the app…"

**Step 2 – Tell us about it.** Mode chips per product type (I have a link / I will type it out; ebook: Upload the PDF / Use its sales page). URL input 18px with label/placeholder/help that changes by type (vehicle: "Listing address", carsales placeholder). Textarea for typed mode (min 40 chars; live counter in the error text). Two-column row: photo drop zone (dashed `#DDE3EA`, "+" tile) with help text by type, and Campaign name input auto-filled from the URL slug (Title Case). Validation copy verbatim in the file (e.g. "That does not look like a web address. It should look like https://yourshop.com/products/your-product"). Enter submits.

**Step 3 – How do people buy it?** Checkout/buy link (or phone number for contact CTA) + "What is the current offer?" with help "Written exactly as a customer should read it. It goes in the bar across the top of every page…".

**Step 4 – Who are we advertising to?** Region chips Australia · United States · United Kingdom · All three (help "Picking all three takes longer."). Video split cards: "2 pictures + 1 video" (Recommended…) / "1 picture + 2 videos". Note about video cost ratio.

**Step 5 – Check it over.** Review table (label 190px 13px/700 `#5B6672`, value 15px, "Change" link jumps to that step). Teal reassurance box "This does not cost anything…" (✓ teal circle). Gradient "Build my campaign →" pill with glow.

**Build view.** Grid `480px / 1fr`, gap 56. Left: H1 changes ("Reading, then writing." → "One thing needs you." → "Building the rest." → "Done."); seven stage rows (26px status circle: done = blue fill ✓, active = spinner, waiting = teal pulse; 15px title, 13px detail, right-aligned blue count) from `campaign-steps.ts`: Reading your product page · Summarising what you sell · Writing the main page, for you to approve · Choosing photos from your own site · Writing N landing pages · Studying ads that already work · Writing your ad ideas; gradient progress bar underneath. Right column:
- **Approval gate** (after stage 3): eyebrow "Your approval needed", title "The main page, written for the broadest buyer", note "Seven of its ten reasons go onto all N pages unchanged." Page preview card (navy offer bar with the offer text, host, 28px headline, sub, 200px photo placeholder, "Ten reasons to buy" two-column list, testimonial block). Buttons: navy "Approve the main page →", text "Edit the words first", note "Nothing else runs until you approve."
- **Live pages** (after approval): 4-column buyer cards animating in as pages count up (number, tag chip Wants/Fears/Needs, name, pain line, mono URL `/p/{slug}/{buyer}`); eyebrow/title/note update as the scan and ideas run.

**Ad ideas table.** Eyebrow "Your ad ideas are waiting for you", H1 "{N×3} ad ideas across N buyers.", sub with per-asset prices; right: "Spent · ceiling $150", running total 28px, teal bar. Columns `150 110 1fr 200 108 150 96`: Buyer (+ "→ their page") · Format chip (Static teal tint / Video blue tint) · Primary text (2-line clamp) · Headline · Button chip · Picture cell ("Make it · $0.02" outline button → gradient "Drawn · $0.02" tile) · Approve (navy button → "Approved ✓" teal; row turns `#F0FBF9`/`#BDEDE6`). Footer: "Showing 6 of N…" + "Show all buyers" pill. Fields from `ad-fields.ts`.

State: `step (0–6)`, `draft` (product_type, mode, source_url, raw_input_text, title, checkout_url, current_offer, region, videos), `err`, pipeline `t`/`approved`, `pictures{}`, `approvals{}`. Speed multiplier prop for demo only.

---

## Assets (`assets/`)
- `adtocart-icon.png` – cart/fingerprint mark, transparent (header logo, favicon).
- `adtocart-lockup.png` – full wordmark + tagline (footer only; too small elsewhere).
- `adtocart-logo.png`, `adtocart-mark.png` – earlier copies of the same two files; can be dropped.
- `buzz-grapes.png`, `buzz-unbox.png`, `buzz-kid-dog-book.jpg`, `buzz-kid-dog.jpg`, `buzz-wipe.jpg`, `buzz-tap.jpg` – Buzz Cleaning campaign photos supplied by the client for the hero cards.
- `meta-adlibrary-blurred.png` – Meta Ad Library screenshot with third-party ad cards blurred; chrome, search and filter chips left sharp.

## Files
- `AdToCart Landing.dc.html`, `AdToCart Login.dc.html`, `AdToCart Wizard.dc.html` – the three screens.
- `support.js`, `image-slot.js` – runtime for viewing the prototypes in a browser; not for production.
- `github.md` – repo association and screen map to the source files these were built from.
