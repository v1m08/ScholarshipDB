import type { Metadata } from "next";
import { ContributionForm } from "@/components/ContributionForm";

export const metadata: Metadata = {
  title: "Contribute scholarship information",
  description: "Share firsthand scholarship details and sources for maintainer review.",
};

export default function ContributePage() {
  return (
    <main className="contribute-page">
      <header className="contribute-intro">
        <p className="eyebrow">Contribute</p>
        <h1>Help Improve Scholarship Info</h1>
        <p>
          If you have firsthand knowledge of any scholarship, whether you're a recipient, provider, or applicant, we would love your help.
          Your responses to this form will be reviewed and your contribution will directly improve scholarship information for others.
        </p>
      </header>
      <ContributionForm />
    </main>
  );
}
