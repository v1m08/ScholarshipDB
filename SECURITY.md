# Security policy

## Supported version

Security fixes target the current `main` branch.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, or private data. Use GitHub Private Vulnerability Reporting from the repository's Security tab. If that feature is unavailable, contact the repository owner through GitHub and request a private channel before sharing details.

Include the affected route or file, reproduction steps, impact, and any suggested mitigation. Please allow reasonable time for confirmation and remediation before public disclosure.

## Project boundaries

The public application is intentionally read-only, has no accounts, and stores bookmarks only in browser memory. Supabase Row Level Security and explicit grants are still part of the security boundary; reports about bypasses, exposed privileged keys, injection, dependency vulnerabilities, or unintended data mutation are in scope.