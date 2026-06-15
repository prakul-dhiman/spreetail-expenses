# Spreetail Expenses

A shared expense tracker for flat mates — built for the Spreetail internship assignment.

## Live App
[https://spreetail-expenses.onrender.com](https://spreetail-expenses.onrender.com)

## Tech Stack
- **Backend:** Node.js + Express
- **Database:** PostgreSQL (relational, with full referential integrity)
- **Frontend:** Vanilla HTML/CSS/JS (single file, no build step)
- **Auth:** JWT (bcryptjs + jsonwebtoken)
- **CSV parsing:** csv-parser + multer
- **Deployment:** Render.com

## Local Setup

### Prerequisites
- Node.js 18+
- PostgreSQL running locally

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/spreetail-expenses
cd spreetail-expenses

# 2. Install dependencies
npm install

# 3. Create your .env file
cp .env.example .env
# Edit .env and set your DATABASE_URL and JWT_SECRET

# 4. Create the database
createdb spreetail
# Or in psql: CREATE DATABASE spreetail;

# 5. Run the schema
psql -U postgres -d spreetail -f src/db/schema.sql

# 6. Start the server
npm start
# Server runs at http://localhost:3000
```

## AI Tools Used
See [AI_USAGE.md](./AI_USAGE.md)

## Data Anomalies Found
See [SCOPE.md](./SCOPE.md)

## Key Decisions
See [DECISIONS.md](./DECISIONS.md)

## How to Import the CSV
1. Register and login
2. Create a group (e.g. "Flat Expenses")
3. Add all members (Aisha, Rohan, Priya, Meera, Dev, Sam) — they must register first
4. Go to the **Import CSV** tab
5. Upload `expenses_export.csv`
6. The app will display a full import report showing every anomaly and what was done

## Project Structure
```
spreetail-expenses/
  src/
    routes/        # Express route handlers
    middleware/    # JWT auth middleware
    db/            # schema.sql and pg pool
    importer.js    # Core CSV ingestion logic
  public/
    index.html     # Entire frontend (single file)
  index.js         # App entry point
  SCOPE.md
  DECISIONS.md
  AI_USAGE.md
```
