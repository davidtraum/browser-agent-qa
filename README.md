# Browser Agent Test Runner

Minimal local setup for running Shopware Administration QA tasks through a Node.js API and a Python browser-use worker.

## Stack

- Node.js + TypeScript API with Express
- BullMQ + Redis for queueing
- Python worker using browser-use and Playwright
- OpenAI for agent reasoning
- GitHub issue ingestion for AI-generated Shopware Administration test plans
- Shopware branch provisioning from `shopware/shopware`
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

## What It Does

- Accepts a GitHub issue URL from `shopware/shopware`
- Lets you choose a Shopware branch, defaulting to `trunk`
- Checks out that branch locally
- Starts Shopware with the upstream Docker setup
- Runs `composer setup`
- Starts the Administration watcher with `composer watch:admin`
- Uses the watched Administration as the browser target for the autonomous QA agent

## Prerequisites

- Node.js 20+
- Python 3.11+
- Docker and Docker Compose
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

Important for local backend execution:

- The backend provisions Shopware branches by calling `git` and `docker compose`.
- That means Docker must be available on the machine where the backend is running.
- By default the backend expects the watched Administration at `http://localhost:5173`.

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
Docker also mounts the host Docker socket into the `app` container so the backend can provision Shopware branches with Docker Compose.

The API is then reachable at `http://localhost:3000`.

Important for Shopware provisioning inside Docker:

- The service checks out Shopware branches into `/tmp/browser-agent-shopware`.
- That path is bind-mounted identically on the host and in the container, which is required because the app talks to the host Docker daemon through `/var/run/docker.sock`.
- The watched Administration is expected at `http://host.docker.internal:5173` inside the containerized worker.
- `docker-compose.yml` already maps `host.docker.internal` to the Docker host.

## API

### `POST /run-test`

Request:

```json
{
  "branch": "trunk",
  "task": "Log into the Shopware Administration, open the profile page, change the timezone, save it, and verify that the new timezone persists."
}
```

Response:

```json
{
  "jobId": "123",
  "status": "queued",
  "branch": "trunk",
  "adminUrl": "http://localhost:5173"
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

### `POST /run-test-from-issue/stream`

Starts an issue-based run and streams newline-delimited JSON events for:

- issue loading
- plan generation
- Shopware branch provisioning
- queueing
- live browser execution progress
- final result

Example:

```bash
curl -N -X POST http://localhost:3000/run-test-from-issue/stream \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/x-ndjson' \
  -d '{
    "issueUrl": "https://github.com/shopware/shopware/issues/15805",
    "branch": "trunk"
  }'
```

### `POST /run-test-from-issue`

Creates a Shopware Administration test job from a GitHub issue URL plus an optional Shopware branch.

Request:

```json
{
  "issueUrl": "https://github.com/shopware/shopware/issues/15805",
  "branch": "trunk"
}
```

Response:

```json
{
  "jobId": "124",
  "status": "queued",
  "branch": "trunk",
  "adminUrl": "http://localhost:5173",
  "issue": {
    "url": "https://github.com/shopware/shopware/issues/15805",
    "title": "Wrong e-mail validation endpoint path in the administration prevents saving the profile",
    "repository": "shopware/shopware",
    "number": 15805
  },
  "generatedTask": "Open the Shopware Administration, log in with admin / shopware if necessary, follow the profile saving flow described in the issue, and verify through DOM and visual checks that the invalid e-mail validation error does not appear.",
  "generatedSteps": [
    "Log into the Shopware Administration.",
    "Navigate to the profile page in the administration.",
    "Perform the settings change described by the issue.",
    "Save the profile.",
    "Verify that no invalid e-mail error appears and the change persists."
  ],
  "summary": "Validate the profile save flow in the Shopware Administration on the selected branch."
}
```

### `GET /shopware/branches`

Lists branches from `shopware/shopware` for the branch selector.

Optional query parameter:

- `q`: substring filter

Example:

```bash
curl "http://localhost:3000/shopware/branches?q=trunk"
```

### `GET /tasks`

Lists queued, active, and recent finished tasks.

Example:

```bash
curl "http://localhost:3000/tasks?limit=20"
```

### `POST /tasks/:id/stop`

- Removes waiting tasks from the queue
- Requests cancellation for active tasks
- Removes finished tasks from the recent list

Example:

```bash
curl -X POST http://localhost:3000/tasks/123/stop
```

### `POST /tasks/clear-finished`

Removes all finished tasks from the recent task list.

Example:

```bash
curl -X POST http://localhost:3000/tasks/clear-finished
```

## Example curl

Queue a test:

```bash
curl -X POST http://localhost:3000/run-test \
  -H 'Content-Type: application/json' \
  -d '{
    "branch": "trunk",
    "task": "Log into the Shopware Administration, change the timezone in the profile, save it, and verify that the value persists."
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
    "issueUrl": "https://github.com/shopware/shopware/issues/15805",
    "branch": "trunk"
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
  --issueUrl https://github.com/shopware/shopware/issues/15805 \
  --serviceUrl http://localhost:3000
