# College Voice Agent

A minimal, no-database LiveKit voice agent for a college phone helpdesk, plus
a plain HTML/JS/CSS dashboard to manage it. Everything lives on the file
system — no SQL, no ORM, no auth.

## Layout

```
agent/
  agent.py            LiveKit worker: the single "flow" agent, no tools
  system_prompt.md     the agent's ONLY configuration (edit this or via API)
api/
  app.py               Flask API + serves web/ as static files
web/
  index.html, style.css, app.js    the 3-file dashboard (Dashboard / Agents / Call Logs / Telephony Line)
call_log/
  *.json               one file per completed call, filename timestamp-sorted
telephone_line.json     metadata for the one phone line you attach in LiveKit Cloud
requirements.txt
.env.example
```

## Setup (once)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# fill in LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
```

LiveKit Inference (used for STT/LLM/TTS by default — `inference.STT` /
`inference.LLM` / `inference.TTS` in `agent/agent.py`) just needs your
LiveKit Cloud credentials; no separate OpenAI/Cartesia keys required. Swap in
`livekit.plugins.openai` / `.deepgram` / etc. instead if you'd rather bring
your own provider keys.

## Run (two processes)

**1. Dashboard + API** (serves the UI and the file-system API on :8000):

```bash
python api/app.py
```

Open http://localhost:8000 — Dashboard, Agents (edit `system_prompt.md`
live), Call Logs, Telephony Line.

**2. The agent worker** (connects to LiveKit Cloud and waits for jobs):

```bash
python agent/agent.py dev
```

The two processes don't talk to each other over the network — they share
state purely through the files in this repo (`system_prompt.md`,
`telephone_line.json`, `call_log/`). Run them on the same machine, or point
both at the same checked-out repo.

## Wiring up the phone line

1. Buy a phone number in the LiveKit Cloud dashboard and create/attach a SIP
   trunk to it.
2. Dispatch your agent (`AGENT_NAME` in `.env`, `college-voice-agent` by
   default) to that trunk/number from the LiveKit Cloud dashboard — this
   project doesn't automate that step.
3. Fill in the **Telephony Line** tab in the dashboard (or `PUT
   /api/telephone-line`) with the number, trunk ID, and status, purely so the
   UI has something to show — LiveKit itself doesn't read this file.

## Call recording (optional)

If `S3_BUCKET` (+ `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`)
are set in `.env`, the agent starts an audio-only room-composite egress to
that bucket at the start of each call and records the resulting `s3://...`
URL in the call's log entry. Leave `S3_BUCKET` blank to skip recording
entirely — the call still gets logged, just without a recording link.

## API reference

| Method | Path                          | Purpose                                  |
|--------|-------------------------------|-------------------------------------------|
| GET    | `/api/system-prompt`          | Read `system_prompt.md`                   |
| PUT    | `/api/system-prompt`          | Overwrite it — body `{ "content": "..." }`|
| GET    | `/api/agent`                  | Agent name + prompt preview               |
| GET    | `/api/telephone-line`         | Read `telephone_line.json`                |
| PUT    | `/api/telephone-line`         | Update it (partial body OK)               |
| GET    | `/api/call-logs`              | List all call logs, newest first          |
| GET    | `/api/call-logs/<filename>`   | One call's full log entry                 |
| GET    | `/api/dashboard/summary`      | Counts + last 5 calls for the Dashboard tab|

## Notes / deliberate simplifications

- No auth anywhere — this is a local/college-project dashboard, not
  production-hardened.
- No database: `system_prompt.md`, `telephone_line.json`, and one JSON file
  per call in `call_log/` are the entire persistence layer.
- The agent has no tools/function-calling — it's a single `Agent` whose
  `instructions` come from `system_prompt.md`, re-read at the start of every
  call so edits apply without restarting the worker.
- `call_log/` entries are written once, at the end of the call (on the
  worker's shutdown callback), so a partial write never shows up mid-call.
