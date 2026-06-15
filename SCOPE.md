# SCOPE.md — Anomaly Log & Database Schema

## CSV Anomalies Found

Every data problem found in `expenses_export.csv` and how the importer handles it.

---

### ANOMALY 1 — Exact Duplicate Row
**Row:** 5  
**Problem:** "dinner - marina bites" on 08-02-2026, ₹3200, paid by Dev is a case-insensitive duplicate of Row 4 "Dinner at Marina Bites" (same date, same amount, same payer, same description after normalization).  
**Policy:** Flag as PENDING_RESOLUTION. Do not auto-delete. Surface to user for approval. (Meera's requirement: "I want to approve anything the app deletes or changes.")

---

### ANOMALY 2 — Settlement Logged as Expense
**Row:** 13  
**Problem:** "Rohan paid Aisha back" with no split_type. Notes say "this is a settlement not an expense??"  
**Policy:** Detect using keywords (paid + back) and empty split_type. Import as a `settlements` record, not an expense.

---

### ANOMALY 3 — Conflicting Duplicate (Same Dinner, Different Amounts)
**Rows:** 23 & 24  
**Problem:** "Dinner at Thalassa" logged by Aisha (₹2400) and "Thalassa dinner" logged by Rohan (₹2450) on the same date. Notes on Row 24 say "Aisha's is wrong."  
**Policy:** Flag Row 24 as PENDING_RESOLUTION. Cannot auto-resolve because amounts differ and we need the user to confirm which is correct.

---

### ANOMALY 4 — Non-Standard Date Format
**Row:** 26  
**Problem:** Date field is "Mar-14" instead of "14-03-2026".  
**Policy:** Parse using regex for `Mon-DD` format, assume year 2026 (consistent with all other data). Log the interpretation.

---

### ANOMALY 5 — Ambiguous Date
**Row:** 33  
**Problem:** Date "04-05-2026" could be April 5 or May 4. Notes say "is this April 5 or May 4? format is a mess."  
**Policy:** Use row sequence context — surrounding rows are all April 2026. Apply DD-MM-YYYY interpretation → April 5. Log the assumption explicitly.

---

### ANOMALY 6 — Comma in Amount Field
**Row:** 6  
**Problem:** Amount is "1,200" (string with comma) instead of 1200.  
**Policy:** Strip comma, parse as float. Log normalization.

---

### ANOMALY 7 — Sub-Paisa Precision
**Row:** 9  
**Problem:** Amount is 899.995 — more precision than Indian currency supports (2 decimal places).  
**Policy:** Round to 2 decimal places → 900.00. Log rounding.

---

### ANOMALY 8 — Payer Name Mismatch
**Row:** 10  
**Problem:** Paid_by is "Priya S" instead of "Priya".  
**Policy:** Map known aliases via `MEMBER_ALIASES` lookup. "Priya S" → "Priya". Log normalization.

---

### ANOMALY 9 — Missing Payer
**Row:** 12  
**Problem:** paid_by field is empty. Notes say "can't remember who paid."  
**Policy:** Cannot import an expense without a payer (balance calculation would be wrong). Mark as PENDING_RESOLUTION. Surface to user to fill in.

---

### ANOMALY 10 — Missing Currency
**Row:** 27  
**Problem:** Currency field is blank for "Groceries DMart" ₹2105.  
**Policy:** Default to INR based on context (all surrounding expenses are INR, amount looks like INR). Log the assumption.

---

### ANOMALY 11 — Percentage Split Doesn't Sum to 100%
**Row:** 14  
**Problem:** "Pizza Friday" split: Aisha 30% + Rohan 30% + Priya 30% + Meera 20% = 110%.  
**Policy:** REJECT the row. Do not silently normalize (e.g. dividing each by 1.1) because that would hide an error. User must fix and re-import. Log as REJECTED.

---

### ANOMALY 12 — Non-Member in Split
**Row:** 21  
**Problem:** "Parasailing" split includes "Dev's friend Kabir" who is not a registered member.  
**Policy:** Exclude Kabir from the split (he is not a flat mate and has no account). Log exclusion. Remaining members (Aisha, Rohan, Priya, Dev) split the cost.

---

### ANOMALY 13 — Member in Split After They Left
**Row:** 35  
**Problem:** "Groceries BigBasket" on 02-04-2026 includes Meera in split_with, but Meera moved out end of March (31-03-2026). Note says "oops Meera still in the group list."  
**Policy:** Remove Meera from the split automatically. Log removal. Re-split among remaining active members (Sam's requirement: "Why would March electricity affect my balance?" → by extension, post-March expenses should not affect Meera's balance).

---

### ANOMALY 14 — Negative Amount (Refund)
**Row:** 25  
**Problem:** "Parasailing refund" has amount -30 USD. One slot got cancelled.  
**Policy:** Treat as a refund. Store as `is_refund = TRUE`. Reverse the split direction (members receive money back). Log as IMPORTED_AS_REFUND.

---

### ANOMALY 15 — Zero Amount Placeholder
**Row:** 30  
**Problem:** "Dinner order Swiggy" ₹0. Notes say "counted twice earlier - fixing later."  
**Policy:** Skip the row. Zero-amount expenses have no effect on balances and are clearly placeholders. Log as SKIPPED.

---

### ANOMALY 16 — Sam's Deposit Logged as Expense
**Row:** 37  
**Problem:** "Sam deposit share" — Sam pays Aisha ₹15000. Notes: "Sam moving in! paid Aisha his deposit."  
**Policy:** Import as a settlement (Sam → Aisha), not a shared expense. Same logic as Anomaly 2.

---

### ANOMALY 17 — Payer Name Has Trailing Space
**Row:** 26  
**Problem:** paid_by is "rohan " (lowercase + trailing space).  
**Policy:** Trim whitespace, normalize case via MEMBER_ALIASES. Log normalization.

---

### ANOMALY 18 — split_type Says "equal" But Has Share Details
**Row:** 41  
**Problem:** "Furniture for common room" has split_type = "equal" but split_details = "Aisha 1; Rohan 1; Priya 1; Sam 1" (share notation).  
**Policy:** Since all shares are equal (1 each), the result is the same. Treat as equal split. Log the inconsistency.

---

## Database Schema

```sql
users (id, name, email, password_hash, created_at)

groups (id, name, created_at)

group_memberships (
  id, group_id, user_id, 
  joined_at,    -- when they joined the group
  left_at       -- NULL = still active
)

expenses (
  id, group_id, description,
  amount,           -- original amount in original currency
  currency,         -- INR or USD
  exchange_rate,    -- rate used at time of import
  amount_inr,       -- always stored in INR for balance calculation
  paid_by,          -- user_id of who paid
  expense_date,
  split_type,       -- equal | unequal | percentage | share
  is_refund,        -- TRUE for negative amounts
  created_at
)

expense_splits (
  id, expense_id, user_id,
  amount_owed       -- negative if is_refund
)

settlements (
  id, group_id, paid_by, paid_to,
  amount, currency, settlement_date, note, created_at
)

import_log (
  id, row_number, raw_data,
  anomaly_type, anomaly_description, action_taken,
  resolved, created_at
)
```

### Why this schema?

- `group_memberships` with `joined_at`/`left_at` solves the Sam/Meera problem — we can query "who was active on this date?"
- `amount_inr` means balance calculations never need to think about currency — always one unit
- `import_log` is separate from expenses so anomalies are traceable independently of the final imported data
- `expense_splits` stores the actual resolved amount per person, not percentages/shares — so balance calculation is a simple SUM
