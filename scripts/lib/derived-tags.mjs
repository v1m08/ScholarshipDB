// Canonical taxonomy tags that follow directly from structured record fields.
// These are derived at index time, after every overlay, so a replace-mode tag
// overlay can never erase a fact a structured source observed.
//
// Only definite observations derive a tag: `essay: false` survives
// normalization solely for structured sources and verified enrichment (legacy
// imports coerce it to null), and `true` booleans are affirmative claims from
// any source.
export function deriveStructuralTags(record) {
  const tags = [];
  if (record.requirements?.essay === false) tags.push("no-essay");
  if (record.requirements?.needBased === true) tags.push("financial-need");
  if (record.requirements?.meritBased === true) tags.push("merit-based");
  return tags;
}
