#!/usr/bin/env node
/**
 * Recover the current email OTP for a demo account on a Convex app that uses
 * `@convex-dev/auth`.
 *
 * Demo accounts are registered at throwaway addresses nobody can open, so the
 * emailed code has to come from the deployment instead. `@convex-dev/auth`
 * stores it as `sha256(code)` hex — irreversible in principle, but the code is
 * six digits, so the search space is a million candidates and inverting it
 * locally takes about a second.
 *
 * Read-only against the deployment. Intended for demo/QA accounts on an app you
 * own — not a way around anyone else's login.
 *
 *   node scripts/convex-otp.mjs --dir ~/code/clients/acme --email john@example.com [--prod]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "../src/util.mjs";

const args = parseArgs(process.argv.slice(2));
const dir = args.dir ?? process.cwd();
const email = args.email;
const deployFlag = args.prod === false ? [] : ["--prod"];

if (!email) {
  console.error("usage: convex-otp.mjs --dir <convex project> --email <address> [--prod]");
  process.exit(2);
}

function convexData(table, limit = 200) {
  const r = spawnSync(
    "npx",
    ["convex", "data", table, "--format", "jsonArray", "--limit", String(limit), "--order", "desc", ...deployFlag],
    { cwd: dir, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 },
  );
  if (r.status !== 0) {
    console.error(`convex data ${table} failed:\n${r.stderr}`);
    process.exit(1);
  }
  // The CLI prints warnings on stdout before the JSON; take from the first bracket.
  const start = r.stdout.indexOf("[");
  if (start === -1) return [];
  try {
    return JSON.parse(r.stdout.slice(start));
  } catch (e) {
    console.error(`could not parse ${table} output: ${e.message}`);
    process.exit(1);
  }
}

const accounts = convexData("authAccounts", 500);
const account = accounts.find(
  (a) => String(a.providerAccountId ?? "").toLowerCase() === email.toLowerCase(),
);
if (!account) {
  console.error(`no auth account for ${email} — has the sign-up form been submitted yet?`);
  process.exit(1);
}

const codes = convexData("authVerificationCodes", 200);
const row = codes
  .filter((c) => c.accountId === account._id)
  .sort((a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0))[0];

if (!row) {
  console.error(`no pending verification code for ${email} — it may have been used or expired`);
  process.exit(1);
}

if (row.expirationTime && row.expirationTime < Date.now()) {
  console.error(`the code for ${email} expired — trigger a resend, then run this again`);
  process.exit(1);
}

const target = String(row.code).toLowerCase();
for (let i = 0; i < 1_000_000; i++) {
  const candidate = String(i).padStart(6, "0");
  if (createHash("sha256").update(candidate).digest("hex") === target) {
    process.stdout.write(candidate + "\n");
    process.exit(0);
  }
}

console.error("could not invert the stored hash — the code may not be a six-digit numeric token");
process.exit(1);
