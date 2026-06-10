# AlgoLadder Research Portal — Deployment Guide

A lightweight multistudy research participation portal including the AlgoLadder bilingual
computational thinking study. Runs on Render's free tier with Supabase
as the database. Total deployment time: approximately 20 minutes.

---

## Architecture

```
Student browser
    ↕ HTTPS
AlgoLadder HTML (GitHub → Cloudflare Pages)
    ↕ fetch()
Portal API (this repo → Render free web service)
    ↕ @supabase/supabase-js
Supabase PostgreSQL (free tier)
```

---

## Step 1 — Create the Supabase database

1. Go to https://supabase.com and create a free account.
2. Create a new project. Choose the region closest to Nigeria
   (currently: `eu-west-2` London is the nearest available).
3. Once the project is ready, open the **SQL Editor**.
4. Paste the entire contents of `schema.sql` and click **Run**.
5. Go to **Settings → API**. Copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **service_role** key (under "Project API keys") → this is your
     `SUPABASE_SERVICE_KEY`. Keep this secret — it bypasses row-level security.

---

## Step 2 — Deploy the API to Render

1. Push this folder to a GitHub repository
   (e.g. `github.com/YourUsername/algoladder-portal`).
2. Go to https://render.com and create a free account.
3. Click **New → Web Service**. Connect your GitHub repo.
4. Render will detect `render.yaml` automatically. Confirm the settings.
5. Under **Environment Variables**, add:
   - `SUPABASE_URL` — paste your Supabase Project URL
   - `SUPABASE_SERVICE_KEY` — paste your service_role key
   - `ADMIN_PIN` — choose a secure PIN for the instructor dashboard
6. Click **Deploy**. Wait ~2 minutes for the first build.
7. Copy your Render URL (e.g. `https://algoladder-portal.onrender.com`).

> **Note on free tier cold starts:** Render's free tier spins down after
> 15 minutes of inactivity. The first request after a period of inactivity
> takes 20–40 seconds to respond. This is acceptable for research use;
> inform participants not to close the browser immediately after opening.
> For production studies, upgrade to the $7/month Render Starter plan.

---

## Step 3 — Connect AlgoLadder to the API

Open `algoladder_enhanced.html`. Find this line near the top of the
`<script>` block:

```javascript
const API_BASE = ''; // e.g. 'https://algoladder-portal.onrender.com'
```

Replace the empty string with your Render URL:

```javascript
const API_BASE = 'https://algoladder-portal.onrender.com';
```

Also update the two researcher details:

```javascript
const ETHICS_REF = 'REC/NSPoly/CS/2025/___';
const RESEARCHER_CONTACT = 'Dr O. O. Campbell — email@nspoly.edu.ng — 080...';
```

Commit and push to your Cloudflare Pages repository. The site will
rebuild automatically.

---

## Step 4 — Test the deployment

```bash
# Health check
curl https://algoladder-portal.onrender.com/health

# Test enrolment
curl -X POST https://algoladder-portal.onrender.com/api/enrol \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Student","matric":"NDCS/024/0001","lang":"en"}'

# Admin dashboard (replace 1234 with your PIN)
curl https://algoladder-portal.onrender.com/api/admin/sessions \
  -H "x-admin-pin: 1234"

# CSV export
curl https://algoladder-portal.onrender.com/api/admin/export/csv \
  -H "x-admin-pin: 1234" -o algoladder_data.csv
```

---

## API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET    | `/health` | none | Liveness check |
| POST   | `/api/enrol` | none | Register or retrieve participant |
| POST   | `/api/session/:code` | none | Save session state |
| GET    | `/api/session/:code` | none | Load session for resume |
| GET    | `/api/admin/sessions` | PIN | List all sessions (JSON) |
| GET    | `/api/admin/export/json` | PIN | Download full JSON export |
| GET    | `/api/admin/export/csv` | PIN | Download analysis-ready CSV |

Admin PIN is passed as header `x-admin-pin: YOUR_PIN`
or query string `?pin=YOUR_PIN`.

---

## Data governance notes

- Student names and matric numbers are stored in Supabase (EU region).
- Inform participants of this in the consent form (already done in the HTML).
- Supabase free tier retains data for as long as the project is active.
- Before study closure, export all data via `/api/admin/export/csv`,
  then delete the Supabase project to comply with NDPR retention limits.
- Never share the `SUPABASE_SERVICE_KEY` or the `ADMIN_PIN`.

---

## Local development

```bash
cp .env.example .env
# Edit .env with your Supabase credentials
npm install
npm run dev
# API available at http://localhost:3000
```

---

## Extending to a multi-study portal

The Backup schema stores one session per participant per matric number. The current version now support multiple studies or instruments per participant, adding  a `study_id`
column to the participants table and include it in enrolment requests.
The frontend can then pass a study identifier (e.g. `algoladder_2026`)
to scope sessions correctly, allowing the same participant to enrol in
multiple studies without matric collisions.
