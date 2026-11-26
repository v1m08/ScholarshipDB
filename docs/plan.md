# Plan: accurate, matchable scholarship listings

Goal: tell a student which scholarships fit them, including the obscure ones, with a reason for
each. About three days of work, paid for by credits already in hand.

## Rules that keep it accurate (all automatic)

1. **No text, no match.** A scholarship is only matched if we hold its own text or its IRS filing text.
2. **Every criterion quotes its source.** Code checks the quote exists word for word in the saved
   text and drops the criterion if not.
3. **Three states per factor.** Required / not a factor (text read, not mentioned) / unknown.
4. **Spot-check before the full run.** 50 scholarships read by hand against the model's output.

## Data shape

A scholarship is a list of criteria; a student is a list of facts in the same vocabulary.

```json
{
  "kind": "location | school | level | field | gpa | citizenship | heritage | gender | need | family | affiliation | activity | military | disability | religion | other",
  "strength": "required | preferred",
  "value": "Polk County, IA",
  "quote": "Open to graduating seniors who reside in Polk County, Iowa."
}
```

Plus amount, number of awards, deadline, how to apply, and whether the source is the scholarship's
own page or only the IRS filing ("may fit, check this").

## Day 1: data in
- Pull the repair run's results; wire them into the builder; merge duplicates.
- Build IRS filings into funder records (restrictions, deadline, contact).
- Start the crawl of the ~21,700 websites named in filings on the server (runs unattended).

## Day 2: extraction
- One cheap model reads each text into criteria with quotes; code verifies every quote.
- Try it on 50, check by hand, fix the prompt, then run everything as a batch.
- Load criteria into Supabase.

## Day 3: matching
- Profile from a short form (sensitive questions optional) plus résumé for activities and places.
- Rule out on required criteria, compare common fields, compare free-text criteria by meaning,
  model checks the top few dozen. Each result lists its reasons and quoted lines.
- Publish; the front end (separate project) reads it.

## Later, only if it takes off
- Re-fetch pages each quarter, new IRS filings each year, a "this is wrong" button.
- PDFs (currently skipped).

## Cost

Model prices are from third-party trackers and not verified.

| Item | Cost | Paid by |
|---|---|---|
| Extraction, about 250,000 texts on a cheap model, batch | about $50 to $100 | OpenAI credit |
| A few re-runs while fixing the prompt | about $100 to $200 | OpenAI credit |
| Matching, under 1 cent per student | about $10 per 1,000 students | OpenAI credit |
| AWS crawling and storage | a few dollars | AWS credit |
| Supabase | $0 on the free plan if the data fits, else $25 a month | cash, only if needed |

Out of pocket: $0 unless Supabase needs the paid plan.

## Finishing the rest (written 2026-11-25)

Where it stands: 136,688 scholarships published, every one read by a model. Supabase holds only
those (341 MB of 500). Model spending is $37 of a $70 limit. What is left, by sighting counts
from `data/records/summary.json` (one scholarship can be sighted more than once):

| Pile | Sightings | Why it is not published |
|---|---|---|
| Has some text, not read | 15,000 | never sent to the model |
| Name on a list page, no text of its own | 73,000 | only the list page was fetched |
| Name not found on the provider's site | 75,000 | the page we guessed is not the right one |
| Site refuses crawlers, or page failed | 16,000 | robots.txt or an error |
| No provider or school identified | 20,000 | nothing to look up |
| Funders known only from tax filings | 48,500 funders | no website found |

One stage at a time, cheapest and most likely first. Every stage is the same loop:
crawl on the server, `build-records`, read only the new texts, `load-database --all`,
`--publish-read`, compact, measure the size.

1. **Read what already has text** (15,000). No crawling. About $3.
2. **PDFs.** Many name-only rows link to a PDF flyer or application. Extract the text on the
   server and feed it to the same reader. No model cost until the read.
3. **One click deeper on list pages** (73,000). Follow the link next to each name; where there
   is none, use the paragraph around the name on the list page as its text.
4. **Find the right page on provider sites** (75,000). Use each site's sitemap and its own
   search to find the page that names the scholarship. Lowest yield; stop when a sample of 500
   turns up fewer than one in ten.
5. **Tax-filing funders.** Search for a website only for funders whose filing shows grants to
   individuals; the rest stay in the local files.
6. **Left alone:** sites that refuse crawlers, and names with no provider.

Stop rules:
- Model spending stops at $70 in total. Stages 1 to 3 should fit in the $33 left; stage 4 is
  read only with what remains.
- The database stops at 450 MB. A published row costs about 2.2 KB with its indexes, so about
  50,000 more fit. If more than that turn up, the 48,500 funders with no published scholarship
  can go (26 MB), then the choice is a paid plan or publishing only the open scholarships
  from the new stages.
- After every load: `node scripts/load-database.mjs --drop-hidden`, then
  `vacuum (full, analyze) public.scholarships;` alone in the SQL editor.
