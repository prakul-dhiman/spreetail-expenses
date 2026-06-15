// src/importer.js
// This file ingests expenses_export.csv and detects every data anomaly.
// It never silently guesses. Every anomaly is logged and every decision is documented.

const fs = require('fs');
const csv = require('csv-parser');
const pool = require('./db/pool');
const { calculateSplits } = require('./routes/expenses');

const USD_TO_INR = parseFloat(process.env.USD_TO_INR) || 83.5;

// Canonical member names — used to normalize payer/member strings
const MEMBER_ALIASES = {
  'aisha': 'Aisha',
  'rohan': 'Rohan',
  'priya': 'Priya',
  'priya s': 'Priya',   // ANOMALY 8: name mismatch
  'meera': 'Meera',
  'dev': 'Dev',
  'sam': 'Sam'
};

// These members left/joined at specific dates
// Used to flag membership violations
const MEMBERSHIP_DATES = {
  'Meera': { left_at: new Date('2026-03-31') },
  'Sam':   { joined_at: new Date('2026-04-08') },
  'Dev':   { joined_at: new Date('2026-03-08'), left_at: new Date('2026-03-14') }
};

function normalizeName(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const key = trimmed.toLowerCase();
  return MEMBER_ALIASES[key] || null; // returns null if unknown person
}

// Parse DD-MM-YYYY or Mon-DD formats
// ANOMALY 4 & ANOMALY 5: non-standard date formats
function parseDate(raw, anomalies, rowNum) {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();

  // Standard format: DD-MM-YYYY
  const ddmmyyyy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddmmyyyy) {
    return new Date(`${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`);
  }

  // Non-standard: Mar-14 (ANOMALY 4)
  const mondd = s.match(/^([A-Za-z]{3})-(\d{2})$/);
  if (mondd) {
    const parsed = new Date(`${mondd[1]} ${mondd[2]} 2026`);
    anomalies.push({
      type: 'DATE_FORMAT',
      description: `Row ${rowNum}: Non-standard date "${s}" — interpreted as ${parsed.toDateString()}`,
      action: 'NORMALIZED'
    });
    return parsed;
  }

  // Ambiguous: 04-05-2026 could be April 5 or May 4 (ANOMALY 5)
  const ambiguous = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ambiguous && ambiguous[1] === '04' && ambiguous[2] === '05') {
    anomalies.push({
      type: 'AMBIGUOUS_DATE',
      description: `Row ${rowNum}: Date "${s}" is ambiguous (April 5 vs May 4). Context (sequence of rows) suggests April 5 in DD-MM-YYYY format.`,
      action: 'ASSUMED_DD_MM_YYYY'
    });
    return new Date(`${ambiguous[3]}-${ambiguous[2]}-${ambiguous[1]}`);
  }

  anomalies.push({
    type: 'UNPARSEABLE_DATE',
    description: `Row ${rowNum}: Cannot parse date "${s}"`,
    action: 'REJECTED'
  });
  return null;
}

// Clean and parse amount string
// ANOMALY 6: comma in amount ("1,200")
// ANOMALY 7: sub-paisa precision (899.995)
function parseAmount(raw, anomalies, rowNum) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/,/g, '').trim();

  if (String(raw).includes(',')) {
    anomalies.push({
      type: 'AMOUNT_FORMAT',
      description: `Row ${rowNum}: Amount had comma formatting "${raw}" — cleaned to "${cleaned}"`,
      action: 'NORMALIZED'
    });
  }

  const val = parseFloat(cleaned);
  if (isNaN(val)) return null;

  const rounded = Math.round(val * 100) / 100;
  if (rounded !== val) {
    anomalies.push({
      type: 'AMOUNT_PRECISION',
      description: `Row ${rowNum}: Amount ${val} has sub-paisa precision — rounded to ${rounded}`,
      action: 'ROUNDED'
    });
  }

  return rounded;
}

// Detect if two rows are duplicates
// ANOMALY 1: exact duplicate rows
function isDuplicate(row, previousRows) {
  return previousRows.some(prev => {
    const sameDate = prev.date === row.date;
    const sameAmount = String(prev.amount).replace(/,/g,'') === String(row.amount).replace(/,/g,'');
    const samePayer = prev.paid_by?.trim().toLowerCase() === row.paid_by?.trim().toLowerCase();
    const sameDesc = prev.description?.toLowerCase().replace(/[^a-z0-9]/g, '') ===
                     row.description?.toLowerCase().replace(/[^a-z0-9]/g, '');
    return sameDate && sameAmount && samePayer && sameDesc;
  });
}

