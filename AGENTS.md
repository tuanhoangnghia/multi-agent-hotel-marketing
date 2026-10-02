# AI Marketing Automation — Codebase Guide for Agents

This document helps AI coding agents understand the project structure, conventions, and how to work effectively with this codebase.

## Project Overview

**AI Marketing CHV** is a hotel marketing automation system that generates platform-specific content and videos. It consists of:

- **Google Apps Script** (`App Script/`) — Orchestrator: reads hotel data, runs 5 sequential agents (read → persona → brief → content → save), integrates with Claude, Facebook, Google Drive, and two external video services.
- **Video Agent Service** (`video-agent-service/`) — Python FastAPI (Cloud Run): analyzes hotel videos with Gemini, extracts descriptions, SRT subtitles, and edit scripts.
- **Video Render Service** (`video-render-service/`) — Python FastAPI (Cloud Run): FFmpeg-based video rendering with subtitle burning, music overlay, and clip editing.

### System Architecture

```
[Google Sheet] ← Users input hotel data and trigger pipeline
      ↓
[Apps Script Orchestrator] ← Coordinates 5 agents
   ├→ Claude (via Vertex AI) ← Content generation
   ├→ Google Drive ← Media access
   ├→ Facebook Graph API ← Draft post creation
   ├→ Video Agent Service (Cloud Run) ← Video analysis
   └→ Video Render Service (Cloud Run) ← Video rendering
```

## Component Details

### Apps Script (`App Script/`)

**What it does:**
- Runs on a Google Sheet trigger
- Reads hotel rows, runs 5 agents sequentially per hotel
- Never-throw philosophy: failures don't block pipeline (except video agent gating)
- Coordinates with external services (Claude, Drive, Facebook, Video Agent, Video Render)

**Key files:**
- [`Orchestrator.gs`](App%20Script/Orchestrator.gs) — Menu, pipeline dispatch, time budget (5 min to stay under 6 min limit)
- [`Agent1_ReadHotels.gs`](App%20Script/Agent1_ReadHotels.gs) — Read all hotel rows with `status != done`
- [`Agent2_BuyerPersona.gs`](App%20Script/Agent2_BuyerPersona.gs) — Call Claude to select buyer persona
- [`Agent3_CampaignBrief.gs`](App%20Script/Agent3_CampaignBrief.gs) — Call Claude to write campaign brief
- [`Agent4_PlatformContent.gs`](App%20Script/Agent4_PlatformContent.gs) — Call Claude to generate platform-specific content (Facebook, Zalo)
- [`Agent5_SaveResults.gs`](App%20Script/Agent5_SaveResults.gs) — Write all results back to sheet
- [`ClaudeClient.gs`](App%20Script/ClaudeClient.gs) — Vertex AI Model Garden integration with token caching and retry logic
- [`FacebookClient.gs`](App%20Script/FacebookClient.gs) — Facebook Graph API wrapper: upload images, create draft posts, cleanup orphaned images
- [`VideoRenderClient.gs`](App%20Script/VideoRenderClient.gs) — Video Render Service wrapper: submit render jobs, poll status
- [`VideoAgentClient.gs`](App%20Script/VideoAgentClient.gs) — Video Agent Service wrapper: submit analysis jobs, poll status, gate pipeline if needed
- [`DriveImagePicker.gs`](App%20Script/DriveImagePicker.gs) — Random image selection from Drive folders
- [`Config.gs`](App%20Script/Config.gs) — Read config from Script Properties (Vertex AI, Facebook, API tokens)
- [`Setup.gs`](App%20Script/Setup.gs) — UI prompts to set up Facebook, Video services, Vertex AI configs
- [`Rules.gs`](App%20Script/Rules.gs) — Read dynamic rules from "Rules" sheet (platform skills, persona/brief rules)
- [`Utils.gs`](App%20Script/Utils.gs) — Shared helpers: column management, hotel context building
- [`appsscript.json`](App%20Script/appsscript.json) — Runtime config (V8 engine, timezone)

**Running:** Apps Script runs via Google Sheet menu "🤖 AI Marketing" → "Chạy". Orchestrator.gs manages time and self-schedules continuation triggers.

**Configuration:** All credentials stored in Script Properties (no hardcoding):
- `VERTEX_SA_KEY_JSON` + `VERTEX_PROJECT_ID` — Vertex AI service account
- `FB_PAGE_ID` + `FB_PAGE_ACCESS_TOKEN` — Facebook Page
- `VIDEO_RENDER_API_TOKEN` — Video Render Service
- `VIDEO_AGENT_API_TOKEN` — Video Agent Service
- `SHEET_NAME`, `PLATFORMS`, `RULES_SHEET_NAME` — Optional overrides

