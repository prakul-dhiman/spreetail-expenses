# AI_USAGE.md — AI Tools Used

## Tools Used
- **Claude (Anthropic)** — primary development collaborator for architecture advice, boilerplate generation, and document drafting
- **GitHub Copilot** — inline code suggestions in VS Code

---

## How I Used AI

I used Claude to:
1. Help design the database schema (I described the problem, Claude suggested tables, I modified them)
2. Generate boilerplate Express routes (I then read and edited every function)
3. Draft the importer logic structure (I reviewed it against the actual CSV and corrected it)
4. Help write README, SCOPE, and DECISIONS drafts (I edited for accuracy)

I remained responsible for:
- Reading every line of code before committing
- Testing every route manually with Postman
- Verifying the importer output against the raw CSV row by row
- All product decisions (what to do with each anomaly type)

---

## Three Concrete Cases Where AI Was Wrong

### Case 1: Duplicate Detection Logic Was Too Loose

**What AI generated:**
```javascript
const isDuplicate = rows.some(prev =>
  prev.description === row.description && prev.amount === row.amount
);
```

**What was wrong:** This matched descriptions as exact strings. "Dinner at Marina Bites" and "dinner - marina bites" would NOT be caught as duplicates because the descriptions differ. Also `amount` was a string from CSV parsing, so `"3200" === "3200"` worked but `"1,200" === "1200"` would not.

**What I changed:** Normalized both strings (lowercase, strip non-alphanumeric) before comparing, and also stripped commas from amounts before comparing. Also added payer and date to the comparison to avoid false positives (two different expenses with the same amount on different days).

---

### Case 2: Percentage Validation Ran After Failed Rows Were Already Inserted

**What AI generated:** The importer inserted the expense into the database first, then validated percentages, and deleted the row if invalid.

**What was wrong:** This is backwards — if the DB insert succeeds but percentage validation fails, you have a corrupted partial state. On a crash between insert and delete, the bad row stays in the database permanently.

**What I changed:** Moved all validation (percentage sum, missing payer, empty split members) to happen BEFORE any database write. Only if all validation passes does the code enter the `BEGIN` transaction block. Reject early, write late.

---

### Case 3: Membership Date Logic Used Wrong Comparison

**What AI generated:**
```javascript
if (membership.left_at && expenseDate > membership.left_at) {
  // remove from split
}
```

**What was wrong:** JavaScript `Date` comparison with `>` works, but the dates were being compared as strings in some code paths (CSV gives dates as strings, `parseDate` converts them, but in one branch the raw string was being used). "2026-04-02" > "2026-03-31" works as a string comparison but only because ISO format is lexicographically sortable. When the date was in "02-04-2026" format (DD-MM-YYYY), string comparison gave wrong results.

**What I changed:** Ensured `parseDate()` is always called before any date comparison, and that both sides of the comparison are always `Date` objects. Added a check to log a warning if `expenseDate` is not a valid Date instance before the comparison runs.
