# Browser Agent Test Runner

Minimal local setup for running browser-based QA tasks through a Node.js API and a Python browser-use worker.

## Stack

- Node.js + TypeScript API with Express
- BullMQ + Redis for queueing
- Python worker using browser-use and Playwright
- OpenAI for agent reasoning
- Optional GitHub issue ingestion for AI-generated test plans
- Optional single Docker image that runs backend and worker together

## Project Layout

```text
backend/
  src/
    api/
    queue/
    types/
cli/
  src/
    bin/
ui/
  backend/
  frontend/
worker/
  worker.py
  requirements.txt
```

## Prerequisites

- Node.js 20+
- Python 3.11+
- Redis 6.2+ or Docker
- An `OPENAI_API_KEY`

## Setup

1. Create the environment file:

```bash
cp .env.example .env
```

2. Start Redis:

```bash
docker compose up -d redis
```

3. Install backend dependencies:

```bash
cd backend
npm install
```

4. Install Python dependencies:

```bash
cd ../worker
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m playwright install chromium
```

5. Start the API:

```bash
cd ../backend
npm run dev
```

6. Start the worker in another terminal:

```bash
cd worker
source .venv/bin/activate
python worker.py
```

## Docker

You can also run the backend and Python worker inside one Docker image.

1. Create the environment file:

```bash
cp .env.example .env
```

2. Set at least these values in `.env`:

```env
OPENAI_API_KEY=your_openai_api_key
PORT=3000
```

3. Build and start the full stack:

```bash
docker compose up --build
```

This starts:

- `app`: backend API plus Python worker in one container
- `redis`: BullMQ storage and broker

Docker sets `REDIS_URL` and `QUEUE_NAME` internally, so they do not need to be present in `.env`.

The API is then reachable at `http://localhost:3000`.

Important for local target apps:

- If the application under test runs on your host machine, do not use `http://localhost:5000` from inside the containerized worker.
- Use `http://host.docker.internal:5000` instead.
- `docker-compose.yml` already maps `host.docker.internal` to the Docker host.

## API

### `POST /run-test`

Request:

```json
{
  "url": "http://localhost:5000",
  "task": "Open the dashboard, login if necessary using test/admin, navigate to the user profile and check if the profile image is visible"
}
```

Response:

```json
{
  "jobId": "123",
  "status": "queued"
}
```

### `GET /run-test/:id`

Response:

```json
{
  "jobId": "123",
  "status": "completed",
  "attemptsMade": 1,
  "result": {
    "success": true,
    "summary": "The profile image is visible on the user profile page.",
    "steps": [
      "Step 1: ...",
      "Step 2: ..."
    ],
    "logs": [
      "Starting step 1",
      "Completed step 1 ..."
    ]
  }
}
```

### `POST /run-test-from-issue`

Creates a test job from a GitHub issue URL plus the app URL to test.

Request:

```json
{
  "url": "http://localhost:5000",
  "issueUrl": "https://github.com/acme/app/issues/123"
}
```

Response:

```json
{
  "jobId": "124",
  "status": "queued",
  "issue": {
    "url": "https://github.com/acme/app/issues/123",
    "title": "Profile avatar is not visible after upload",
    "repository": "acme/app",
    "number": 123
  },
  "generatedTask": "Open the app at http://localhost:5000, navigate to the profile avatar flow, upload or inspect the avatar state described in the issue, and verify whether the avatar is visible using page structure and visual confirmation.",
  "generatedSteps": [
    "Open the application and sign in if the profile area requires authentication.",
    "Navigate to the user profile page mentioned by the issue.",
    "Perform the user action described in the issue that should display the avatar.",
    "Check the DOM for the profile image element or image container.",
    "Visually confirm that the avatar is rendered and not hidden or broken."
  ],
  "summary": "Validate that the profile avatar is visible after the flow described in the issue."
}
```

## Example curl

Queue a test:

```bash
curl -X POST http://localhost:3000/run-test \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "http://host.docker.internal:5000",
    "task": "Open the dashboard, login if necessary using test/admin, navigate to the user profile and check if the profile image is visible"
  }'
```

Check status:

```bash
curl http://localhost:3000/run-test/<jobId>
```

Queue a test from a GitHub issue:

```bash
curl -X POST http://localhost:3000/run-test-from-issue \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "http://host.docker.internal:5000",
    "issueUrl": "https://github.com/acme/app/issues/123"
  }'
```

## CLI

The CLI now lives in its own package under `cli/`.

Build the CLI:

```bash
cd cli
npm install
npm run build
```

Optional: link the binaries globally on your machine:

```bash
npm link
```

Run a test from a GitHub issue:

```bash
run-test \
  --issueUrl https://github.com/acme/app/issues/123 \
  --url http://localhost:5000 \
  --serviceUrl http://localhost:3000
```

Run a test and keep polling until it finishes:

```bash
run-test \
  --issueUrl https://github.com/acme/app/issues/123 \
  --url http://localhost:5000 \
  --serviceUrl http://localhost:3000 \
  --poll
```

Fetch the status of an existing test:

```bash
test-status \
  --serviceUrl http://localhost:3000 \
  --testId 42
```

## UI

The web UI now lives in `ui/` and is split into:

- `ui/backend`: Next.js + TypeScript backend for frontend-facing API routes
- `ui/frontend`: Vue 3 + TypeScript app for the live issue feed

### UI backend config

Copy the backend env example:

```bash
cd ui/backend
cp .env.example .env.local
```

Key values:

- `BROWSER_AGENT_SERVICE_URL`: URL of the existing Docker/browser-agent service
- `TARGET_APP_URL`: the application under test that the worker should open

Example:

```env
BROWSER_AGENT_SERVICE_URL=http://localhost:3000
TARGET_APP_URL=http://host.docker.internal:5173
PORT=4000
```

### Start the UI backend

```bash
cd ui/backend
npm install
npm run dev
```

The Next.js API backend runs on `http://localhost:4000`.

### Frontend config

Copy the frontend env example:

```bash
cd ui/frontend
cp .env.example .env
```

Example:

```env
VITE_UI_BACKEND_URL=http://localhost:4000
```

### Start the Vue frontend

```bash
cd ui/frontend
npm install
npm run dev
```

The Vue app runs on `http://localhost:5174`.

### UI flow

- Paste a GitHub issue URL into the large input field
- Press `Enter`
- The Vue app streams a live feed from the Next.js backend
- The Next.js backend forwards the request to the browser-agent Docker service and polls the job until completion

## Notes

- Jobs are queued in BullMQ under `browser-tests`.
- Each job is capped at 20 agent steps.
- Each job times out after 120 seconds.
- Queue retries are configured for 2 retries after the initial attempt.
- The worker returns structured JSON with `success`, `summary`, `steps`, and `logs`.
- `browser-use` requires Python 3.11+, so installation will fail on older Python versions such as 3.9.
- For private GitHub repositories, set `GITHUB_TOKEN` in `.env` so the backend can fetch issue content.
- The Docker image is based on Playwright's official Python image, which already includes browser binaries and system dependencies for Chromium.
- In Docker, Redis and BullMQ queue settings are injected by `docker-compose.yml`, not by `.env`.