**Key patterns:**
- **Never-throw principle:** Failures in Facebook/Video submission don't stop pipeline; status written to separate columns (`fb_post_status`, `video_render_status`)
- **Gating:** Video Agent results are required before pipeline continues (stored in `video_description`); `checkVideoAgentJobs` trigger auto-resumes pipeline after Gemini finishes
- **Hotel context:** Built from sheet row + optional `video_description` from Gemini (see `Utils.gs::buildHotelContextText_`)
- **Rules-driven:** Platform skills read from "Rules" sheet via `Rules.gs`, not hardcoded

**See also:** [ARCHITECTURE.md](docs/ARCHITECTURE.md) (Vietnamese) for detailed pipeline flow and data schema.

### Video Agent Service (`video-agent-service/`)

**What it does:**
- Analyzes all videos in a hotel's Drive folder using Gemini
- Generates: `video_description` (summary), `video_srt` (~30-60s subtitles), `video_edit_script` (clip cut list)
- Results written back to hotel's sheet row

**Tech stack:**
- Python 3.x, FastAPI
- Google Drive API (via `app/drive_client.py`)
- Gemini API (via `app/gemini_client.py`)
- Firestore (job state persistence)
- Cloud Tasks (optional async job queue)

**Workflow:**
1. Apps Script calls `/api/jobs` with `folder_id`, optional `bucket_name` for Drive upload
2. Service downloads all videos from folder, analyzes with Gemini, batches results
3. Apps Script polls `/api/jobs/{id}` until `status=succeeded`
4. Apps Script writes results to sheet and triggers pipeline continuation

**Build & run:**

```bash
cd video-agent-service
python -m venv .venv
.venv\Scripts\activate              # Windows
pip install -r requirements-dev.txt
cp .env.example .env                # Fill in secrets
uvicorn app.main:app --reload --port 8080
```

**Key files:**
- [`app/main.py`](video-agent-service/app/main.py) — FastAPI routes: POST `/api/jobs`, GET `/api/jobs/{id}`
- [`app/gemini_client.py`](video-agent-service/app/gemini_client.py) — Gemini integration
- [`app/drive_client.py`](video-agent-service/app/drive_client.py) — Google Drive API
- [`app/pipeline.py`](video-agent-service/app/pipeline.py) — Video analysis orchestration
- [`app/firestore_store.py`](video-agent-service/app/firestore_store.py) — Job state persistence
- [`scripts/get_refresh_token.py`](video-agent-service/scripts/get_refresh_token.py) — One-time OAuth setup for Drive
- [`.env.example`](video-agent-service/.env.example) — Config template

**Key environment variables:**
- `GEMINI_API_KEY` — Google AI Studio key or GCP API key
- `DRIVE_REFRESH_TOKEN` — From `get_refresh_token.py`
- `FIRESTORE_PROJECT_ID` — GCP project for job storage
- `CLOUD_TASKS_QUEUE` — (Optional) for async job queue

**Test:**

```bash
pytest tests/ -q
pytest tests/test_gemini_client.py -q  # Single test file
```

**See also:** [video-agent-service/README.md](video-agent-service/README.md) (Vietnamese) and [PLAN_video_agent_draft.md](docs/PLAN_video_agent_draft.md).

### Video Render Service (`video-render-service/`)

**What it does:**
- Receives hotel video folder (or individual file) + subtitles + music
- Uses FFmpeg to: cut/merge clips, burn subtitles with effects, overlay music, add text overlay
- Returns a single MP4 via Drive upload or streaming download

**Tech stack:**
- Python 3.x, FastAPI
- FFmpeg (subprocess-based, never `shell=True`)
- Google Drive API
- Single-instance Cloud Run (no database, job state in RAM, `/tmp` is tmpfs)

**Workflow:**
1. Apps Script calls POST `/api/jobs` with form data: `video_folder_url`, `clips`, `srt_text`, `intro_text`, `music_url`, `options`
2. Service downloads files, builds FFmpeg pipeline, renders video
3. Apps Script polls GET `/api/jobs/{id}` for progress
4. When done, results written back to sheet

**Build & run:**

