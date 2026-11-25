# What the front end can rely on

The `scholarships` table, as loaded by `scripts/load-database.mjs`. Visitors see only rows with
`status = 'published'`; every published row has been read by a model (`criteria_read = true`).

## Who it is from

| Column | Meaning |
|---|---|
| `provider_name` | The organization that awards it. When the scholarship's own text names an awarder other than the page's owner, this is that awarder. |
| `found_on` | The page's owner, when it is not the awarder (a foundation or college page listing other organizations' scholarships). Null otherwise. |
| `funder_ein`, table `funders` | The IRS record of the provider, when known. |
| `source`, `tier` | Where the facts came from. `tier = 'filing'` means only a tax filing: show as "may fit, check with the funder". |

## What it is tied to

| Column | Meaning |
|---|---|
| `scope` | `school` = one college's own scholarship (`school_unitid` set). `open` = not owned by one college in our list. |
| `reach` | `school`: one college. `college`: requires a named college we could not match to the school list. `local`: requires a place or a named high school. `anyone`: no place or school required. |
| `required_states` | States from **required** place rules. A student elsewhere cannot get it. |
| `states` | Every state the rules name, required or preferred, plus the school's own state. |
| `school_types` | Kind of school required: `community-college`, `trade-school`, `four-year`, `graduate-school`, `hbcu`, `tribal-college`, `public-high-school`, `private-school`, `homeschool`. |

A scholarship that requires one named college found in the school list is moved to
`scope = 'school'` with that school's id. A state that the text does not give is added as a
**preferred** place rule (never required) when the scholarship's or provider's name contains a
state, or when the provider is a local organization whose tax filing has an address there. Those
rules carry `"inferred": true`.

## The rules

`criteria` is a list of `{kind, strength, values, state, quote}`; `inferred` appears only on the
state rules described above. `strength` is `required` or `preferred`. `quote` is the sentence the
rule was read from and was checked to be in the page text.

Kinds: `location`, `high_school`, `college`, `school_type`, `level`, `field`, `career`, `gpa`,
`test_score`, `citizenship`, `heritage`, `gender`, `age`, `need`, `first_generation`, `family`,
`affiliation`, `activity`, `military`, `disability`, `religion`, `enrollment`, `program`,
`prior_award`, `other`.

- `level` values: `middle-school`, `grade-9` to `grade-12`, `college-freshman` to
  `college-senior`, `graduate`, `adult-returning`. Community college and trade school are
  `school_type`, not levels.
- `program`: must be in or accepted to a named program, cohort or unit.
- `prior_award`: a condition about other aid (not already fully funded, past recipient, Pell eligible).
- `other`: what is left. Boilerplate such as "good academic standing" is removed.

Three states of knowledge:

| On the row | Meaning |
|---|---|
| a rule is present | the page states it |
| `criteria_read = true` and a kind is absent | the page was read and does not mention it |
| `criteria_read = false` | not read by a model; nothing is known (these rows are drafts, not published) |

## Typed columns

For rows a model has read, these are derived from the **required** rules, so they never
contradict `criteria`:

| Column | From |
|---|---|
| `grade_levels` | required `level` rules |
| `minimum_gpa` | required `gpa` rule |
| `citizenship` | required `citizenship` rules (`us-citizen`, `permanent-resident`, `daca-undocumented`, `international`) |
| `fields_of_study` | required `field` rules, original wording in lower case |
| `field_groups` | required `field` and `career` rules sorted into the fixed groups below |
| `need` | `required`, `considered` (a preferred need rule) or `no` |
| `enrollment` | `full-time`, `part-time` or `either` |

Field groups (`data/taxonomy/field-groups.json` holds the full mapping from wording to group):
agriculture, architecture-construction, arts-design, aviation-transportation, business,
communications, computing, education, engineering, environment, health, nursing,
hospitality-culinary, humanities, law-public-service, life-sciences, math-physical-sciences,
performing-arts, social-sciences, sports-recreation, stem-general, trades-technical.

## Money and dates

| Column | Meaning |
|---|---|
| `award_min`, `award_max`, `award_per_year`, `awards` | Null when the page does not say. |
| `deadline` | A date. With `deadline_recurring = true` the page gave a day without a year and this is its next occurrence. |
| `deadline_note` | Timing the page gives in words when it gives no date ("applications open each fall"). |
| `materials`, `apply_url`, `contact`, `url` | What to send and where. |

## Known limits

- The awarder, school types, program and prior-award kinds, and `deadline_note` come from the
  second version of the reading instructions. Open scholarships have been read with it;
  school-only ones were read with the first version and tidied by rule, so they have fewer of
  these.
- About a third of rows state an amount and about half a deadline; most pages do not give them.
- PDFs are not read.
