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
| Find the active reservation for a room | `GET /api/reservations/by-room/:roomId` — built for the frontend's checkout flow |
| Housekeeping status  | `PATCH /api/rooms/:id/housekeeping` |
| Check-out: review folio | `GET /api/checkout/:reservationId/folio` |
| Add a charge mid-stay | `POST /api/reservations/:id/charges` — for anything during a stay (damage fee, extra service, airport transfer), not just at checkout |
| Check-out: add last-minute charge | `POST /api/checkout/:reservationId/charge` |
| Check-out: settle balance | `POST /api/checkout/:reservationId/settle` |
| Check-out: confirm | `POST /api/checkout/:reservationId/confirm` — flips reservation → `checked_out`, room → `vacant` + `dirty` |
| Print / view invoice | `GET /api/invoices/:reservationId` — streams a PDF built from folio data; now includes the property logo, address, and terms & conditions |
| Send invoice via WhatsApp | `POST /api/invoices/:reservationId/send-whatsapp` |
| Print guest registration card | `GET /api/checkin/:reservationId/registration-card` — printable check-in document with guest/stay details and a signature line, plus terms & conditions |
| Print departure confirmation / gate pass | `GET /api/checkout/:reservationId/gate-pass` — short printable confirmation that a checkout is complete and settled (only works once `status` is `checked_out`) |
| Print housekeeping report | `GET /api/housekeeping/report` — printable room status board + open task list, for a shift handover or morning walkthrough |
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
| View/edit terms & conditions | `GET /api/settings/terms-and-conditions` (any logged-in user), `PUT /api/settings/terms-and-conditions` (manager only) — shown on the invoice and registration card |
| Update a room's housekeeping status | `PATCH /api/rooms/:id/housekeeping` — `{status: 'clean' \| 'dirty' \| 'out_of_order'}`, now wired to the dashboard's click-to-clean and maintenance-block actions |
| Cashbook — auto-compiled cash ledger | `GET /api/reports/cashbook?start=&end=` (manager only) — running balance built from real payments/deposits/refunds/pay-outs/expenses, not manually re-entered |
| Edit an expense | `PATCH /api/expenses/:id` (supervisor+) — corrects a mistake; doesn't apply to guest folio entries, see design note below |
| Delete an expense | `DELETE /api/expenses/:id` (manager only) |
| Print expenses list | `GET /api/expenses/print?start=&end=&category=` (supervisor+) |
| Print cashbook | `GET /api/reports/cashbook/print?start=&end=` (manager only) |
| Edit an inventory item | `PATCH /api/inventory/items/:id` (supervisor+) — not stock levels, see design note |
| Deactivate an inventory item | `DELETE /api/inventory/items/:id` (manager only) — deactivates, doesn't hard-delete, see design note |
| Print inventory list | `GET /api/inventory/print` |
| Inventory: item types | `GET /api/inventory/items`, `POST /api/inventory/items` (supervisor+) |
| Inventory: low stock alert | `GET /api/inventory/low-stock` — central stock at or below reorder threshold |
| Inventory: room stock | `GET /api/inventory/rooms/:roomId` |
| Inventory: restock a room | `POST /api/inventory/rooms/:roomId/restock` — draws down central stock |
| Inventory: guest consumption | `POST /api/inventory/rooms/:roomId/consume` — if the item has a `guest_price` and a `reservation_id` is given, auto-posts an `extra_charge` to that guest's folio |
| Expenses: record | `POST /api/expenses` (supervisor+) |
| Expenses: list | `GET /api/expenses?category=&start=&end=` (supervisor+) |
| Expenses: summary | `GET /api/expenses/summary?start=&end=` (manager only — same gating as reports.js) |
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
- **Printable PDF documents** (invoice, registration card, gate pass, housekeeping report) all share `services/pdf-letterhead.js` for the logo/address/terms-and-conditions block, so branding stays consistent and only needs updating in one place. Worth knowing: PDFKit's `text(str, x, y)` calls with explicit coordinates (used for the multi-column tables and signature lines) don't reset the cursor for whatever's written next — I hit this exact bug twice while building these documents (things silently rendering on the wrong line or overlapping) and only caught it by actually rendering test PDFs and looking at them, not by reading the code. Any future column-based layout added to these files needs `doc.x` reset back to the left margin explicitly afterward, or the next section can land in the wrong place.
- **Terms & conditions text is a placeholder** — I drafted standard hotel policy language (check-in/out times, cancellation, damages, rate changes, right to refuse service) since you asked for a draft rather than supplying exact wording. It's not legal advice — worth having it reviewed before relying on it for anything contractual. Edit the `TERMS_AND_CONDITIONS` array in `services/pdf-letterhead.js` to change it.
- **Check-in/check-out times are 12:00 PM / 2:00 PM**, set explicitly on request. Worth knowing operationally: this means a departing guest has until 2:00 PM the same day an arriving guest can check in from noon — a 2-hour window where both could technically be active in the system before housekeeping turns the room over. Flagging this because it's a real scheduling consideration, not because the system enforces anything different from what was asked.
- **Inventory scope is guest-facing supplies only** (minibar, linens, amenities) — tracked per room against a central/warehouse stock count. Consuming an item with a `guest_price` set automatically posts a charge to the guest's folio if a `reservation_id` is passed, the same pattern as room charges. Back-of-house operational stock (cleaning supplies, F&B ingredients) isn't covered — would need a separate table if you want that tracked too, since mixing "things a guest can be billed for" with "things that are pure operating cost" under one model gets confusing fast.
- **Expenses are a flat ledger, not double-entry accounting.** Record → list → summary by category and date range. Deliberately append-only, same philosophy as the folio — no edit or delete endpoint exists yet, so a mistaken entry needs a correcting entry, not an edit. Recording and listing are supervisor+; the summary report is manager-only, matching the same gating already used for revenue/occupancy reports.
- **The check-in flow on the room grid is a real sequence, not one API call** — creating the reservation, assigning the room, recording a deposit, and confirming check-in are four separate requests. If one fails partway through (e.g. the network drops after the reservation's created but before the room's assigned), the UI stops immediately, tells you exactly what happened, and includes the reservation code so you can find and finish it from the dashboard rather than risk creating a duplicate by blindly retrying. Tested this whole flow, plus the checkout flow and the dirty-room block, end-to-end with a real headless browser against a mock API matching the live routes' shapes — not just by reading the code — but it's still a simulation, not the live database, so a first real run against production is worth watching closely.
- **Guest records are permanent** — checking a guest out only changes the reservation's status, never touches the `guests` table. The same phone number or email on a future booking reuses the existing guest profile instead of creating a duplicate. Fixed a real gap while adding Emirates ID/passport capture to the check-in form: a *returning* guest's ID details were previously silently dropped, since the guest-lookup code only ever wrote ID fields on first-time creation. Now a repeat visit fills in whatever's missing (ID type, ID number, nationality) without ever overwriting what's already on file — so a mistyped or blank re-entry can't clobber a correct one.
- **Print links initially didn't work — now fixed.** The three "Print" links (registration card, invoice, gate pass) are plain browser links opened in a new tab, but every API route requires a login token — and a plain link has no way to send one the normal way (the `Authorization` header, which only JavaScript can set). `middleware/auth.js` now also accepts the token as a `?token=` URL parameter, used only as a fallback when the header's absent, so these three print links carry it directly in the URL. The tradeoff, worth knowing: that token is then visible in the browser's address bar and history for that tab. Given tokens already expire after 12 hours and this only affects *viewing* a PDF — not any action that changes data — that's a reasonable exchange for print links that actually work, but it's a genuine tradeoff, not a free fix. Verified this at the middleware level directly (not just by checking the URLs looked right): confirmed a real JWT is accepted via the query parameter, confirmed the existing header-based login still works unchanged, and confirmed a missing or garbage token is still correctly rejected either way.
- **The dashboard's date display updates itself automatically**, including overnight. It doesn't wait for a page reload — a check runs every minute in the background, and the moment the date changes, both the header text and the dashboard's stats (arrivals/departures/room counts, which are date-dependent) refresh on their own. This matters for a front-desk computer that's realistically left open for days at a time. Verified this by controlling the browser's clock directly in a test and fast-forwarding it across a real midnight boundary — confirmed the date changed from one day to the next with zero user interaction, not just by reading the timer code and assuming it'd work.
- **The frontend now has real screens for Inventory, Expenses, and a Cashbook**, plus tab navigation to reach them — previously they only existed as API endpoints. Tab visibility matches backend role gating exactly (Inventory: everyone; Expenses: supervisor+; Cashbook: manager only) — verified this with actual logins as both a manager and a receptionist account, not just by reading the permission code.
- **Mid-stay extra charges finally have a place to go.** There was previously no way to add a charge (damage fee, extra service, late checkout) except by calling the API directly — clicking an occupied room only offered checkout, with no charge option along the way. The checkout modal now has an "+ Add Charge" action right above the balance: adding a charge refreshes the balance shown and keeps the modal open, so a charge can be added mid-stay without accidentally checking the guest out in the same motion. Verified end-to-end: adding a charge correctly updated the displayed balance by the exact amount, and the modal stayed open afterward rather than closing.
- **The Cashbook is a real ledger, not a revenue report.** It only counts actual cash movements — guest payments, deposits, refunds, drawer pay-outs, and recorded expenses — deliberately excluding room charges and other folio entries that don't represent money changing hands yet (that's what `/reports/revenue` is for). It carries forward a real opening balance from everything before the selected date range, the way a physical cashbook does, rather than resetting to zero every time a new range is picked. The running-balance arithmetic was verified independently against hand-calculated totals before being trusted in the SQL. One honest caveat: the SQL itself (a `UNION ALL` across `folio_transactions` and `expenses`, plus the opening-balance subqueries) was checked for correctness by reasoning through the logic carefully, not run against a live Postgres instance with real data — worth watching closely on the first real use, the same as any new financial report.
- **Expenses can be edited and deleted; guest folio entries deliberately can't.** These two look similar in the cashbook but aren't the same kind of record. An expense is the property's own internal note ("paid AED 200 for fuel") — correcting a typo there doesn't put anything else in the system out of sync. A guest's payment or deposit is different: it's tied to that guest's actual folio, and possibly an invoice that's already been printed and handed to them. Silently editing or deleting it there could make a printed invoice disagree with the system, or make a paid balance quietly vanish with no trace of what happened. So the cashbook shows an edit/delete action only on expense rows — for a guest-side correction, the safer path is a new charge or refund on that reservation, which keeps a visible trail instead of rewriting history. Editing is supervisor+ (same as recording one); deleting is manager-only, since removing a financial record entirely is more final than fixing a typo. Verified both the backend permission boundaries and the actual UI behavior with three different role logins (manager, supervisor, receptionist) — confirmed a supervisor can edit but the delete button doesn't even appear for them, and a receptionist can't reach either screen at all.
- **"Delete" on an inventory item deactivates it rather than removing the row.** `inventory_transactions` and `room_inventory` both reference an item with no cascade rule, so a true delete would fail outright the moment an item had ever been restocked or consumed — which is nearly every item worth deleting. Deactivating instead drops it from the active list and low-stock checks while keeping historical transactions valid. Editing an item also deliberately excludes `current_stock` — that field only moves through Restock and Record Consumption, so every change to it stays tied to a logged transaction instead of a silent edit. A miscounted shelf (a real scenario) isn't covered by this yet; that would need its own logged "adjustment" action, not a plain edit.
- **Print added to Inventory, Expenses, and the Cashbook**, same pattern as the guest-facing documents — a link carrying the login token so it opens correctly in a new tab. Each PDF was actually rendered and visually checked before shipping, not just assumed to lay out correctly from the code (the same multi-column layout bug that hit the housekeeping report earlier — PDFKit not resetting the cursor after explicit-coordinate text — is an easy trap to fall back into with any new table, so every one of these was checked directly). The cashbook's PDF and its on-screen JSON now share one function that builds the ledger, so the two can't quietly compute different numbers from the same data.