```bash
cd video-render-service
python -m venv .venv
.venv\Scripts\activate              # Windows
pip install -r requirements.txt
cp .env.example .env                # Fill in secrets
make dev                            # uvicorn on :8080
make test                           # pytest
make build                          # docker build
```

**Key files:**
- [`app/main.py`](video-render-service/app/main.py) — FastAPI routes: POST `/api/jobs`, GET `/api/jobs/{id}`, DELETE, download
- [`app/jobs.py`](video-render-service/app/jobs.py) — Main pipeline orchestration
- [`app/ffmpeg_cmd.py`](video-render-service/app/ffmpeg_cmd.py) — Build FFmpeg argv (pure, testable)
- [`app/ffmpeg_runner.py`](video-render-service/app/ffmpeg_runner.py) — Execute FFmpeg, parse progress
- [`app/merge.py`](video-render-service/app/merge.py) — Clip cut/merge logic
- [`app/overlay.py`](video-render-service/app/overlay.py) — Subtitle and text overlay
- [`app/subtitles.py`](video-render-service/app/subtitles.py) — SRT parsing and `.ass` generation
- [`app/drive.py`](video-render-service/app/drive.py) — Google Drive operations
- [`docs/SPEC.md`](video-render-service/docs/SPEC.md) — **Source of truth** for API contract and options schema
- [`CLAUDE.md`](video-render-service/CLAUDE.md) — Detailed architecture (read this first for video rendering work)

**Key environment variables:**
- `GOOGLE_APPLICATION_CREDENTIALS` — Service account JSON file path
- `MAX_CONCURRENT_JOBS` — Semaphore limit (default 2)

**Architecture pattern:** **Pure builder vs I/O runner**
- Pure modules (no I/O, testable): `ffmpeg_cmd.py`, `probe_data.py`, `clips.py`, `subtitle_style.py`, etc.
- I/O wrappers: `ffmpeg_runner.py`, `jobs.py`, `drive.py`
- Always put decision logic in pure half; I/O half is thin wrapper.

**Key invariants:**
- **Never use `shell=True` or string interpolation for user paths** — Always use argv lists with `asyncio.create_subprocess_exec`
- **Coordinate system is pixels, not ASS virtual canvas** — `PlayResX/Y` set to actual output frame size
- **Font size follows video width** — `font_px = width × ratio`, not height (past bug)

**Test:**

```bash
pytest tests/ -q
pytest tests/test_ffmpeg_command.py -q  # Single test file
.venv\Scripts\pytest -k function_name   # By name
```

**See also:** [CLAUDE.md](video-render-service/CLAUDE.md) (detailed architecture) and [docs/SPEC.md](video-render-service/docs/SPEC.md) (API contract & options).

## Documentation Map

| Document | Purpose |
|----------|---------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, pipeline flow, data schema (Vietnamese) |
| [docs/GOLIVE.md](docs/GOLIVE.md) | Deployment & production checklist (Vietnamese) |
| [video-render-service/CLAUDE.md](video-render-service/CLAUDE.md) | Video Render detailed architecture & patterns |
| [video-render-service/docs/SPEC.md](video-render-service/docs/SPEC.md) | Video Render API contract, options schema, error codes |
| [PLAN_video_agent_draft.md](docs/PLAN_video_agent_draft.md) | Video Agent design & video-gating logic (Vietnamese) |
| [PLAN_vertex_ai_billing_draft.md](docs/PLAN_vertex_ai_billing_draft.md) | Claude/Vertex AI setup & billing (Vietnamese) |

## Common Tasks & Commands

### Setup new hotel
1. User enters hotel row in Sheet with required fields (name, price, drive folder for images, optional video folder)
2. Optional: First run with video folder → triggers Video Agent job, pipeline auto-resumes once Gemini finishes
3. Orchestrator runs Agents 1–5, submits Facebook draft & video render jobs, polls until completion

### Debug a single hotel row
- Open Sheet, find row, manually run `Orchestrator.gs::onOpen()` menu "Chạy" (triggers full pipeline)
- Check `status` column for errors (prefix `error: `)
- For Facebook: check `fb_post_status` column
- For video render: check `video_render_status` column
- Video Agent results: check `video_description`, `video_srt`, `video_edit_script` columns

### Update platform content rules
- Edit "Rules" sheet in same Google Sheet
- Platform skills in `Rule` sheet → read by `Rules.gs` → passed to Claude in Agent 4
- No code changes needed; `Rules.gs` reads dynamically