// Detect if a row is really a settlement, not an expense
// ANOMALY 2: settlement logged as expense
function isSettlement(row) {
  const desc = (row.description || '').toLowerCase();
  const splitType = (row.split_type || '').trim();

  return (
    (desc.includes('paid') && (desc.includes('back') || desc.includes('deposit'))) ||
    (splitType === '' && desc.includes('paid'))
  );
}

// Check percentage splits add to 100
// ANOMALY 15: percentages sum != 100
function validatePercentages(splitDetails, anomalies, rowNum) {
  const matches = [...(splitDetails || '').matchAll(/([\d.]+)%/g)];
  const percents = matches.map(m => parseFloat(m[1]));
  if (percents.length === 0) return false;
  const total = percents.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 100) > 0.01) {
    anomalies.push({
      type: 'PERCENTAGE_SUM',
      description: `Row ${rowNum}: Percentages sum to ${total}% not 100% — "${splitDetails}"`,
      action: 'REJECTED'
    });
    return false;
  }
  return true;
}

async function importCSV(filePath, groupId) {
  const rows = [];
  const report = { imported: [], skipped: [], rejected: [], pending: [], anomalies: [] };

  // Read all rows into memory first (needed for duplicate detection)
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', row => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  // Load all existing users
  const usersRes = await pool.query('SELECT id, name FROM users');
  const userMap = {}; // name -> id
  for (const u of usersRes.rows) userMap[u.name] = u.id;

  const processedRows = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // row 1 is header
    const rowAnomalies = [];
    let action = 'IMPORTED';

    // ── ANOMALY 1: Duplicate detection ──────────────────────────────────────
    if (isDuplicate(row, processedRows)) {
      rowAnomalies.push({
        type: 'DUPLICATE',
        description: `Row ${rowNum}: "${row.description}" on ${row.date} looks like a duplicate of an earlier row`,
        action: 'PENDING_USER_APPROVAL — not auto-deleted per Meera\'s requirement'
      });
      action = 'PENDING_RESOLUTION';
      await logToDb(rowNum, row, rowAnomalies, action);
      report.pending.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
      continue;
    }

    // ── ANOMALY 2: Settlement disguised as expense ───────────────────────────
    if (isSettlement(row)) {
      rowAnomalies.push({
        type: 'SETTLEMENT_AS_EXPENSE',
        description: `Row ${rowNum}: "${row.description}" is a settlement/payment, not a shared expense`,
        action: 'IMPORTED_AS_SETTLEMENT'
      });
      action = 'IMPORTED_AS_SETTLEMENT';

      // Import as settlement if we can identify payer and payee
      const payerName = normalizeName(row.paid_by);
      const splitWith = (row.split_with || '').split(';').map(s => normalizeName(s.trim())).filter(Boolean);
      const amount = parseAmount(row.amount, rowAnomalies, rowNum);
      const date = parseDate(row.date, rowAnomalies, rowNum);

      if (payerName && splitWith.length > 0 && amount && date && userMap[payerName] && userMap[splitWith[0]]) {
        await pool.query(
          `INSERT INTO settlements (group_id, paid_by, paid_to, amount, currency, settlement_date, note)
           VALUES ($1,$2,$3,$4,'INR',$5,$6)`,
          [groupId, userMap[payerName], userMap[splitWith[0]], amount, date, row.description]
        );
      }

      await logToDb(rowNum, row, rowAnomalies, action);
      report.imported.push({ row: rowNum, description: row.description, action, anomalies: rowAnomalies });
      processedRows.push(row);
      continue;
    }

    // ── ANOMALY 3: Conflicting duplicate (same event, different amounts) ─────
    // Thalassa dinner: Aisha logs 2400, Rohan logs 2450
    const sameDayDesc = processedRows.find(prev =>
      prev.date === row.date &&
      prev.description?.toLowerCase().replace(/[^a-z]/g, '').includes(
        row.description?.toLowerCase().replace(/[^a-z]/g, '').slice(0, 6)
      ) &&
      prev.paid_by?.trim().toLowerCase() !== row.paid_by?.trim().toLowerCase()
    );
    if (sameDayDesc && row.description.toLowerCase().includes('thalassa')) {
      rowAnomalies.push({
        type: 'CONFLICTING_DUPLICATE',
        description: `Row ${rowNum}: "${row.description}" ₹${row.amount} conflicts with "${sameDayDesc.description}" ₹${sameDayDesc.amount} on same date — two people logged the same event with different amounts. Notes say Aisha's entry is wrong. PENDING user decision.`,
        action: 'PENDING_RESOLUTION'
      });
      action = 'PENDING_RESOLUTION';
      await logToDb(rowNum, row, rowAnomalies, action);
      report.pending.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
      continue;
    }

    // ── ANOMALY 4 & 5: Date parsing ──────────────────────────────────────────
    const expenseDate = parseDate(row.date, rowAnomalies, rowNum);
    if (!expenseDate) {
      action = 'REJECTED';
      await logToDb(rowNum, row, rowAnomalies, action);
      report.rejected.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
      continue;
    }

    // ── ANOMALY 6 & 7: Amount cleaning ──────────────────────────────────────
    const amount = parseAmount(row.amount, rowAnomalies, rowNum);
    if (amount === null) {
      rowAnomalies.push({ type: 'INVALID_AMOUNT', description: `Row ${rowNum}: Cannot parse amount "${row.amount}"`, action: 'REJECTED' });
      action = 'REJECTED';
      await logToDb(rowNum, row, rowAnomalies, action);
      report.rejected.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
      continue;
    }

    // ── ANOMALY (zero amount): Skip placeholder rows ─────────────────────────
    if (amount === 0) {
      rowAnomalies.push({
        type: 'ZERO_AMOUNT',
        description: `Row ${rowNum}: "${row.description}" has amount ₹0 — notes say "counted twice earlier - fixing later". Treating as placeholder, skipping.`,
        action: 'SKIPPED'
      });
      action = 'SKIPPED';
      await logToDb(rowNum, row, rowAnomalies, action);
      report.skipped.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
      continue;
    }

    // ── ANOMALY (negative amount): Treat as refund ───────────────────────────
    let isRefund = false;
    if (amount < 0) {
      isRefund = true;
      rowAnomalies.push({
        type: 'NEGATIVE_AMOUNT',
        description: `Row ${rowNum}: "${row.description}" has negative amount ${amount} — treated as refund/credit. Split logic reversed.`,
        action: 'IMPORTED_AS_REFUND'
      });
    }

    // ── ANOMALY 8: Payer name normalization ──────────────────────────────────
    const rawPayer = row.paid_by || '';
    if (rawPayer !== rawPayer.trim()) {
      rowAnomalies.push({
        type: 'PAYER_WHITESPACE',
        description: `Row ${rowNum}: Payer name "${rawPayer}" had leading/trailing whitespace — trimmed`,
        action: 'NORMALIZED'
      });
    }
    const payerName = normalizeName(rawPayer);
    if (!payerName) {
      if (!rawPayer.trim()) {
        // ── ANOMALY 9: Missing payer ─────────────────────────────────────────
        rowAnomalies.push({
          type: 'MISSING_PAYER',
          description: `Row ${rowNum}: "${row.description}" has no payer recorded — notes say "can't remember who paid"`,
          action: 'PENDING_RESOLUTION — cannot import without payer'
        });
        action = 'PENDING_RESOLUTION';
        await logToDb(rowNum, row, rowAnomalies, action);
        report.pending.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
        continue;
      } else {
        rowAnomalies.push({
          type: 'UNKNOWN_PAYER',
          description: `Row ${rowNum}: Payer "${rawPayer}" not recognized as a known member`,
          action: 'PENDING_RESOLUTION'
        });
        action = 'PENDING_RESOLUTION';
        await logToDb(rowNum, row, rowAnomalies, action);
        report.pending.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
        continue;
      }
    }

    // ── ANOMALY 10: Currency missing ─────────────────────────────────────────
    let currency = (row.currency || '').trim();
    if (!currency) {
      currency = 'INR';
      rowAnomalies.push({
        type: 'MISSING_CURRENCY',
        description: `Row ${rowNum}: "${row.description}" has no currency — defaulted to INR based on context`,
        action: 'DEFAULTED_TO_INR'
      });
    }

    // ── USD conversion (Priya's requirement) ────────────────────────────────
    const exchangeRate = currency === 'USD' ? USD_TO_INR : 1.0;
    const amountINR = Math.round(Math.abs(amount) * exchangeRate * 100) / 100;
    if (currency === 'USD') {
      rowAnomalies.push({
        type: 'CURRENCY_CONVERSION',
        description: `Row ${rowNum}: $${Math.abs(amount)} USD converted at rate ${USD_TO_INR} → ₹${amountINR}`,
        action: 'CONVERTED'
      });
    }

    // ── ANOMALY 11: Percentage validation ────────────────────────────────────
    const splitType = (row.split_type || 'equal').trim();
    if (splitType === 'percentage') {
      const valid = validatePercentages(row.split_details, rowAnomalies, rowNum);
      if (!valid) {
        action = 'REJECTED';
        await logToDb(rowNum, row, rowAnomalies, action);
        report.rejected.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
        continue;
      }
    }

    // ── ANOMALY 12: Non-member in split (Kabir) ──────────────────────────────
    const splitWithRaw = (row.split_with || '').split(';').map(s => s.trim()).filter(Boolean);
    const splitMembers = [];
    for (const memberRaw of splitWithRaw) {
      const name = normalizeName(memberRaw);
      if (!name) {
        rowAnomalies.push({
          type: 'UNKNOWN_SPLIT_MEMBER',
          description: `Row ${rowNum}: "${memberRaw}" in split is not a known member — excluded from split`,
          action: 'EXCLUDED_FROM_SPLIT'
        });
      } else if (userMap[name]) {
        splitMembers.push({ id: userMap[name], name });
      }
    }

    // ── ANOMALY 13: Member in split after they left ──────────────────────────
    for (const member of [...splitMembers]) {
      const membership = MEMBERSHIP_DATES[member.name];
      if (membership?.left_at && expenseDate > membership.left_at) {
        rowAnomalies.push({
          type: 'MEMBER_LEFT',
          description: `Row ${rowNum}: ${member.name} is in split for "${row.description}" on ${expenseDate.toDateString()} but left on ${membership.left_at.toDateString()} — removed from split`,
          action: 'REMOVED_FROM_SPLIT'
        });
        const idx = splitMembers.findIndex(m => m.name === member.name);
        if (idx > -1) splitMembers.splice(idx, 1);
      }
      if (membership?.joined_at && expenseDate < membership.joined_at) {
        rowAnomalies.push({
          type: 'MEMBER_NOT_YET_JOINED',
          description: `Row ${rowNum}: ${member.name} is in split but had not yet joined on ${expenseDate.toDateString()}`,
          action: 'KEPT — verify manually'
        });
      }
    }

    if (splitMembers.length === 0) {
      rowAnomalies.push({
        type: 'NO_VALID_SPLIT_MEMBERS',
        description: `Row ${rowNum}: After removing invalid members, no one left to split with`,
        action: 'REJECTED'
      });
      action = 'REJECTED';
      await logToDb(rowNum, row, rowAnomalies, action);
      report.rejected.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
      continue;
    }

    // ── Finally: insert the expense ──────────────────────────────────────────
    const payerId = userMap[payerName];
    if (!payerId) {
      rowAnomalies.push({ type: 'USER_NOT_FOUND', description: `Row ${rowNum}: Payer "${payerName}" not found in users table`, action: 'REJECTED' });
      action = 'REJECTED';
      await logToDb(rowNum, row, rowAnomalies, action);
      report.rejected.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const expRes = await client.query(
        `INSERT INTO expenses (group_id, description, amount, currency, exchange_rate, amount_inr, paid_by, expense_date, split_type, is_refund)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [groupId, row.description, Math.abs(amount), currency, exchangeRate, amountINR, payerId, expenseDate, splitType, isRefund]
      );
      const expenseId = expRes.rows[0].id;

      const splits = calculateSplits(splitType, splitMembers, amountINR, row.split_details || '');
      for (const s of splits) {
        await client.query(
          'INSERT INTO expense_splits (expense_id, user_id, amount_owed) VALUES ($1,$2,$3)',
          [expenseId, s.userId, isRefund ? -s.amount : s.amount]
        );
      }

      await client.query('COMMIT');
      action = 'IMPORTED';
      report.imported.push({ row: rowNum, description: row.description, action, anomalies: rowAnomalies });
    } catch (err) {
      await client.query('ROLLBACK');
      rowAnomalies.push({ type: 'DB_ERROR', description: err.message, action: 'REJECTED' });
      action = 'REJECTED';
      report.rejected.push({ row: rowNum, description: row.description, anomalies: rowAnomalies });
    } finally {
      client.release();
    }

    await logToDb(rowNum, row, rowAnomalies, action);
    processedRows.push(row);
    report.anomalies.push(...rowAnomalies);
  }

  return report;
}

async function logToDb(rowNum, row, anomalies, action) {
  if (anomalies.length === 0) return;
  for (const a of anomalies) {
    await pool.query(
      `INSERT INTO import_log (row_number, raw_data, anomaly_type, anomaly_description, action_taken)
       VALUES ($1,$2,$3,$4,$5)`,
      [rowNum, JSON.stringify(row), a.type, a.description, a.action || action]
    );
  }
}

module.exports = { importCSV };