## Not yet built (next phases)

- A signup/onboarding flow for the first user (currently seeded directly via `psql`, see Setup above)
- A printable night audit report (same style as the housekeeping report) — the night audit API itself (`preview`/`close`/`history`) already exists and works
- Back-of-house/operational inventory (cleaning supplies, F&B) — see the inventory design note above
- The web frontend covers login, dashboard, check-in/check-out, ID capture, room housekeeping actions, printable documents, and now Inventory/Expenses/Cashbook screens with tab navigation. Still missing from the UI: the housekeeping report, occupancy/revenue reports, and night audit — all work via the API, just no button for them yet

## Worth knowing before you scale this

The current model posts the **entire stay's room charge in one lump** at check-in (see `checkin.js`'s `confirm` route), rather than one night's charge per day the way traditional night audit expects. That's simpler and fine for a small property, but it means night audit's `room_revenue` reflects check-ins that day, not nights actually stayed that day. If you later want day-by-day P&L to match "nights consumed today," that's a schema change worth planning for — flag it if you want to tackle it.

The occupancy and revenue reports (`reports.js`) use `generate_series` to build a daily rollup — a standard Postgres pattern, but I haven't been able to run it against a live database in this environment, only syntax-check the JS around it. Worth a quick smoke test against your actual data before relying on it for anything decision-critical.
