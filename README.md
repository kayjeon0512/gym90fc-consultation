<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/1a77a87e-039f-4e2d-af16-d960b344997e

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies: `npm install`
2. Create `.env` in the project root (see [.env.example](.env.example)):
   `cp .env.example .env` then set `GEMINI_API_KEY=` to your key from [Google AI Studio](https://aistudio.google.com/apikey).
3. Run the app: `npm run dev` (restart after changing `.env`).

Verify the key without printing it: `npm run check:gemini`

## Deploy (Firebase Hosting + GitHub Actions)

Pushes to `main` / `master` deploy automatically. You can also run the workflow manually (**Actions → Deploy to Firebase Hosting → Run workflow**).

**Repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|--------|---------|
| `GEMINI_API_KEY` | Baked into the production bundle for AI text generation |
| `FIREBASE_SERVICE_ACCOUNT` | JSON key for Firebase deploy (Hosting) |

Without `GEMINI_API_KEY`, the deploy workflow **fails at the check step** so the live site is not missing AI by mistake.

**Local deploy** (after `.env` has your key): `npm run deploy`
