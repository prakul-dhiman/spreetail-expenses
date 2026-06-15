# DECISIONS.md — Decision Log

Each significant technical or product decision, options considered, and why I chose what I chose.

---

## 1. Backend Framework: Express.js

**Options considered:**
- Express.js (Node)
- FastAPI (Python)
- Django (Python)

**Decision:** Express.js

**Reasoning:** I'm most productive in Node/JS. The assignment is time-constrained (2 days). Django and FastAPI would be faster to set up a CRUD API but I know Express's gotchas well enough to move quickly and debug confidently. The live session will involve modifying code live — I need to be in a language I can navigate without looking things up.

---

## 2. Database: PostgreSQL (not SQLite)

**Options considered:**
- SQLite (zero setup, file-based)
- PostgreSQL
- MySQL

**Decision:** PostgreSQL

**Reasoning:** The assignment explicitly says "relational DBs only." PostgreSQL gives proper date types, NUMERIC precision for money, and foreign key constraints that enforce data integrity. Render.com offers free hosted PostgreSQL, so deployment complexity is the same. SQLite would have been fine locally but Render doesn't support it persistently.

---

## 3. USD Conversion Rate: Fixed at 83.5

**Options considered:**
- Call a live currency API (e.g. exchangerate-api.com) at import time
- Use a fixed historical rate
- Store the raw USD amount only and let the user set the rate

**Decision:** Fixed rate of 83.5, documented and overridable via env var

**Reasoning:** The Goa trip was in March 2026. A live API would give today's rate, not March's rate, which would be wrong. A real historical rate would require a paid API. Fixed rate 83.5 is close to the March 2026 actual rate and is documented transparently. The user can change `USD_TO_INR` in their environment. This is the most honest option given the constraints.

---

## 4. Percentage Validation: Reject, Don't Normalize

**Options considered:**
- Silently normalize (divide each % by total to make them sum to 100)
- Warn but import anyway
- Reject the row

**Decision:** Reject the row

**Reasoning:** Rohan's requirement: "No magic numbers. If the app says I owe ₹2300, I want to see exactly which expenses make that up." Silent normalization would change the amounts from what people agreed to. If someone entered 30+30+30+20=110%, they made a mistake. The right answer is to tell them, not guess. A rejected row with a clear message is honest. A silently-normalized row creates debt numbers nobody agreed to.

---

## 5. Duplicate Handling: Surface, Don't Auto-Delete

**Options considered:**
- Auto-delete exact duplicates
- Flag duplicates and skip them
- Surface for user approval

**Decision:** Surface as PENDING_RESOLUTION, require user approval

**Reasoning:** Meera's explicit requirement: "Clean up the duplicates — but I want to approve anything the app deletes or changes." Even when it's obvious (exact same date, amount, payer, description), deleting without asking would violate user trust. The import report shows exactly which rows are pending and why.

---

## 6. Negative Amounts: Refund, Not Error

**Options considered:**
- Reject negative amounts as invalid
- Treat as refund (reverse split)

**Decision:** Treat as refund

**Reasoning:** The CSV has "Parasailing refund" with -30 USD explicitly because one slot was cancelled. This is clearly intentional. Rejecting it would lose real data. Treating it as a refund (is_refund = TRUE, splits become negative amounts_owed) correctly reverses the balance effect.

---

## 7. Missing Payer: Halt, Don't Guess

**Options considered:**
- Skip the row silently
- Assign to a default "unknown" user
- Mark as PENDING, surface to user

**Decision:** Mark as PENDING_RESOLUTION

**Reasoning:** Balance calculation requires knowing who paid. Without a payer, the money appears from nowhere. Assigning to an "unknown" user would corrupt balances. The correct action is to tell the user "Row 12 has no payer — who paid for house cleaning supplies?" and wait for human input.

---

## 8. Frontend: Single HTML File (No Framework)

**Options considered:**
- React with Vite
- Vue.js
- Plain HTML + Vanilla JS

**Decision:** Plain HTML + Vanilla JS in one file

**Reasoning:** Zero build step. Easier to deploy (just serve static files). The evaluators can open one file and read every line of UI code without a bundler. Functionality > polish is the stated evaluation criterion. A React app with a broken build fails deployment; a single HTML file always renders.

---

## 9. Meera Post-March / Sam Pre-April: Enforce Membership Dates

**Options considered:**
- Ignore membership dates, split with whoever is listed in the CSV
- Remove members who were inactive on the expense date

**Decision:** Enforce membership dates, remove inactive members from splits

**Reasoning:** Sam's requirement: "I moved in mid-April. Why would March electricity affect my balance?" The same logic applies in reverse to Meera. The `group_memberships` table stores `joined_at` and `left_at`. The importer checks these before calculating splits. This is also the correct product behavior for any expense-sharing app.

---

## 10. Auth: JWT (Not Sessions)

**Options considered:**
- Express sessions + cookies
- JWT in Authorization header

**Decision:** JWT

**Reasoning:** Stateless. Works out of the box with any deployment. No need for a session store. The token is stored in localStorage on the client and sent as a Bearer token. Simple, debuggable, standard.
