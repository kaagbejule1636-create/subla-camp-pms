# Subla Camp PMS (Reservations, Check-In/Out, Housekeeping, Invoicing, Night Audit, Rate Plans, Reports, Auth)

_A full property-management backend for a small hotel/guesthouse, modeled on eZee FrontDesk's feature set._

Backend for the check-in flow sketched earlier. Node/Express + PostgreSQL, matching the Subla Tea stack pattern (deployable to Render the same way).

## Setup

```bash
npm install
# set DATABASE_URL to your Render Postgres connection string
# set JWT_SECRET to a long random string (required in production — see middleware/auth.js)
npm run migrate   # creates all tables from db/schema.sql
npm run seed      # seeds room_types + rooms — edit db/seed.js first to match your actual inventory
npm start
```

**WhatsApp invoice delivery** (optional) reuses the Twilio setup already running for Subla Tea's stock alerts. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, and `BASE_URL` (your deployed API URL, so the invoice link resolves) to enable it. Set `OTA_ALERT_PHONE` too if you want a WhatsApp ping whenever a new OTA booking arrives (in addition to the always-on internal message — see the OTA section below).

**First login:** there's no public signup — someone has to exist in `users` before anyone can log in. Insert the first manager account directly via `psql` (hash a password with bcrypt first, e.g. `node -e "console.log(require('bcryptjs').hashSync('yourpassword', 10))"`), then use that account's token to create everyone else through `POST /api/auth/users`.

## Auth

Every endpoint except `POST /api/auth/login` requires a `Authorization: Bearer <token>` header. Get a token by logging in:

```bash
curl -X POST /api/auth/login -d '{"username":"kazeem","password":"..."}' -H 'Content-Type: application/json'
```

Three roles, matching the eZee permission model: **receptionist** (reservations, check-in/out, post charges — the default for any authenticated user), **supervisor** (+ modify rate plans, close the night audit), **manager** (+ reports, user management). Role checks are hierarchical — a manager can do everything a supervisor or receptionist can.

| Auth action | Endpoint |
|---|---|
| Log in | `POST /api/auth/login` |
| Confirm current identity | `GET /api/auth/me` |
| Create a staff account (manager only) | `POST /api/auth/users` |
| List staff (manager only) | `GET /api/auth/users` |
| Change role / deactivate (manager only) | `PATCH /api/auth/users/:id` |

## How the routes map to the check-in screens

