"use client";

import { useState } from "react";
import { CANONICAL_GRADES } from "@/lib/facets";

const DEGREE_LEVELS = [
  "Professional Certification", "1-year Certificate", "Associate Degree",
  "Bachelor's Degree", "Graduate Degree", "Doctoral Degree",
] as const;

const CITIZENSHIP_OPTIONS = [
  "No citizenship requirement", "U.S. citizen", "U.S. permanent resident",
  "U.S. resident (citizenship not required)", "DACA recipient",
  "International student eligible", "Other / not sure",
] as const;

const REQUIREMENT_FIELDS = [
  ["essay_required", "Essay required"],
  ["recommendations_required", "Recommendations required"],
  ["need_based", "Need-based"],
  ["merit_based", "Merit-based"],
  ["fee_required", "Application fee required"],
] as const;

async function submitContribution(body: Record<string, unknown>): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("Supabase is not configured.");

  const response = await fetch(url + "/rest/v1/scholarship_contributions", {
    body: JSON.stringify(body),
    cache: "no-store",
    headers: {
      apikey: publishableKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    method: "POST",
  });
  if (!response.ok) throw new Error("Contribution submission failed.");
}

export function ContributionForm() {
  const [anonymous, setAnonymous] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) || "").replace(/\s+/g, " ").trim() || null;
    const yesNo = (name: string) => text(name) === "yes" ? true : text(name) === "no" ? false : null;
    const awardAmount = text("award_amount");
    const minimumGpa = text("minimum_gpa");
    const maximumIncome = text("maximum_income");
    const contribution = {
      scholarship_title: text("scholarship_title"),
      provider: text("provider"),
      contributor_name: anonymous ? null : text("contributor_name"),
      relationship: text("relationship") || "winner",
      deadline: text("deadline"),
      award_amount: awardAmount === null ? null : Number(awardAmount),
      minimum_gpa: minimumGpa === null ? null : Number(minimumGpa),
      maximum_income: maximumIncome === null ? null : Number(maximumIncome),
      location: text("location"),
      grade: text("grade"),
      degree_level: text("degree_level"),
      field_of_study: text("field_of_study"),
      citizenship: text("citizenship"),
      essay_required: yesNo("essay_required"),
      recommendations_required: yesNo("recommendations_required"),
      need_based: yesNo("need_based"),
      merit_based: yesNo("merit_based"),
      fee_required: yesNo("fee_required"),
      application_requirements: text("application_requirements"),
      application_url: text("application_url"),
      source_name: text("source_name"),
      source_url: text("source_url"),
      notes: text("notes"),
    };
    if (!contribution.scholarship_title || !contribution.provider || !contribution.location || !contribution.grade || !contribution.citizenship || !contribution.source_name) {
      setError("Please complete every required field.");
      return;
    }
    if (!anonymous && !contribution.contributor_name) {
      setError("Please enter your name or choose to remain anonymous.");
      return;
    }
    if (!contribution.application_url && !contribution.source_url) {
      setError("Please provide an application link or source link.");
      return;
    }
    if (
      (contribution.award_amount !== null && !Number.isFinite(contribution.award_amount)) ||
      (contribution.minimum_gpa !== null && !Number.isFinite(contribution.minimum_gpa)) ||
      (contribution.maximum_income !== null && !Number.isFinite(contribution.maximum_income))
    ) {
      setError("Please enter valid numbers for award and GPA.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await submitContribution(contribution);
      form.reset();
      setAnonymous(true);
      setSubmitted(true);
    } catch {
      setError("We could not send your contribution. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="contribution-success" role="status">
        <h2>Thank you for contributing.</h2>
        <p>Your submission is pending review and has not changed the public scholarship listing.</p>
        <button onClick={() => setSubmitted(false)} type="button">Submit another</button>
      </div>
    );
  }

  return (
    <form className="contribution-form" onSubmit={handleSubmit}>
      <section className="contribution-section">
        <h2>Scholarship</h2>
        <p>Identify the scholarship and your connection to it.</p>
        <div className="contribution-fields">
          <label>
            <span>Scholarship name *</span>
            <input maxLength={200} name="scholarship_title" required />
          </label>
          <label>
            <span>Provider *</span>
            <input maxLength={200} name="provider" required />
          </label>
          <label>
            <span>Your connection</span>
            <select defaultValue="winner" name="relationship">
              <option value="winner">I was/am a recipient</option>
              <option value="finalist">I was an applicant/finalist</option>
              <option value="other">I am a provider</option>
              <option value="other">Other</option>
            </select>
          </label>
        </div>
      </section>

      <section className="contribution-section">
        <h2>Deadline and award</h2>
        <p>Leave uncertain values blank.</p>
        <div className="contribution-fields">
          <label>
            <span>Deadline</span>
            <input name="deadline" type="date" />
          </label>
          <label>
            <span>Award amount</span>
            <input max={100000000} min={0} name="award_amount" placeholder="10000" step="0.01" type="number" />
          </label>
          <label>
            <span>Minimum GPA</span>
            <input max={5} min={0} name="minimum_gpa" placeholder="3.5" step="0.01" type="number" />
          </label>
        </div>
      </section>

      <section className="contribution-section">
        <h2>Eligibility</h2>
        <p>Use the closest matching option so the listing can be filtered correctly.</p>
        <div className="contribution-fields">
          <label>
            <span>Location *</span>
            <input maxLength={200} name="location" placeholder="United States, California, Cook County..." required />
          </label>
          <label>
            <span>Grade *</span>
            <select defaultValue="" name="grade" required>
              <option disabled value="">Select grade</option>
              {CANONICAL_GRADES.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
            </select>
          </label>
          <label>
            <span>Degree level</span>
            <select defaultValue="" name="degree_level">
              <option value="">Not sure / not applicable</option>
              {DEGREE_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
          <label>
            <span>Citizenship *</span>
            <select defaultValue="" name="citizenship" required>
              <option disabled value="">Select citizenship rule</option>
              {CITIZENSHIP_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label>
            <span>Field of study</span>
            <input maxLength={200} name="field_of_study" placeholder="All fields, nursing, engineering..." />
          </label>
          <label>
            <span>Maximum household income</span>
            <input max={100000000} min={0} name="maximum_income" placeholder="95000" step="0.01" type="number" />
          </label>
        </div>
      </section>

      <section className="contribution-section">
        <h2>Application requirements</h2>
        <p>Select “Not sure” instead of guessing.</p>
        <div className="contribution-fields">
          {REQUIREMENT_FIELDS.map(([name, label]) => (
            <label key={name}>
              <span>{label} *</span>
              <select defaultValue="" name={name} required>
                <option disabled value="">Select</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
                <option value="unknown">Not sure</option>
              </select>
            </label>
          ))}
          <label className="contribution-wide">
            <span>Other requirements</span>
            <textarea maxLength={2000} name="application_requirements" placeholder="Transcript, FAFSA, portfolio, interview, required documents..." />
          </label>
          <label className="contribution-wide">
            <span>Application link</span>
            <input maxLength={2048} name="application_url" placeholder="https://..." type="url" />
          </label>
          <label className="contribution-wide">
            <span>Other useful details</span>
            <textarea maxLength={2000} name="notes" placeholder="Tips or information future applicants should know" />
          </label>
        </div>
      </section>

      <section className="contribution-section">
        <h2>Source</h2>
        <p>Add an official page or identify your firsthand source. An application link or source link is required.</p>
        <div className="contribution-fields">
          <label>
            <span>Source name *</span>
            <input maxLength={200} name="source_name" placeholder="Provider website or personal experience" required />
          </label>
          <label>
            <span>Source link</span>
            <input maxLength={2048} name="source_url" placeholder="https://..." type="url" />
          </label>
        </div>
      </section>

      <section className="contribution-section">
        <h2>Attribution</h2>
        <label className="anonymous-choice">
          <input checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} type="checkbox" />
          <span>Remain anonymous</span>
        </label>
        {!anonymous && (
          <label className="contributor-name">
            <span>Your name</span>
            <input autoComplete="name" maxLength={100} name="contributor_name" required />
          </label>
        )}
      </section>

      <p className="contribution-note">Submissions are reviewed before any public scholarship record is changed.</p>
      <button className="contribution-submit" disabled={submitting} type="submit">
        {submitting ? "Sending..." : "Submit for review"}
      </button>
      {error && <p className="contribution-error" role="alert">{error}</p>}
    </form>
  );
}