### Add a new platform (e.g., TikTok)
- Add row to "Rules" sheet with platform name & skill
- Add to `PLATFORMS` in Config (or add platform to "Rules" sheet default)
- Agent 4 auto-generates content for new platform from rules

### Deploy services to Cloud Run
- See [docs/GOLIVE.md](docs/GOLIVE.md) for detailed steps
- Video Agent: `gcloud run deploy video-agent-service --source . --region us-central1 ...`
- Video Render: `gcloud run deploy video-render-service --source . --region us-central1 ...`

### Test locally
- Apps Script: No local test; open Sheet and use menu
- Video Agent: `make dev`, then POST to `http://localhost:8080/api/jobs`
- Video Render: `make dev`, then POST/GET to `http://localhost:8080/api/jobs`

## Code Conventions

### Language
- **Comments, commit messages, documentation:** Vietnamese (matching existing docs)
- **Identifiers:** English (variable names, function names, class names)
- **Code strings (error messages, API responses):** Vietnamese to match user context

### Python (Video services)
- Use `asyncio` for I/O; never blocking calls in async functions
- Test with pytest; use `@pytest.mark.asyncio` or set `asyncio_mode = auto` in `pytest.ini`
- Pure logic modules (no I/O) should be easily unit-testable; keep I/O in separate thin wrappers
- Never use `shell=True` or string interpolation for subprocess; use argv lists
- Use type hints (`from typing import ...`)
- Follow PEP 8

### Google Apps Script (JavaScript)
- Use `var` for function scope; newer code uses `const`/`let`
- Prefix private functions with `_` (e.g., `getFacebookPageId_()`)
- Always check Script Properties exist; fail fast with descriptive error messages
- Wrap API calls in try-catch; provide fallback or clear error message
- Never put secrets in code; use PropertiesService

## Common Pitfalls & How to Avoid Them

1. **Video Render crashes on user input paths**
   - Always validate file paths; never interpolate into FFmpeg argv
   - Use `asyncio.create_subprocess_exec` with list, never `shell=True`

2. **Apps Script hits 6-minute timeout**
   - Orchestrator has `MAX_RUNTIME_MS = 5 * 60 * 1000` buffer
   - Pipeline auto-schedules continuation triggers if not done in time
   - Check `Orchestrator.gs` for time-budget logic

3. **Facebook draft fails silently**
   - `FacebookClient.gs` has never-throw pattern; check `fb_post_status` column for error
   - Common: Drive folder not shared with service account, or image picker found no images

4. **Video Agent job submitted but Apps Script doesn't poll**
   - Make sure Video Agent API token is set in Script Properties
   - Check `checkVideoAgentJobs` trigger is installed (from first run of Setup)
   - Manually trigger `Orchestrator.gs::checkVideoAgentJobs()` from Script Editor

5. **"video_drive_url not supported" error**
   - Old API: single video file upload, now deprecated
   - Use `video_folder_url` (Drive folder) instead; Video Render downloads from Drive directly

6. **Subtitle rendering looks wrong (size, position, colors)**
   - Check `docs/SPEC.md` §4 (Subtitle options); understand pixel vs ASS virtual coords
   - Font size tied to **video width**, not height (past bug)
   - See `video-render-service/CLAUDE.md` for subtitle pipeline details

## Quick Reference: File Entry Points

- **User trigger:** `Orchestrator.gs::onOpen()` → menu "🤖 AI Marketing" → "Chạy"
- **Setup/config:** `Setup.gs` + `Config.gs`
- **Pipeline orchestration:** `Orchestrator.gs::runMarketingPipelineForSheet()` → loop over hotels → `processHotelRow_()` → Agents 1–5
- **Video Agent status polling:** `Orchestrator.gs::checkVideoAgentJobs()` (trigger every ~1 min)
- **Video Render status polling:** `Orchestrator.gs::checkVideoRenderJobs()` (trigger every ~1 min)
- **Video Render API docs:** `video-render-service/docs/SPEC.md`

## When to Link vs. Reference Existing Docs

- **Link to SPEC.md:** When a behavior or option needs clarification (e.g., subtitle sizing, error codes)
- **Link to CLAUDE.md:** When explaining Video Render architecture or FFmpeg pipeline
- **Link to ARCHITECTURE.md:** When explaining overall system flow or video-gating logic
- **Inline explanation:** Only for immediate, concise facts; defer to docs for details

---

**Last updated:** 2026-09-02  
**Language notes:** Vietnamese prose (documentation, comments); English identifiers; follow existing file conventions.
