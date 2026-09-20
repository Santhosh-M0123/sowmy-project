"""
Local Flask API + static file server for the college voice-agent dashboard.

No database, no auth, no ORM. Config lives on the local file system:
  agent/system_prompt.md   the agent's only configuration
  telephone_line.json      the one telephony line's metadata

Call records (metadata + transcript) live in S3, under calls/ in the same
bucket as recordings, written there by agent/agent.py when a call ends — this
API lists/reads them straight from S3 (matching agent.py's storage) when
S3_BUCKET is set, falling back to call_log/*.json on local disk only for
local dev without AWS configured.

Run:  python api/app.py
Serves the dashboard (web/) and the JSON API on the same port (default 8000).
"""

import json
import os
from datetime import datetime
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
PROMPT_FILE = BASE_DIR / "agent" / "system_prompt.md"
TELEPHONE_LINE_FILE = BASE_DIR / "telephone_line.json"
CALL_LOG_DIR = BASE_DIR / "call_log"
WEB_DIR = BASE_DIR / "web"

AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
S3_BUCKET = os.getenv("S3_BUCKET")
CALLS_S3_PREFIX = "calls/"
RECORDING_URL_EXPIRES_IN = 900  # 15 minutes

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


def _presigned_recording_url(s3_uri: str | None, expires_in: int = RECORDING_URL_EXPIRES_IN) -> str | None:
    """Turn an ``s3://bucket/key`` recording URI into a short-lived, signed HTTPS
    URL. Recordings are phone-call audio, so the bucket is kept private rather
    than made publicly readable; this generates access on demand instead.
    """
    if not s3_uri or not s3_uri.startswith("s3://"):
        return None
    bucket, _, key = s3_uri.removeprefix("s3://").partition("/")
    if not bucket or not key:
        return None
    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        return s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=expires_in,
        )
    except ClientError as exc:
        print(f"[api] presigning recording URL failed: {exc}")
        return None


def _valid_call_log_filename(filename: str) -> bool:
    return bool(filename) and filename.endswith(".json") and "/" not in filename and ".." not in filename


def _s3_client():
    return boto3.client("s3", region_name=AWS_REGION)


def _list_call_logs_s3(include_transcripts: bool) -> list[dict]:
    logs = []
    try:
        paginator = _s3_client().get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=CALLS_S3_PREFIX):
            for obj in page.get("Contents", []):
                fname = obj["Key"][len(CALLS_S3_PREFIX):]
                if not _valid_call_log_filename(fname):
                    continue
                entry = _read_call_log_s3(fname)
                if entry is None:
                    continue
                if not include_transcripts:
                    entry = {k: v for k, v in entry.items() if k != "transcripts"}
                logs.append(entry | {"_file": fname})
    except ClientError as exc:
        print(f"[api] listing call logs from S3 failed: {exc}")
    return logs


def _list_call_logs_local(include_transcripts: bool) -> list[dict]:
    logs = []
    for f in CALL_LOG_DIR.glob("*.json"):
        try:
            entry = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not include_transcripts:
            entry = {k: v for k, v in entry.items() if k != "transcripts"}
        logs.append(entry | {"_file": f.name})
    return logs


def _list_call_logs(include_transcripts: bool = True) -> list[dict]:
    logs = _list_call_logs_s3(include_transcripts) if S3_BUCKET else _list_call_logs_local(include_transcripts)
    # filenames are timestamp-prefixed, so this also sorts by call order
    logs.sort(key=lambda entry: entry.get("_file", ""), reverse=True)
    return logs


def _read_call_log_s3(filename: str) -> dict | None:
    try:
        body = _s3_client().get_object(Bucket=S3_BUCKET, Key=f"{CALLS_S3_PREFIX}{filename}")["Body"].read()
        return json.loads(body)
    except (ClientError, json.JSONDecodeError):
        return None


def _read_call_log(filename: str) -> dict | None:
    if not _valid_call_log_filename(filename):
        return None
    if S3_BUCKET:
        return _read_call_log_s3(filename)
    path = CALL_LOG_DIR / filename
    if not path.is_file() or path.parent != CALL_LOG_DIR:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


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
    entry = _read_call_log(filename)
    if entry is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(entry)


@app.get("/api/call-logs/<path:filename>/transcript")
def get_call_log_transcript(filename):
    entry = _read_call_log(filename)
    if entry is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "call_id": entry.get("call_id"),
        "transcripts": entry.get("transcripts", []),
    })


@app.get("/api/call-logs/<path:filename>/recording-url")
def get_call_log_recording_url(filename):
    entry = _read_call_log(filename)
    if entry is None:
        return jsonify({"error": "not found"}), 404
    url = _presigned_recording_url(entry.get("recording_url"))
    if not url:
        return jsonify({"error": "no recording available"}), 404
    return jsonify({"url": url, "expires_in": RECORDING_URL_EXPIRES_IN})


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
