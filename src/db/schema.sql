-- Run this file once to set up your database
-- psql -U postgres -d spreetail -f src/db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tracks who is in a group and when they joined/left
-- left_at NULL = still active member
CREATE TABLE IF NOT EXISTS group_memberships (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  joined_at DATE NOT NULL,
  left_at DATE,
  UNIQUE(group_id, user_id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  currency CHAR(3) DEFAULT 'INR',
  exchange_rate NUMERIC(10,4) DEFAULT 1.0,
  amount_inr NUMERIC(12,2) NOT NULL,
  paid_by INT REFERENCES users(id),
  expense_date DATE NOT NULL,
  split_type TEXT NOT NULL DEFAULT 'equal', -- equal, unequal, percentage, share
  is_refund BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Each row = how much one person owes for one expense
CREATE TABLE IF NOT EXISTS expense_splits (
  id SERIAL PRIMARY KEY,
  expense_id INT REFERENCES expenses(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id),
  amount_owed NUMERIC(12,2) NOT NULL
);

-- Direct payments between people (not shared expenses)
CREATE TABLE IF NOT EXISTS settlements (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  paid_by INT REFERENCES users(id),
  paid_to INT REFERENCES users(id),
  amount NUMERIC(12,2) NOT NULL,
  currency CHAR(3) DEFAULT 'INR',
  settlement_date DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Every CSV row that had a problem gets logged here
CREATE TABLE IF NOT EXISTS import_log (
  id SERIAL PRIMARY KEY,
  row_number INT,
  raw_data TEXT,
  anomaly_type TEXT,
  anomaly_description TEXT,
  action_taken TEXT, -- IMPORTED, SKIPPED, REJECTED, PENDING_RESOLUTION, IMPORTED_AS_SETTLEMENT
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
