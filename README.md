# Best Fingerings

Best Fingerings is a piano fingering web app. It accepts MusicXML or MXL scores, runs a deterministic cost-based fingering engine, renders the generated fingerings on the score, and lets users inspect, edit, lock, regenerate, preview on a keyboard, and export MusicXML.

## Current MVP Shape

- `/` is a polished public landing page.
- `/app` is the anonymous workspace.
- The default demo path uses `POST /fingerings/sync`, so local demos and hosted demos do not require AWS credentials.
- The original async AWS flow is still available through `POST /fingerings`, `/jobs`, and `/results` for later production-scale processing.
- PDF import, auth, saved projects, billing, and ML are intentionally out of scope for this demo milestone.

## Local Development

From Git Bash:

```bash
cd ~/best-fingerings
cp .env.example .env
source .venv/Scripts/activate
uvicorn app.main:app --reload --app-dir src
```

In a second Git Bash:

```bash
cd ~/best-fingerings/frontend
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173` for the landing page or `http://localhost:5173/app` for the workspace.

## Frontend Env

For local Vite development:

```bash
VITE_API_BASE=/api
VITE_FINGERINGS_MODE=sync
```

For Vercel:

```bash
VITE_API_BASE=https://<your-railway-api-url>
VITE_FINGERINGS_MODE=sync
```

Set the Vercel project root to `frontend`, build command to `npm run build`, and output directory to `dist`. `frontend/vercel.json` rewrites `/app` back to the SPA entry.

## Backend Env

For the sync demo endpoint:

```bash
CORS_ORIGINS=http://localhost:5173,https://<your-vercel-app>.vercel.app
DEMO_SYNC_MAX_UPLOAD_BYTES=20971520
DEMO_SYNC_MAX_EVENTS=5000
DEMO_SYNC_MAX_RUNTIME_SECONDS=30
```

For Railway, use this start command:

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT --app-dir src
```

The repository includes `railway.json` with that command.

## Async AWS Mode

The async production path is still present but not required for the demo. To use it, set:

```bash
S3_BUCKET=<bucket>
SQS_QUEUE_URL=<queue-url>
DDB_TABLE=<table>
AWS_REGION=us-east-2
```

Then set the frontend mode:

```bash
VITE_FINGERINGS_MODE=async
```

Run the worker separately:

```bash
source .venv/Scripts/activate
python -m app.worker
```

## Verification

Backend:

```bash
pytest
```

Frontend:

```bash
cd frontend
npm run lint
npm run build
```
