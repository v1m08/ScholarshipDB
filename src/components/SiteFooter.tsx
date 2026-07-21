import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-message">
          <Link className="footer-brand" href="/">OpenScholar Index</Link>
          <p>
            A source-linked scholarship directory built to make discovery and comparison easier.
            Confirm every opportunity on the original provider page before applying.
          </p>
        </div>
        <nav className="footer-navigation" aria-label="Footer navigation">
          <Link href="/">Home</Link>
          <Link href="/scholarships">Scholarships</Link>
          <Link href="/scholarships/for/international-students">International students</Link>
        </nav>
      </div>
    </footer>
  );
}
