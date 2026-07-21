"use client";

import { useState } from "react";

export function ScholarshipReportButton({ scholarshipId }: { scholarshipId: string }) {
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [status, setStatus] = useState("");

  async function submit() {
    const value = issue.trim();
    if (value.length < 10) {
      setStatus("Please include a little more detail.");
      return;
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !publishableKey) {
      setStatus("Reports are unavailable right now.");
      return;
    }
    const response = await fetch(`${url}/rest/v1/scholarship_reports`, {
      method: "POST",
      headers: { apikey: publishableKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ scholarship_id: scholarshipId, issue: value }),
    });
    if (!response.ok) {
      setStatus("Could not send the report. Please try again.");
      return;
    }
    setIssue("");
    setStatus("Thanks — your report was sent.");
  }

  return <div className="report-control">
    <button className="secondary-button report-toggle" onClick={() => setOpen((value) => !value)} type="button">Report an issue</button>
    {open && <div className="scholarship-report-panel"><label htmlFor={`report-${scholarshipId}`}>What needs correction?</label><textarea id={`report-${scholarshipId}`} maxLength={1000} onChange={(event) => setIssue(event.target.value)} value={issue} /><button className="secondary-button" onClick={submit} type="button">Send report</button>{status && <p>{status}</p>}</div>}
  </div>;
}
