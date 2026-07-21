export interface SeoCategory {
  slug: string[];
  title: string;
  description: string;
  intro: string;
  secondaryTags?: string[];
  degreeLevels?: string[];
  faq: Array<{ question: string; answer: string }>;
}

export const internationalCategories: SeoCategory[] = [
  {
    slug: ["international-students"],
    title: "Scholarships for International Students",
    description: "Find source-linked scholarships for international students studying in the United States.",
    intro: "This directory collects scholarships whose published eligibility explicitly includes international, non-U.S., or F-1 students studying in the United States. Confirm current rules on each provider page before applying.",
    faq: [
      { question: "Can international students get scholarships in the United States?", answer: "Yes. Some U.S. scholarships explicitly accept international or non-U.S. applicants, although eligibility and award amounts differ by provider." },
      { question: "Do international students need FAFSA to apply?", answer: "Not always. Many private scholarships do not use FAFSA, but each provider sets its own requirements." },
    ],
  },
  { slug: ["international-students", "no-essay"], title: "No-Essay Scholarships for International Students", description: "Browse no-essay scholarships for international students studying in the United States.", intro: "These listings combine international-student eligibility with scholarships marked no essay in the published record. Confirm the provider’s current rules before applying.", secondaryTags: ["no-essay"], faq: [{ question: "Are no-essay scholarships easier to win?", answer: "They may be faster to apply for, but often attract more applicants." }] },
  { slug: ["international-students", "graduate"], title: "Graduate Scholarships for International Students", description: "Find graduate scholarships for international students studying in the United States.", intro: "This page highlights international-student scholarships that list graduate study among their eligible degree levels. Verify program and immigration requirements with each provider.", degreeLevels: ["graduate"], faq: [{ question: "Can international graduate students get U.S. scholarships?", answer: "Yes, where the provider explicitly allows international applicants." }] },
  { slug: ["international-students", "women"], title: "Scholarships for International Women Students", description: "Explore scholarships for international women students studying in the United States.", intro: "These opportunities pair explicit international-student eligibility with awards intended for women students. Read each source carefully for additional requirements.", secondaryTags: ["women"], faq: [{ question: "Are these scholarships open to all international women students?", answer: "Not necessarily. Each provider sets its own citizenship, enrollment, and academic requirements." }] },
  { slug: ["international-students", "stem"], title: "STEM Scholarships for International Students", description: "Find STEM scholarships for international students studying in the United States.", intro: "This collection focuses on scholarships tagged for both international students and STEM fields. Confirm that your major and student status meet the provider’s rules.", secondaryTags: ["stem"], faq: [{ question: "What counts as STEM for a scholarship?", answer: "Definitions vary by provider. Check the original listing for accepted majors and programs." }] },
];

export function getInternationalCategory(slug: string[]) { return internationalCategories.find((category) => category.slug.join("/") === slug.join("/")); }
export function categoryHref(category: SeoCategory) { return `/scholarships/for/${category.slug.join("/")}`; }