| Screen step        | Endpoint(s) |
|---------------------|-------------|
| Search reservation  | `GET /api/reservations/search?q=` |
| Create reservation / walk-in | `POST /api/reservations` |
| Assign Room         | `GET /api/rooms/available?room_type_id=&check_in=&check_out=` then `PATCH /api/reservations/:id/assign-room` |
| Deposit / Payment    | `GET /api/checkin/:reservationId/folio` then `POST /api/checkin/:reservationId/payment` |
| Confirm Check-In     | `POST /api/checkin/:reservationId/confirm` — flips reservation → `checked_in` and room → `occupied` in one transaction, and posts the room charge to the folio |
| Front-desk dashboard | `GET /api/reservations/dashboard` |
| Housekeeping status  | `PATCH /api/rooms/:id/housekeeping` |
| Check-out: review folio | `GET /api/checkout/:reservationId/folio` |
| Check-out: add last-minute charge | `POST /api/checkout/:reservationId/charge` |
| Check-out: settle balance | `POST /api/checkout/:reservationId/settle` |
| Check-out: confirm | `POST /api/checkout/:reservationId/confirm` — flips reservation → `checked_out`, room → `vacant` + `dirty` |
| Print / view invoice | `GET /api/invoices/:reservationId` — streams a PDF built from folio data |
| Send invoice via WhatsApp | `POST /api/invoices/:reservationId/send-whatsapp` |
| Housekeeping: task board | `GET /api/housekeeping/tasks` |
| Housekeeping: create/assign task | `POST /api/housekeeping/tasks`, `PATCH /api/housekeeping/tasks/:id/assign` |
| Housekeeping: update task status | `PATCH /api/housekeeping/tasks/:id/status` — marking a `clean_room` task `done` auto-clears the room's dirty flag |
| Night audit: preview | `GET /api/night-audit/preview?date=` — today's revenue/occupancy summary and any reservations about to become no-shows |
| Night audit: close the day | `POST /api/night-audit/close` — marks unarrived reservations `no_show`, snapshots the summary, closes the business day (can't be re-run once closed) |
| Night audit: history | `GET /api/night-audit/history?limit=` — past closed days |
| Rate plans: list/create/update | `GET /api/rate-plans?room_type_id=`, `POST /api/rate-plans`, `PATCH /api/rate-plans/:id` |
| Rate plans: quote a stay | `GET /api/rate-plans/quote?room_type_id=&check_in=&check_out=` — resolves the applicable rate per night (highest-priority matching plan wins) and returns a per-night breakdown + total |
| Reports: occupancy | `GET /api/reports/occupancy?start=&end=` — daily occupancy % over a date range |
| Reports: revenue | `GET /api/reports/revenue?start=&end=` — revenue by type, plus a daily series for charting |
| Reports: cashier shift | `GET /api/reports/cashier-shift?recorded_by=&start=&end=` — every transaction an operator handled in a time window, broken down by payment method, for end-of-shift cash reconciliation |
| Issue electronic key | `POST /api/keycards/:reservationId/issue` — generates a key valid only for the assigned room and the actual stay dates |
| Revoke a key | `POST /api/keycards/:keyId/revoke` |
| Send booking confirmation | `POST /api/notifications/:reservationId/booking-confirmation` |
| Send payment receipt | `POST /api/notifications/:reservationId/payment-receipt/:transactionId` |
| Send custom guest message | `POST /api/notifications/:reservationId/custom` |
| Internal message (Reception → Housekeeping/Maintenance) | `POST /api/internal-messages`, `GET /api/internal-messages?to_dept=` |
| Issue a pay-out voucher | `POST /api/payouts` — posts to the guest's folio so it shows up on their bill and in cashier-shift reports |
| Manage currencies | `GET/POST /api/currencies` (supervisor+ to add/update rates) |
| Pay in a foreign currency | Pass `currency` (and the amount in that currency) to `POST /api/checkin/:id/payment` or `POST /api/checkout/:id/settle` — converted to AED automatically using the configured rate |
| Ingest an OTA booking | `POST /api/ota/bookings` (webhook, secured by `OTA_WEBHOOK_SECRET`, not staff auth) — idempotent per `(channel, external_booking_id)`; on success, alerts staff via an internal message + optional WhatsApp ping (see below) |
| OTA availability feed | `GET /api/ota/availability?room_type_id=&start=&end=` — what a channel manager would poll |
| OTA sync log | `POST/GET /api/ota/sync-log` |

## Modules 34–39 — design notes

- **Electronic keys** are modeled at the PMS level: a key's validity window always matches the reservation's actual check-in/check-out dates (adjust the 2pm/noon defaults in `keycards.js` to your property's policy), and it's tied to whichever room is currently assigned. Actually encoding a physical card or pushing to a mobile-key app is a separate, lock-hardware-specific integration — `key_code` is the credential your lock vendor's API would consume.
- **Guest notifications** and **invoice delivery** both go out over WhatsApp (reusing the Subla Tea Twilio setup) rather than email/SMS, and are explicit actions the front desk triggers — nothing sends automatically as a side effect of creating a reservation or posting a payment.
- **Pay-out vouchers** post to the guest's folio as a `pay_out` transaction. I initially missed wiring this new type into the balance-due calculations in `checkout.js` and `invoices.js` (they only summed `room_charge`/`extra_charge`) — caught and fixed that before shipping, so a pay-out now correctly shows up on the guest's bill. It's deliberately *excluded* from revenue reporting in `reports.js`, since it's cash disbursed on the guest's behalf, not money the property earned.
- **Multi-currency** stores every folio transaction in AED (`amount`) regardless of what the guest paid in, plus `currency`, `exchange_rate`, and `original_amount` for the audit trail. Add a currency and its rate via `POST /api/currencies` before anyone can pay in it — the payment/settle routes reject unknown currency codes with a clear error rather than guessing.
- **OTA/travel-agent distribution** is scoped to what a self-hosted PMS can reasonably own: an idempotent booking-ingestion webhook and an availability feed a channel manager could poll. It does *not* include an actual integration with any specific channel manager or OTA (Booking.com, Expedia, etc.) — that requires their specific API/webhook contract, which is a per-partner integration project of its own. The webhook uses a shared secret (`OTA_WEBHOOK_SECRET`) rather than staff auth, since external services can't hold a staff login.
- **New OTA bookings alert staff automatically** — a successful ingestion posts a high-priority internal message to reception (visible via `GET /api/internal-messages?to_dept=reception`) and, if `OTA_ALERT_PHONE` is set, sends a WhatsApp ping too. This was a real gap I initially left open — the booking was being saved silently with nothing telling anyone it had arrived — so it's now fixed rather than left as a "next phase" item. Both notification paths are best-effort: a Twilio hiccup logs an error but never rolls back or blocks the actual booking, since the channel manager only cares that its webhook was accepted. Duplicate webhook retries (same `channel` + `external_booking_id`) correctly do *not* re-notify.
- **Getting real bookings from Agoda/Booking.com/Airbnb/Trip.com flowing in requires a channel manager** (e.g. Channex, WebBookingPro, SiteMinder) as an intermediary — none of these OTAs connect directly to a small independent PMS. What's built here is the receiving/ingestion side that a channel manager would call; connecting a real one still needs (1) signing up with that service, (2) adapting the webhook payload to their specific format, and (3) likely adding push-based outbound sync (right now `/availability` is poll-only, which leaves a real double-booking window between polls) before going live with actual channels.

## Notes on design choices

- **Room availability** is computed by checking for date-overlapping reservations, not a static "is this room free" flag — this is what prevents double-booking.
- **Confirm Check-In** is wrapped in a DB transaction with row locks (`FOR UPDATE`) so two receptionists can't check the same room into two reservations at once.
- **Folio transactions** are append-only — nothing is edited or deleted, matching how the eZee doc describes folio/audit-trail behavior. Corrections should be posted as new `refund` or `discount` entries, not by editing history.
- **Do-Not-Rent** is checked at reservation creation, per the eZee blacklist feature.
- **Check-out blocks on outstanding balance** by default (matches the eZee zero-balance-before-checkout behavior), with a `force: true` override for cases like direct-billing/company accounts that get settled through a separate city-ledger process later.
- **Check-out** always flips the room to `dirty` on the way out, so housekeeping's queue updates automatically without a manual step.
- **Night audit** marks any reservation still `confirmed` past its check-in date as a `no_show` on close, and snapshots the day's revenue/occupancy numbers into `business_days` so a closed day can't be silently re-audited with different numbers later. Room-charge revenue in the summary reflects your current model of posting the full stay total at check-in (see the note below on nightly posting if you want per-night revenue reporting instead).
- **Rate plans** resolve per-night, not per-stay — a 3-night booking spanning a weekend and a weekday season both gets each night priced correctly rather than one flat rate for the whole stay. Overlapping plans are broken by `priority` (highest wins), then by rate. Call `/quote` before `POST /api/reservations` to get the right `rate_per_night` — though note reservations currently store a single flat `rate_per_night`, so for stays crossing multiple rate tiers you'd want to either average it or extend reservations to store the nightly breakdown (flagging this as a known simplification, same spirit as the night-audit note above).
- **Auth replaced free-text attribution.** Every place that used to accept `recorded_by`/`changed_by`/`created_by`/`closed_by` from the request body now takes it from the verified token (`req.user.username`) instead — so the cashier-shift report and audit trail can actually be trusted. The one exception is `assigned_to` in housekeeping, which is legitimately something a supervisor sets to someone *else* when assigning a task.
- **WhatsApp over email** for invoice delivery — deliberately reused your existing Twilio WhatsApp setup from Subla Tea rather than standing up a new email service, since you're already paying for and operating that infrastructure. The `send-whatsapp` route fails with a clear error (not a silent no-op) if the Twilio env vars aren't set — tested that path directly.

## Not yet built (next phases)

- A signup/onboarding flow for the first user (currently seeded directly via `psql`, see Setup above)

## Worth knowing before you scale this

The current model posts the **entire stay's room charge in one lump** at check-in (see `checkin.js`'s `confirm` route), rather than one night's charge per day the way traditional night audit expects. That's simpler and fine for a small property, but it means night audit's `room_revenue` reflects check-ins that day, not nights actually stayed that day. If you later want day-by-day P&L to match "nights consumed today," that's a schema change worth planning for — flag it if you want to tackle it.

The occupancy and revenue reports (`reports.js`) use `generate_series` to build a daily rollup — a standard Postgres pattern, but I haven't been able to run it against a live database in this environment, only syntax-check the JS around it. Worth a quick smoke test against your actual data before relying on it for anything decision-critical.
