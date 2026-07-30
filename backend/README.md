# ScanWise API

REST API that powers the ScanWise mobile app: product database, OCR pipeline, and the recommendation engine that ranks alternatives against user goals (lower sugar, higher protein, budget-friendly, etc.).

## Run locally

```bash
npm install
npm start
# Server listens on http://localhost:3001
```

The first boot creates `scanwise.db` next to `server.js` and seeds it from `../data/seed-data.json` (201 kid-friendly products across 5 categories).

## Endpoints

| Method | Path                          | Purpose                                       |
|--------|-------------------------------|-----------------------------------------------|
| GET    | `/api/health`                 | Liveness check + counts                       |
| GET    | `/api/stats`                  | Aggregate stats for the KPI dashboard         |
| GET    | `/api/goals`                  | Available user goals with weights             |
| GET    | `/api/products/:barcode`      | Full product record by barcode                |
| POST   | `/api/scans`                  | Log a scan + look up by barcode (or OCR)      |
| GET    | `/api/alternatives/:barcode`  | Top 3 alternatives ranked by user goals       |
| POST   | `/api/corrections`            | Submit a nutrition correction                 |

## Configuration

Set via environment variables (see `.env.example`):

| Var              | Default              | Notes                                   |
|------------------|----------------------|-----------------------------------------|
| `PORT`           | `3001`               | Server port                             |
| `HOST`           | `0.0.0.0`            | Bind address                            |
| `DB_PATH`        | `./scanwise.db`      | SQLite file location                    |
| `ALLOWED_ORIGINS`| `*`                  | Comma-separated CORS origin allowlist   |

## Deploy

The repo includes a `Dockerfile` and a `render.yaml` for one-click deploy on Render.

1. Push this repo to GitHub.
2. In Render, click **New + → Blueprint**, point at the repo.
3. Render reads `render.yaml`, creates the web service + a 1 GB persistent disk for the SQLite DB, and gives you a public URL.

Then update the mobile app's `API_BASE_URL` in `src/utils/constants.js` to the new `*.onrender.com` URL.
