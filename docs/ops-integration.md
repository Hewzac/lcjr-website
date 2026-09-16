# What the website needs from the ops app

Written from the marketing site's side, against the integration spec.

**Both endpoints now exist** in the ops repo and the round trip has been run
end to end against a local D1: the site fetched live pricing, a browser
submission landed as a `jobs` row with `source = 'website'`, and a forged
`calculatorEstimateCents` was discarded in favour of the server's own maths.

Website: `lcjr.com` (see open question 1) · Ops app: `app.lcjunk.com`
Client code: [`src/quote.js`](../src/quote.js)

---

## Status

| Piece | State |
|---|---|
| ZIP gate, calculator, details form, partial capture | Built |
| Estimate maths in integer cents | Built, verified |
| Payload matching the spec's `createJobRequest` shape | Built, verified |
| `GET /api/pricing` | **Built** — `app/src/routes/api/pricing.ts` in the ops repo |
| `POST /api/requests` | **Built** — `app/src/routes/api/requests.ts` in the ops repo |
| Photo upload | Deliberately deferred to phase two |

The page still degrades on purpose: a failed pricing fetch hides the
calculator and shows call-and-text instead, rather than rendering prices that
might disagree with a supervisor's screen.

Point the site at a different API with `data-api-base` on `#quote-app` in
`quote.html` — e.g. `http://localhost:5273` while running the ops repo's dev
server. Whatever origin is used must also appear in `PUBLIC_SITE_ORIGINS`.

---

## 1. `GET /api/pricing`

Read once on page load, cached at the edge for an hour.

```json
{
  "loadFractions": [
    { "key": "eighth", "label": "1/8 load", "fraction": 0.125,
      "priceCents": 8900, "estMinutes": 30 }
  ],
  "surcharges": [
    { "key": "mattress", "label": "Mattress / box spring", "priceCents": 3500 }
  ],
  "serviceZips": [
    { "zip": "83501", "city": "Lewiston", "state": "ID" }
  ]
}
```

`snake_case` keys (`price_cents`, `est_minutes`, `service_zips`) are also
accepted — see `normalizePricing()` in `src/quote.js`. Pick one and stay with
it.

`city` and `state` on each ZIP are used to pre-fill the customer's city and to
keep ID/WA on the submission. Please include them.

---

## 2. `POST /api/requests`

The exact body the site sends today, captured from a live run:

```json
{
  "customerName": "Dana Reed",
  "phone": "208-555-0134",
  "zip": "83501",
  "state": "ID",
  "loadFraction": "half",
  "calculatorEstimateCents": 33400,

  "email": null,
  "address": "412 Main St",
  "city": "Lewiston",
  "description": "Old sectional, two mattresses, one tire, garage boxes",
  "surcharges": [
    { "key": "mattress", "quantity": 2, "unitPriceCents": 3500 },
    { "key": "tire", "quantity": 1, "unitPriceCents": 1500 }
  ],
  "estMinutes": 75,
  "itemsLocation": "garage",
  "stairsFlights": 1,
  "parkingNotes": "Driveway fits the truck",
  "preferredTimeframe": "this_week",
  "accessNotes": "Gate code 1234, friendly dog",
  "isCommercial": false,

  "incompleteIntake": false,
  "source": "website"
}
```

**Two fields were additions to the spec's table. Both are now settled:**

- `state` — accepted but **ignored**. `jobs` has no state column, and the
  endpoint derives city and state from `service_area_zips` rather than trusting
  a field a stranger can set. The site still sends it; it costs nothing.
- `source` — **kept**, and now a real column. Migration `0012_job_source.sql`
  adds `jobs.source` defaulting to `'ops_intake'`, which is accurate for every
  existing row because there was no public endpoint when they were written.

### Response the site expects

```json
{ "ok": true, "jobId": 4711, "reference": "LCJR-4711" }
```

`reference` is shown to the customer on the confirmation screen; `jobId` is
used as a fallback if `reference` is absent. If neither comes back the screen
still works, it just omits the reference line.

Field-level errors render inline:

```json
{ "ok": false, "errors": { "phone": "That number doesn't look right." } }
```

Any other failure shows a generic "call us instead" message, so a broken
endpoint never traps a lead behind a dead form.

### Behaviour the site is relying on

- **Recompute the estimate server-side and trust your own maths.**
  `calculatorEstimateCents` is a display artefact. It is sent so a supervisor
  can see the number the customer saw, not as an input to anything.
- **Validate the ZIP** against the service area. The site checks too, but the
  site's copy of the list came from you and a stranger can post anything.
- **Rate limit by IP.** Unauthenticated endpoint on a public site.
- **CORS to the marketing origin only**, not `*`. See open question 1 for
  which origin that is.

### Partial submissions

Per §4, once a visitor has given a name, phone and ZIP, the site posts with
`"incompleteIntake": true` if they leave before finishing — sent via
`fetch(..., { keepalive: true })` on `pagehide`/`visibilitychange`.

Practical consequences:

- These requests arrive with `loadFraction: null` and
  `calculatorEstimateCents: null`. Handle nulls.
- A visitor who leaves and finishes later can produce **two rows** for one
  person. De-duplicating on phone number within a short window would help.
- Out-of-area visitors who leave a number also come through this path, with a
  ZIP that is not in `service_area_zips`. They should land somewhere a
  supervisor sees rather than being rejected by ZIP validation.

---

## Open questions

1. **Which domain is the marketing site?** The spec says `lcjunk.com`; every
   page here currently says `lcjr.com` (OG tags, the privacy policy, the terms).
   The answer sets the CORS origin and needs fixing across the site either way.
2. ~~The public phone number is a placeholder.~~ **Done** — the site now uses
   `(208) 503-6307` / `tel:+12085036307` throughout.
3. **Callback window.** The ops app stamps `claim_deadline_at` at two business
   hours. The site currently promises no number — it says a supervisor "calls
   you back". Say the word and it can state the two-hour SLA, but only if
   that's a promise worth keeping.
4. **No confirmation text is promised**, deliberately, because `message_outbox`
   does not send yet. If a provider gets wired up, the confirmation screen
   should change to say so.
5. **Deposits.** The terms now state 25% on jobs at or over $400, taken by a
   supervisor after the real price is set and never through the website. If
   that threshold changes in the ops app, change it in `terms.html` too.
6. **Google Business review link** is still `REPLACE_WITH_GOOGLE_BUSINESS_LINK`
   on the ops side. The website does not link reviews yet.

## Not done, on purpose

- **Photo upload** — spec calls it phase two. The text submission works first.
- **Any price shown without a live fetch** — see the note at the top.
- **Payment, deposits, arrival windows, disposal pricing, crew or staffing
  figures** — all excluded per §5 and §8.