```

Run a test and keep polling until it finishes:

```bash
run-test \
  --issueUrl https://github.com/shopware/shopware/issues/15805 \
  --serviceUrl http://localhost:3000 \
  --branch trunk \
  --poll
```

Fetch the status of an existing test:

```bash
test-status \
  --serviceUrl http://localhost:3000 \
  --testId 42
```

List queued and running tasks:

```bash
test-tasks \
  --serviceUrl http://localhost:3000 \
  --limit 20
```

Stop or remove a task:

```bash
stop-test \
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

Example:

```env
BROWSER_AGENT_SERVICE_URL=http://localhost:3000
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

`VITE_UI_BACKEND_URL` is optional. If it is empty, the Vite dev server proxies `/api` to `http://localhost:4000`.

Example:

```env
VITE_UI_BACKEND_URL=
```

### Start the Vue frontend

```bash
cd ui/frontend
npm install
npm run dev
```

The Vue app runs on `http://localhost:5174`.

In local development, the recommended setup is:

- Next.js UI backend on `http://localhost:4000`
- Vue frontend on `http://localhost:5174`
- Vite proxying `/api` requests to the UI backend

The UI backend also returns CORS headers for `/api`, so direct cross-origin calls still work if you explicitly set `VITE_UI_BACKEND_URL`.

### UI flow

- Paste a GitHub issue URL into the large input field
- Select a Shopware branch, defaulting to `trunk`
- Press `Enter`
- The Vue app streams a live feed from the Next.js backend
- The Next.js backend loads Shopware branches from the browser-agent service
- The browser-agent service checks out the selected `shopware/shopware` branch, starts Shopware via Docker Compose, runs `composer setup`, starts `composer watch:admin`, and then executes the issue-driven QA run
- The UI sidebar shows pending, preparing, running, and recent finished tasks
- You can switch between tasks, stop tasks, remove individual finished tasks, or clear all finished tasks at once
- Browser execution messages include per-step screenshots with a larger preview on click

## Notes

- Jobs are queued in BullMQ under `browser-tests`.
- Each job is capped at 20 agent steps.
- Each job times out after 300 seconds by default.
- Queue retries are configured for 2 retries after the initial attempt.
- The worker returns structured JSON with `success`, `summary`, `steps`, and `logs`.
- Shopware provisioning is based on the upstream `shopware/shopware` Docker workflow documented in `CONTRIBUTING.md`, including `docker compose up -d`, `composer setup`, and `composer watch:admin`.
- `browser-use` requires Python 3.11+, so installation will fail on older Python versions such as 3.9.
- For private GitHub repositories, set `GITHUB_TOKEN` in `.env` so the backend can fetch issue content.
- The Docker image is based on Playwright's official Python image, which already includes browser binaries and system dependencies for Chromium.
- In Docker, Redis and BullMQ queue settings are injected by `docker-compose.yml`, not by `.env`.
