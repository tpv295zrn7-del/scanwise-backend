# Deploying the ScanWise API

The backend is in `/home/team/shared/backend/` and is now a self-contained git repo. It has everything you need to one-click deploy on Render.

## What you'll do (5–10 minutes total)

1. Push the backend to a new GitHub repo
2. Sign up for a free Render account
3. Create a new Blueprint service pointing at the new repo
4. Wait ~3 minutes for the first deploy
5. Update the mobile app's `API_BASE_URL` to the new public URL

## Step 1 — Push the backend to GitHub

In your terminal:

```bash
cd /home/team/shared/backend

# Create a new empty repo on GitHub first (github.com/new).
# Use the name "scanwise-backend", public, no README/license/.gitignore.

# Then add it as a remote and push:
git remote add origin git@github.com:YOUR_USERNAME/scanwise-backend.git
git push -u origin master
```

## Step 2 — Sign up for Render

Go to https://render.com and sign up with your GitHub account. Free tier is enough.

## Step 3 — Create the service

In Render:
- Click **New + → Blueprint**
- Point it at your new `scanwise-backend` repo
- Render will detect `render.yaml` and show the service plan
- Click **Apply**
- Wait for the first build + deploy (~3 minutes)

## Step 4 — Grab the public URL

Once the deploy is green, Render shows you a URL like:

```
https://scanwise-api.onrender.com
```

Test it:

```bash
curl https://scanwise-api.onrender.com/api/health
# {"status":"ok","products":201,"scans":0,"corrections":0,"uptime_seconds":42}
```

## Step 5 — Point the mobile app at the new URL

In `/tmp/Scanwise-mobile/src/utils/constants.js`, change:

```js
export const API_BASE_URL = 'https://scanwise-api.onrender.com';
```

Commit, push, and pull on your Mac as usual. The iPhone will start calling the deployed backend on the next reload.

## What works after deploy

- ✅ Compare / alternatives — the recommendation engine is already live
- ✅ Saved items sync to the backend (currently the mobile app keeps them locally in AsyncStorage only)
- ✅ Corrections submitted to the backend
- ✅ `/api/health` and `/api/stats` for monitoring

## What still needs a paid plan (later)

The free Render tier sleeps after 15 minutes of inactivity. The first request after a sleep takes ~30 seconds to wake up. When the app is in active use this is invisible; for demos to people who aren't scanning right now, the cold start is noticeable. Upgrade to Render's $7/month plan when the first paying user is on board.

## Costs right now

- GitHub repo: free
- Render free tier: $0
- Total: $0

## What you'll need from me (the team)

Once the deploy is live, ping me with the URL. I'll:
- Update the mobile app's `API_BASE_URL`
- Wire up the remaining KPI tracking (compare_started, alternatives_viewed)
- Build a tiny dashboard from `/api/stats` so you can see scans, saves, and corrections in real time
