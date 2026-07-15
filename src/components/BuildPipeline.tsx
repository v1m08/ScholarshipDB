"use client";

import { useState } from "react";
import { Database, FileSearch, Layers3, ScanSearch, SearchCheck } from "lucide-react";

const steps = [
  {
    title: "Discover",
    short: "Find public scholarship pages.",
    detail: "Public directories and editorial source pages are scanned for scholarship detail links.",
    icon: ScanSearch,
  },
  {
    title: "Extract",
    short: "Read the published fields.",
    detail: "Titles, providers, deadlines, awards, eligibility rules, and source URLs are collected.",
    icon: FileSearch,
  },
  {
    title: "Normalize",
    short: "Create one shared format.",
    detail: "State names, tags, grade levels, award values, and dates are mapped into a consistent schema.",
    icon: Layers3,
  },
  {
    title: "Review",
    short: "Flag gaps and likely duplicates.",
    detail: "Records are enriched, grouped, and marked with review status while retaining their original sources.",
    icon: SearchCheck,
  },
  {
    title: "Publish",
    short: "Build the searchable index.",
    detail: "The normalized catalog is divided into fast search pages and source-linked scholarship records.",
    icon: Database,
  },
];

export function BuildPipeline() {
  const [activeStep, setActiveStep] = useState(0);

  return (
    <div className="build-pipeline">
      <div className="pipeline-track" aria-label="Scholarship indexing process">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <button
              aria-describedby="pipeline-detail"
              className={activeStep === index ? "pipeline-step active" : "pipeline-step"}
              key={step.title}
              onFocus={() => setActiveStep(index)}
              onMouseEnter={() => setActiveStep(index)}
              type="button"
            >
              <span className="pipeline-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="pipeline-icon"><Icon aria-hidden="true" size={22} /></span>
              <strong>{step.title}</strong>
              <small>{step.short}</small>
              <span className="pipeline-mobile-detail">{step.detail}</span>
            </button>
          );
        })}
      </div>
      <div className="pipeline-detail" id="pipeline-detail" aria-live="polite">
        <span>Step {activeStep + 1}</span>
        <strong>{steps[activeStep].title}</strong>
        <p>{steps[activeStep].detail}</p>
      </div>
    </div>
  );
}
