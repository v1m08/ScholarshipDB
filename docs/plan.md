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
