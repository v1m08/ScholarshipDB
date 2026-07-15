"use client";

import Link from "next/link";
import { useState } from "react";

export function AnnotatedCardGuide() {
  const [activeAnnotation, setActiveAnnotation] = useState<string | null>(null);
  const annotationEvents = (name: string) => ({
    onBlur: () => setActiveAnnotation(null),
    onFocus: () => setActiveAnnotation(name),
    onMouseEnter: () => setActiveAnnotation(name),
    onMouseLeave: () => setActiveAnnotation(null),
  });

  return (
    <section className="intro-page homepage-card-guide" aria-labelledby="card-guide-title">
      <div className="guide-heading">
        <p className="eyebrow" id="card-guide-title">Scholarship Card Guide</p>
      </div>
      <div className={`card-tour${activeAnnotation ? ` annotation-active-${activeAnnotation}` : ""}`} aria-label="Annotated scholarship card">
        <div className="tour-card card open-card" aria-label="Example scholarship card">
          <span className="border-hover-target" aria-hidden="true" {...annotationEvents("border")} />
          <div className="card-top">
            <span className="vetting-ribbon human-vetted tour-target-vetting" {...annotationEvents("vetting")}>✓ Vetted</span>
            <strong className="award tour-target-award" {...annotationEvents("award")}>Varies</strong>
          </div>
          <h2>Sample Community Scholarship</h2>
          <p className="provider">Example Foundation</p>
          <p>A short summary tells you who the award is for and what the provider publishes.</p>
          <div className="facts tour-target-facts" {...annotationEvents("facts")}>
            <span>Deadline: Sep 15, 2026</span>
            <span>GPA: 3+</span>
            <span>Essay required</span>
          </div>
          <div className="tag-row tour-target-tags" {...annotationEvents("tags")}>
            <span className="tag">first generation</span>
            <span className="tag">STEM</span>
            <span className="institution-badge">Institution</span>
          </div>
        </div>

        <div className="card-annotation annotation-vetting" tabIndex={0} {...annotationEvents("vetting")}>
          <svg className="annotation-line" aria-hidden="true" viewBox="0 0 145 45"><path d="M0 12 H70 L92 25" /></svg>
          <strong>Vetting ribbon</strong><p>How the listing was reviewed.</p>
        </div>
        <div className="card-annotation annotation-award" tabIndex={0} {...annotationEvents("award")}>
          <svg className="annotation-line" aria-hidden="true" viewBox="0 0 145 45"><path d="M145 12 H105 L80 32" /></svg>
          <strong>Award</strong><p>The maximum known amount.</p>
        </div>
        <div className="card-annotation annotation-border" tabIndex={0} {...annotationEvents("border")}>
          <svg className="annotation-line" aria-hidden="true" viewBox="0 0 78 55"><path d="M0 12 H40 L61 45" /></svg>
          <strong>Deadline border</strong><p>Green is active. Red is closed.</p>
        </div>
        <div className="card-annotation annotation-facts" tabIndex={0} {...annotationEvents("facts")}>
          <svg className="annotation-line" aria-hidden="true" viewBox="0 0 320 48"><path d="M320 18 H274 L210 28" /></svg>
          <strong>Quick facts</strong><p>Deadline and key eligibility details.</p>
        </div>
        <div className="card-annotation annotation-tags" tabIndex={0} {...annotationEvents("tags")}>
          <svg className="annotation-line" aria-hidden="true" viewBox="0 0 420 58"><path d="M420 18 H380 L350 38" /></svg>
          <strong>Tags</strong><p>Relevant groups, fields, and institutions.</p>
        </div>
      </div>

      <div className="intro-key">
        <Link className="button" href="/scholarships">Browse the directory</Link>
      </div>
    </section>
  );
}
