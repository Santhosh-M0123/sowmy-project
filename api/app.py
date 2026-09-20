"""
Local Flask API + static file server for the college voice-agent dashboard.

No database, no auth, no ORM — everything lives on the file system:
  agent/system_prompt.md   the agent's only configuration
  telephone_line.json      the one telephony line's metadata
  call_log/*.json          one file per completed call

Run:  python api/app.py
Serves the dashboard (web/) and the JSON API on the same port (default 8000).
"""

import json
import os
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
PROMPT_FILE = BASE_DIR / "agent" / "system_prompt.md"
TELEPHONE_LINE_FILE = BASE_DIR / "telephone_line.json"
CALL_LOG_DIR = BASE_DIR / "call_log"
WEB_DIR = BASE_DIR / "web"

CALL_LOG_DIR.mkdir(exist_ok=True)

DEFAULT_PROMPT = "You are a helpful voice assistant answering phone calls."
DEFAULT_TELEPHONE_LINE = {
    "phone_number": "",
    "sip_trunk_id": "",
    "agent_name": os.getenv("AGENT_NAME", "college-voice-agent"),
    "status": "unassigned",
    "notes": "Buy the number and attach the agent in the LiveKit Cloud "
    "dashboard, then fill this in here so the UI can show it.",
    "updated_at": None,
}

app = Flask(__name__, static_folder=None)
CORS(app)


# ---------------------------------------------------------------- helpers --

def _read_json(path: Path, default: dict) -> dict:
    if not path.exists():
        path.write_text(json.dumps(default, indent=2), encoding="utf-8")
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _list_call_logs(include_transcripts: bool = True) -> list[dict]:
    logs = []
    for f in CALL_LOG_DIR.glob("*.json"):
        try:
            entry = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not include_transcripts:
            entry = {k: v for k, v in entry.items() if k != "transcripts"}
        logs.append(entry | {"_file": f.name})
    # filenames are timestamp-prefixed, so this also sorts by call order
    logs.sort(key=lambda entry: entry.get("_file", ""), reverse=True)
    return logs


# -------------------------------------------------------------- static UI --

@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    return send_from_directory(WEB_DIR, filename)


# ------------------------------------------------------------- system prompt

@app.get("/api/system-prompt")
def get_system_prompt():
    if not PROMPT_FILE.exists():
        PROMPT_FILE.write_text(DEFAULT_PROMPT, encoding="utf-8")
    return jsonify({
        "content": PROMPT_FILE.read_text(encoding="utf-8"),
        "updated_at": datetime.fromtimestamp(PROMPT_FILE.stat().st_mtime).isoformat(),
    })


@app.put("/api/system-prompt")
def update_system_prompt():
    body = request.get_json(silent=True) or {}
    content = body.get("content")
    if not isinstance(content, str) or not content.strip():
        return jsonify({"error": "Body must include a non-empty 'content' string."}), 400
    PROMPT_FILE.write_text(content, encoding="utf-8")
    return jsonify({"ok": True, "content": content})


# ------------------------------------------------------------------ agent --

@app.get("/api/agent")
def get_agent():
    prompt = PROMPT_FILE.read_text(encoding="utf-8") if PROMPT_FILE.exists() else DEFAULT_PROMPT
    return jsonify({
        "agent_name": os.getenv("AGENT_NAME", "college-voice-agent"),
        "system_prompt_preview": prompt.strip()[:280],
        "system_prompt_updated_at": (
            datetime.fromtimestamp(PROMPT_FILE.stat().st_mtime).isoformat()
            if PROMPT_FILE.exists() else None
        ),
    })


# ------------------------------------------------------------ telephony line

@app.get("/api/telephone-line")
def get_telephone_line():
    return jsonify(_read_json(TELEPHONE_LINE_FILE, DEFAULT_TELEPHONE_LINE))


@app.put("/api/telephone-line")
def update_telephone_line():
    body = request.get_json(silent=True) or {}
    current = _read_json(TELEPHONE_LINE_FILE, DEFAULT_TELEPHONE_LINE)
    for key in ("phone_number", "sip_trunk_id", "agent_name", "status", "notes"):
        if key in body:
            current[key] = body[key]
    current["updated_at"] = datetime.utcnow().isoformat()
    _write_json(TELEPHONE_LINE_FILE, current)
    return jsonify(current)


# --------------------------------------------------------------- call logs --

@app.get("/api/call-logs")
def list_call_logs():
    # Transcripts are left out here to keep the list lightweight; fetch a
    # single call's full record (or just its transcript) on demand below.
    return jsonify(_list_call_logs(include_transcripts=False))


@app.get("/api/call-logs/<path:filename>")
def get_call_log(filename):
    path = CALL_LOG_DIR / filename
    if not path.is_file() or path.suffix != ".json" or path.parent != CALL_LOG_DIR:
        return jsonify({"error": "not found"}), 404
    return jsonify(json.loads(path.read_text(encoding="utf-8")))


@app.get("/api/call-logs/<path:filename>/transcript")
def get_call_log_transcript(filename):
    path = CALL_LOG_DIR / filename
    if not path.is_file() or path.suffix != ".json" or path.parent != CALL_LOG_DIR:
        return jsonify({"error": "not found"}), 404
    entry = json.loads(path.read_text(encoding="utf-8"))
    return jsonify({
        "call_id": entry.get("call_id"),
        "transcripts": entry.get("transcripts", []),
    })


# --------------------------------------------------------- dashboard summary

@app.get("/api/dashboard/summary")
def dashboard_summary():
    logs = _list_call_logs(include_transcripts=False)
    today = datetime.utcnow().date().isoformat()
    calls_today = sum(1 for entry in logs if str(entry.get("started_at", "")).startswith(today))
    line = _read_json(TELEPHONE_LINE_FILE, DEFAULT_TELEPHONE_LINE)
    return jsonify({
        "total_calls": len(logs),
        "calls_today": calls_today,
        "latest_calls": logs[:5],
        "telephone_line_status": line.get("status", "unassigned"),
        "agent_name": os.getenv("AGENT_NAME", "college-voice-agent"),
    })


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=True)
