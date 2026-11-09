# SPEC: Bedrock Labs auth + Cue Board collab paywall (MVP)

Status: draft for Rami's approval. Decided in a grill session, 2026-11-08.
Replaces PR rsuriano/cue-board#19 (kept on hold for comparison: time, lines, review passes).

## Product rules
- Only **creating a collaboration room** needs an account. Solo use and joining a room by link stay free forever.
- **Paying = creating the account** (Nomad List style). No signup form, no passwords. Account = email.
- Price: $9 one-time, sold through Lemon Squeezy (store "Bedrock Labs"), with **license keys enabled** on the product.
- No device limit. Sessions last 1 year.

## Pieces

### 1. `auth.bedrocklabs.dev` (new, small, product-agnostic service)
- Config file: one entry per product `{ id, name, lsProductId, appUrl }`. Adding a product = adding a line.
- `POST /login {email, product}` → looks up the buyer's orders in the Lemon Squeezy API by email; if they own the
  product, emails a magic link (`appUrl/?key=<one-hour ticket>`; changed from the license key after the PR #20
  review: the key never expires, so it stays out of emails and URLs) via Resend. **Always** the same response
  ("if there's a purchase with that email, we sent a link"). Rate-limited per email and per IP.
  A Lemon Squeezy outage does not count against the user's rate limit.
- `POST /session {key, product}` → validates the license key with the LS License API (validate, never activate),
  **checks the key belongs to that product**, upserts the user, returns a signed session (1 year).
- `POST /redeem {email, code, product}` → invite code path: checks the code (exists, not revoked, under maxUsers),
  emails a magic link that opens a session the same way. Codes are 96-bit random, stored hashed (move the
  existing logic from `packages/sync-server/src/access.mjs`). CLI: create / list / revoke. Revoking a code cuts
  access for everyone who used it.
- Revalidation: a session is re-checked against Lemon Squeezy (or the code's status) at most once a day; a refund
  or revoked code ends access within 24h.
- Users table (SQLite, one file): `email, product, source ('purchase' | 'invite:<label>'), created, last_login`.

### 2. Cue Board app
- Small "Log in" link (email → magic link), independent of the paywall. "Log out" when logged in.
- On "create room": logged in → create directly. Logged out → one modal: "Live collab, $9 once" [Buy],
  "Already have an account? Log in", "Have a code?" (email + code).
- Back from checkout: the receipt button returns to `appUrl/?key=…`; the app opens a session and drops the key
  from the URL (`history.replaceState`).

### 3. Sync server
- `canCreateRoom` accepts a valid session from auth (verified locally with auth's public key, no network call).
- Old code/verified-token logic removed from the sync server (it lives in auth now). Existing rooms, owner links
  and invite links keep working untouched.

## Out of scope (do NOT build)
Webhooks · our own payment handling · passwords · device/activation limits · admin dashboard · migrating old
redeemed tokens (users re-enter their code with their email) · partial refunds · tiers/subscriptions ·
email templates beyond one plain magic-link email.

## Approval criteria (each one = a test written first; all green = mergeable)
1. Valid purchase key for Cue Board → session; key for another product → rejected.
2. Refunded/disabled key → rejected at session creation and at the daily revalidation.
3. `/login` returns the identical response for buyer and non-buyer emails.
4. Rate limit trips on repeated misses; LS API failures do not count as misses.
5. Invite code + email → session; revoked code → its users lose access; maxUsers enforced.
6. Sync server: no session → cannot create a room; valid session → can; joining needs no session.
7. Existing rooms + owner/invite links still work after the change (test against a copy of real data).
8. Users table gets a row on first session and updates `last_login` after that.
9. Smoke: auth and sync server both start from their real entrypoints and answer `/health`.

## Limits and gate
- **Size cap: 700 lines of production code, hard** (tests excluded). Going over = stop and report, don't push on.
- Merge when: criteria 1-9 green + full existing suites green + under the cap.
- At most **one** review, and only blocking security issues count (HIGH). Everything else → backlog note.

## Setup Rami does (one time)
- Resend account + 3 DNS records for bedrocklabs.dev.
- Lemon Squeezy: $9 product with license keys on; receipt button link `https://cue.bedrocklabs.dev/?key=[license_key]`;
  an API key (handed over through a file on the server, not chat).

## Deploy
Back up `/opt/cue-sync/data` first. Deploy auth, then sync server, then the app pages.
