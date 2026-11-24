// Read one IRS e-filed return (the XML the IRS publishes for Forms 990 and 990-PF) into a
// plain record. Every value comes from a named field of the form; nothing is guessed.
//
// Privacy: foundations list the people they paid. A grant recipient's name is kept only when
// the recipient is an organization (a college, a school district); for a person we keep the
// purpose and the amount, never the name. Officers and trustees are counted, not named.

// ---------------------------------------------------------------- a small XML reader
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
  if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
  const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
  return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
});

// Returns a tree of { tag, kids, text }. Namespace prefixes and attributes are dropped.
export function parseXml(xml) {
  const root = { tag: "", kids: [], text: "" };
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (let match; (match = token.exec(xml)); ) {
    const top = stack[stack.length - 1];
    if (match[5] !== undefined) { top.text += match[5]; continue; }
    if (!match[2]) continue;
    const tag = match[2].replace(/^.*:/, "");
    if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
    const node = { tag, kids: [], text: "" };
    top.kids.push(node);
    if (!match[4]) stack.push(node);
  }
  return root;
}

const all = (node, path) => {
  let nodes = node ? [node] : [];
  for (const tag of path.split("/")) nodes = nodes.flatMap((item) => item.kids.filter((kid) => kid.tag === tag));
  return nodes;
};
const first = (node, path) => all(node, path)[0] || null;
const clean = (value) => decode(value).replace(/\s+/g, " ").trim();
const text = (node, path) => { const found = path ? first(node, path) : node; return found && !found.kids.length ? clean(found.text) || null : null; };
const number = (node, path) => { const value = text(node, path); return value !== null && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null; };
const checked = (node, path) => { const value = text(node, path); return value === null ? null : /^(x|true|1)$/i.test(value); };
// A name written across two lines of the form.
const business = (node) => (node ? [text(node, "BusinessNameLine1Txt"), text(node, "BusinessNameLine2Txt")].filter(Boolean).join(" ") || null : null);
const address = (node) => {
  const us = first(node, "USAddress") || first(node, "RecipientUSAddress") || first(node, "AddressUS");
  const foreign = first(node, "ForeignAddress") || first(node, "RecipientForeignAddress");
  if (us) return { line1: text(us, "AddressLine1Txt"), line2: text(us, "AddressLine2Txt"), city: text(us, "CityNm"), state: text(us, "StateAbbreviationCd"), zip: text(us, "ZIPCd"), country: "US" };
  if (foreign) return { line1: text(foreign, "AddressLine1Txt"), line2: text(foreign, "AddressLine2Txt"), city: text(foreign, "CityNm"), state: text(foreign, "ProvinceOrStateNm"), zip: text(foreign, "ForeignPostalCd"), country: text(foreign, "CountryCd") };
  return null;
};
const website = (value) => {
  if (!value || /^(n\/?a|none|no|na|0)$/i.test(value) || !/[a-z0-9-]\.[a-z]{2,}/i.test(value)) return null;
  // The IRS drops the slashes ("https:www.example.org"), so the address is kept without "https://".
  return value.toLowerCase().replace(/\s+/g, "").replace(/^https?:\/*/, "").replace(/\/$/, "");
};
// Empty answers people type into a box: "N/A", "NONE", "SEE STATEMENT".
const answer = (value) => (value && !/^(n\/?a|none\.?|na|not applicable|-+|0)$/i.test(value) ? value : null);

// ---------------------------------------------------------------- what counts as a scholarship
export const SCHOLARSHIP = /\b(scholarships?|scholars?|tuition|fellowships?|college (costs?|expenses?|education|students?)|educational? (grants?|awards?|assistance|loans?|aid|expenses)|student (aid|loans?|grants?|assistance|awards?)|grants? to students|higher education|post[- ]?secondary|graduating seniors?|financial aid|book awards?)\b/i;
// A recipient that is plainly an organization, so its name is not a private person's.
const ORGANIZATION = /\b(university|universit|college|school|academy|institute|seminary|district|foundation|fund|trust|inc|llc|corp|corporation|company|co|association|assn|society|church|parish|diocese|ministr|temple|synagogue|hospital|clinic|medical center|center|centre|library|museum|council|club|league|scouts?|ymca|ywca|rotary|kiwanis|lions|county|city of|town of|state of|department|dept|board|community|charit|united way|red cross|habitat|program|project|services?|alliance|coalition|network|partners|group|bank|agency|authority|conservancy|hospice|shelter|pantry|ministries|chapter|of america|international|national)\b/i;

export const isOrganization = (name, status) => Boolean(name) && (ORGANIZATION.test(name) || /\b(pc|pf|pof|gov|so|npo|501|public|charity)\b/i.test(status || ""));

// ---------------------------------------------------------------- the two forms
function header(root) {
  const head = first(root, "Return/ReturnHeader");
  const filer = first(head, "Filer");
  return {
    ein: text(filer, "EIN"),
    name: business(first(filer, "BusinessName")),
    form: text(head, "ReturnTypeCd"),
    taxYear: number(head, "TaxYr"),
    periodBegin: text(head, "TaxPeriodBeginDt"),
    periodEnd: text(head, "TaxPeriodEndDt"),
    filedAt: text(head, "ReturnTs"),
    address: address(filer),
    phone: text(filer, "PhoneNum"),
  };
}

const ROW_LIMIT = 400;

// Totals over a list of grants, and the rows themselves (capped) with private names removed.
function summarizeGrants(nodes) {
  const purposes = new Map();
  const totals = { count: 0, amount: 0, toPeople: { count: 0, amount: 0 }, scholarships: { count: 0, amount: 0 }, scholarshipsToPeople: { count: 0, amount: 0 } };
  const rows = [];
  for (const node of nodes) {
    const personName = text(node, "RecipientPersonNm");
    const businessName = business(first(node, "RecipientBusinessName"));
    const status = text(node, "RecipientFoundationStatusTxt");
    const purpose = text(node, "GrantOrContributionPurposeTxt");
    const amount = number(node, "Amt") ?? 0;
    const organization = Boolean(businessName) || isOrganization(personName, status);
    const scholarship = SCHOLARSHIP.test(purpose || "");
    totals.count += 1; totals.amount += amount;
    const add = (bucket) => { bucket.count += 1; bucket.amount += amount; };
    if (!organization) add(totals.toPeople);
    if (scholarship) add(totals.scholarships);
    if (scholarship && !organization) add(totals.scholarshipsToPeople);
    const key = (purpose || "").toLowerCase().slice(0, 120);
    const seen = purposes.get(key) || { purpose, count: 0, amount: 0 };
    seen.count += 1; seen.amount += amount; purposes.set(key, seen);
    if (rows.length < ROW_LIMIT) {
      const place = address(node);
      rows.push({ recipient: organization ? businessName || personName : null, recipientIsPerson: !organization, city: organization ? place?.city ?? null : null, state: place?.state ?? null, status, relationship: answer(text(node, "RecipientRelationshipTxt")), purpose, amount });
    }
  }
  return { ...totals, purposes: [...purposes.values()].sort((a, b) => b.count - a.count).slice(0, 40), rows, rowsCut: nodes.length > rows.length };
}

function privateFoundation(root, record) {
  const form = first(root, "Return/ReturnData/IRS990PF");
  const extra = first(form, "SupplementaryInformationGrp");
  const revenue = first(form, "AnalysisOfRevenueAndExpenses");
  record.website = website(text(form, "StatementsRegardingActyGrp/WebsiteAddressTxt"));
  record.money = {
    assets: number(form, "FMVAssetsEOYAmt"),
    revenue: number(revenue, "TotalRevAndExpnssAmt"),
    contributionsReceived: number(revenue, "ContriRcvdRevAndExpnssAmt"),
    expenses: number(revenue, "TotalExpensesRevAndExpnssAmt"),
    grantsPaid: number(revenue, "ContriPaidRevAndExpnssAmt") ?? number(extra, "TotalGrantOrContriPdDurYrAmt"),
    grantsApprovedForFuture: number(extra, "TotalGrantOrContriApprvFutAmt"),
  };
  // Part VIII-A: up to four direct charitable activities, each with its cost.
  const activities = first(form, "SummaryOfDirectChrtblActyGrp");
  record.programs = [1, 2, 3, 4].map((index) => ({ description: answer(text(activities, `Description${index}Txt`)), expenses: number(activities, `Expenses${index}Amt`) })).filter((item) => item.description);
  // Part XIV line 2: how to apply. A foundation can list more than one contact.
  record.application = {
    preselectedOnly: checked(extra, "OnlyContriToPreselectedInd") === true,
    entries: all(extra, "ApplicationSubmissionInfoGrp").map((node) => ({
      contact: text(node, "RecipientPersonNm") || business(first(node, "RecipientBusinessName")),
      address: address(node),
      phone: text(node, "RecipientPhoneNum"),
      email: text(node, "RecipientEmailAddressTxt"),
      materials: answer(text(node, "FormAndInfoAndMaterialsTxt")),
      deadlines: answer(text(node, "SubmissionDeadlinesTxt")),
      restrictions: answer(text(node, "RestrictionsOnAwardsTxt")),
    })),
  };
  record.grants = summarizeGrants(all(extra, "GrantOrContributionPdDurYrGrp"));
  record.futureGrants = summarizeGrants(all(extra, "GrantOrContriApprvForFutGrp"));
  record.people = { officers: all(form, "OfficerDirTrstKeyEmplInfoGrp/OfficerDirTrstKeyEmplGrp").length };
  // Free-text attachments ("General Explanation Attachment" and similar).
  const data = first(root, "Return/ReturnData");
  record.notes = data.kids.filter((kid) => /Explanation|Statement/i.test(kid.tag)).flatMap((kid) => all(kid, "ExplanationTxt").concat(all(kid, "ShortExplanationTxt"), all(kid, "MediumExplanationTxt"))).map((node) => text(node)).filter(Boolean).map((note) => note.slice(0, 4000)).slice(0, 12);
}

function publicCharity(root, record) {
  const form = first(root, "Return/ReturnData/IRS990");
  const schedule = first(root, "Return/ReturnData/IRS990ScheduleI");
  record.website = website(text(form, "WebsiteAddressTxt"));
  record.formationYear = number(form, "FormationYr");
  record.domicileState = text(form, "LegalDomicileStateCd");
  record.mission = text(form, "MissionDesc") || text(form, "ActivityOrMissionDesc");
  record.isSchool = checked(form, "SchoolOperatingInd") === true;
  record.money = {
    assets: number(form, "TotalAssetsEOYAmt"),
    grossReceipts: number(form, "GrossReceiptsAmt"),
    revenue: number(form, "CYTotalRevenueAmt"),
    contributionsReceived: number(form, "CYContributionsGrantsAmt"),
    expenses: number(form, "CYTotalExpensesAmt"),
    programExpenses: number(form, "TotalProgramServiceExpensesAmt"),
    grantsPaid: number(form, "CYGrantsAndSimilarPaidAmt"),
    grantsToPeople: number(form, "GrantsToDomesticIndividualsGrp/TotalAmt"),
  };
  record.people = { employees: number(form, "TotalEmployeeCnt"), volunteers: number(form, "TotalVolunteersCnt") };
  // Part III: the main program (its fields sit directly on the form) and the ones after it.
  const program = (node) => ({ description: text(node, "Desc"), expenses: number(node, "ExpenseAmt"), grants: number(node, "GrantAmt"), revenue: number(node, "RevenueAmt") });
  record.programs = [program(form), ...["ProgSrvcAccomActy2Grp", "ProgSrvcAccomActy3Grp"].map((tag) => first(form, tag)).filter(Boolean).map((node) => program(node)), ...all(form, "ProgSrvcAccomActyOtherGrp").map((node) => program(node))].filter((item) => item.description).map((item) => ({ ...item, description: item.description.slice(0, 3000) }));
  // Schedule I Part III: grants to people, by type, with how many people got one.
  record.grantsToPeople = all(schedule, "GrantsOtherAsstToIndivInUSGrp").map((node) => ({ type: text(node, "GrantTypeTxt"), recipients: number(node, "RecipientCnt"), cash: number(node, "CashGrantAmt"), nonCash: number(node, "NonCashAssistanceAmt"), nonCashDescription: answer(text(node, "NonCashAssistanceDesc")) }));
  record.grantsToOrganizations = { count: all(schedule, "RecipientTable").length };
  record.notes = all(schedule, "SupplementalInformationDetail").map((node) => [text(node, "FormAndLineReferenceDesc"), text(node, "ExplanationTxt")].filter(Boolean).join(" ")).filter(Boolean).map((note) => note.slice(0, 4000)).slice(0, 12);
}

// Why this filer is (or is not) kept in full. Each reason names where the word was found.
export function scholarshipReasons(record) {
  const reasons = [];
  const has = (value) => SCHOLARSHIP.test(value || "");
  if (has(record.name)) reasons.push("name");
  if (record.form === "990PF") {
    if (record.application.entries.some((entry) => has(entry.restrictions) || has(entry.materials) || has(entry.deadlines))) reasons.push("application");
    if (record.grants.scholarships.count) reasons.push("grant-purposes");
    if (record.futureGrants.scholarships.count) reasons.push("future-grant-purposes");
    if (record.programs.some((item) => has(item.description))) reasons.push("activities");
    if (record.notes.some(has)) reasons.push("notes");
  } else {
    if (record.grantsToPeople.some((row) => has(row.type))) reasons.push("grants-to-people");
    // A grant type that says nothing ("Grants", "Assistance") is explained by the mission instead.
    const vague = (row) => !row.type || /^(grants?|awards?|assistance|aid|cash|individuals?|various|program|see|direct|support|general|other)\b/i.test(row.type);
    if (record.grantsToPeople.some(vague) && (has(record.mission) || record.programs.some((item) => has(item.description)) || record.notes.some(has))) reasons.push("programs");
  }
  return reasons;
}

// Returns null for a form we do not read (990-EZ, 990-T), otherwise
// { record, light, keep } where `light` is a one-line summary kept for every filer.
export function readFiling(xml, objectId) {
  const type = xml.match(/<ReturnTypeCd>([^<]+)</)?.[1];
  if (type !== "990PF" && type !== "990") return null;
  const root = parseXml(xml);
  const record = { key: objectId, ...header(root) };
  if (!record.ein || !record.name) return null;
  if (type === "990PF") privateFoundation(root, record); else publicCharity(root, record);
  record.scholarshipReasons = scholarshipReasons(record);
  const givesToPeople = type === "990PF" ? record.grants.toPeople.count > 0 : record.grantsToPeople.length > 0;
  const light = { key: objectId, ein: record.ein, name: record.name, form: type, taxYear: record.taxYear, periodEnd: record.periodEnd, state: record.address?.state ?? null, city: record.address?.city ?? null, website: record.website, assets: record.money.assets, grantsPaid: record.money.grantsPaid, givesToPeople, preselectedOnly: type === "990PF" ? record.application.preselectedOnly : null, scholarshipReasons: record.scholarshipReasons };
  return { record, light, keep: record.scholarshipReasons.length > 0 };
}
