import { readFileSync } from "node:fs";

for (const filename of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(filename, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}

const required = [
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];

const strict = process.argv.includes("--strict") || process.env.NODE_ENV === "production";
const missing = required.filter((name) => !process.env[name]);
if (strict && missing.length) {
  throw new Error(`Missing production environment variables: ${missing.join(", ")}`);
}
if (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Do not deploy with a Supabase secret/service-role key; the public app only needs the publishable key.");
}
console.log(missing.length ? `Production check skipped missing optional env in dev: ${missing.join(", ")}` : "Production check passed.");
