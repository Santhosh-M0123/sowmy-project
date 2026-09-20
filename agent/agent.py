"""
LiveKit voice agent orchestrator for the college phone line.

- A single "flow" Agent (no tools/function-calling) whose entire personality
  comes from a system prompt stored at the root of the S3 bucket
  (system_prompt.md), re-read fresh at the start of every call so edits made
  through the dashboard/API take effect immediately on every worker — local
  disk isn't shared across LiveKit Cloud workers, so agent/system_prompt.md
  on disk only works as a local-dev fallback when S3_BUCKET isn't configured.
- Optionally starts a room-composite (audio) egress recording to S3 for the
  call, if AWS_* / S3_BUCKET env vars are set.
- Writes one JSON file (call metadata + transcript) per call to S3, under
  calls/, in the same bucket as recordings — same local-disk-fallback caveat
  as the system prompt above.

Run with:  python agent/agent.py dev      (local dev, connects to LiveKit Cloud)
           python agent/agent.py start    (production worker)
"""

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv

from livekit import agents, api
from livekit.agents import (
    Agent,
    AgentSession,
    CloseEvent,
    JobContext,
    RoomInputOptions,
    WorkerOptions,
    cli,
    inference,
)
from livekit.plugins import silero

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
PROMPT_FILE = BASE_DIR / "agent" / "system_prompt.md"
CALL_LOG_DIR = BASE_DIR / "call_log"
CALL_LOG_DIR.mkdir(exist_ok=True)

DEFAULT_PROMPT = "You are a helpful voice assistant answering phone calls."

AGENT_NAME = os.getenv("AGENT_NAME", "college-voice-agent")

STT_MODEL = os.getenv("STT_MODEL", "cartesia/ink-whisper")
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-4.1-mini")
TTS_MODEL = os.getenv("TTS_MODEL", "cartesia/sonic-2")
TTS_VOICE = os.getenv("TTS_VOICE", "")

S3_BUCKET = os.getenv("S3_BUCKET")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
CALLS_S3_PREFIX = "calls/"
SYSTEM_PROMPT_S3_KEY = "system_prompt.md"


def load_system_prompt() -> str:
    """Read the orchestrator's only configuration file, fresh, every call.

    Lives at the root of the S3 bucket so a prompt saved through the
    dashboard is picked up immediately by every worker, regardless of which
    machine it's running on. Falls back to the local agent/system_prompt.md
    only when S3 isn't configured or the read fails.
    """
    if S3_BUCKET:
        try:
            body = boto3.client("s3", region_name=AWS_REGION).get_object(
                Bucket=S3_BUCKET, Key=SYSTEM_PROMPT_S3_KEY
            )["Body"].read().decode("utf-8")
            return body.strip() or DEFAULT_PROMPT
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") not in ("NoSuchKey", "404"):
                print(f"[agent] loading system prompt from S3 failed, falling back to local file: {exc}")
        except BotoCoreError as exc:
            print(f"[agent] loading system prompt from S3 failed, falling back to local file: {exc}")

    try:
        text = PROMPT_FILE.read_text(encoding="utf-8").strip()
        return text or DEFAULT_PROMPT
    except FileNotFoundError:
        PROMPT_FILE.write_text(DEFAULT_PROMPT, encoding="utf-8")
        return DEFAULT_PROMPT


class FlowAgent(Agent):
    """The one and only agent persona. No tools, no branching sub-agents —
    just instructions loaded from the file system."""

    def __init__(self):
        super().__init__(instructions=load_system_prompt())


def _safe_filename_ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H-%M-%S-%fZ")


def write_call_log(entry: dict) -> None:
    """Persist the finished call's record (metadata + transcript) to S3, next
    to its recording. Falls back to call_log/ on local disk only when
    S3_BUCKET isn't set or the upload fails, so local dev without AWS
    credentials still works — but the cloud deployment must not depend on
    that fallback, since worker filesystems there aren't persistent.
    """
    ts = _safe_filename_ts(entry["_started_dt"])
    fname = f"{ts}_{entry['call_id']}.json"
    entry = {k: v for k, v in entry.items() if not k.startswith("_")}
    body = json.dumps(entry, indent=2).encode("utf-8")

    if S3_BUCKET:
        try:
            boto3.client("s3", region_name=AWS_REGION).put_object(
                Bucket=S3_BUCKET,
                Key=f"{CALLS_S3_PREFIX}{fname}",
                Body=body,
                ContentType="application/json",
            )
            return
        except (ClientError, BotoCoreError) as exc:  # noqa: BLE001 - must never crash the call
            print(f"[agent] call log upload to S3 failed, falling back to local disk: {exc}")

    (CALL_LOG_DIR / fname).write_text(body.decode("utf-8"), encoding="utf-8")


async def start_recording(ctx: JobContext, call_id: str):
    """Kick off a room-composite (audio-only) egress recording to S3.
    Returns (recording_url, egress_id) or (None, None) if S3 isn't configured
    or the request fails — recording is optional, never fatal to the call.
    """
    bucket = os.getenv("S3_BUCKET")
    if not bucket:
        return None, None

    filepath = f"recordings/{call_id}.ogg"
    lkapi = api.LiveKitAPI()
    try:
        req = api.RoomCompositeEgressRequest(
            room_name=ctx.room.name,
            audio_only=True,
            file_outputs=[
                api.EncodedFileOutput(
                    filepath=filepath,
                    s3=api.S3Upload(
                        access_key=os.getenv("AWS_ACCESS_KEY_ID"),
                        secret=os.getenv("AWS_SECRET_ACCESS_KEY"),
                        region=os.getenv("AWS_REGION"),
                        bucket=bucket,
                    ),
                )
            ],
        )
        info = await lkapi.egress.start_room_composite_egress(req)
        return f"s3://{bucket}/{filepath}", info.egress_id
    except Exception as exc:  # noqa: BLE001 - recording must never crash the call
        print(f"[agent] egress start failed: {exc}")
        return None, None
    finally:
        await lkapi.aclose()


def _first_caller_identity(ctx: JobContext):
    for participant in ctx.room.remote_participants.values():
        phone = participant.attributes.get("sip.phoneNumber") if participant.attributes else None
        return phone or participant.identity
    return None


def build_transcript(session: AgentSession) -> list[dict]:
    """Flatten the session's chat history into a plain transcript list.

    Per https://docs.livekit.io/agents/multimodality/text/, ``AgentSession.history``
    holds a ``ChatContext`` populated as the call progresses; reading it after the
    session ends gives the full turn-by-turn conversation (user + agent messages).
    """
    transcript = []
    for item in session.history.items:
        if item.type != "message":
            continue
        text = item.text_content
        if not text:
            continue
        transcript.append({
            "role": item.role,
            "text": text,
            "timestamp": datetime.fromtimestamp(item.created_at, tz=timezone.utc).isoformat(),
            "interrupted": item.interrupted,
        })
    return transcript


async def entrypoint(ctx: JobContext):
    await ctx.connect()

    call_id = uuid.uuid4().hex[:12]
    started_dt = datetime.now(timezone.utc)

    recording_url, egress_id = await start_recording(ctx, call_id)

    session = AgentSession(
        stt=inference.STT(model=STT_MODEL),
        llm=inference.LLM(model=LLM_MODEL),
        tts=inference.TTS(model=TTS_MODEL, voice=TTS_VOICE) if TTS_VOICE else inference.TTS(model=TTS_MODEL),
        vad=silero.VAD.load(),
    )

    log_entry = {
        "call_id": call_id,
        "room_name": ctx.room.name,
        "agent_name": AGENT_NAME,
        "started_at": started_dt.isoformat(),
        "ended_at": None,
        "duration_seconds": None,
        "caller": None,
        "recording_url": recording_url,
        "egress_id": egress_id,
        "status": "in_progress",
        "close_reason": None,
        "error": None,
        "transcripts": [],
        "_started_dt": started_dt,
    }

    def _on_session_close(ev: CloseEvent) -> None:
        # Fires when AgentSession finishes tearing down (the "session completed"
        # event); we only capture its reason here since the write itself needs
        # to happen from an *awaited* hook to guarantee it completes before the
        # job process exits — ctx.add_shutdown_callback below is that hook.
        log_entry["close_reason"] = ev.reason.value
        if ev.error is not None:
            log_entry["error"] = str(ev.error)

    session.on("close", _on_session_close)

    async def on_shutdown():
        ended_dt = datetime.now(timezone.utc)
        log_entry["caller"] = _first_caller_identity(ctx)
        log_entry["ended_at"] = ended_dt.isoformat()
        log_entry["duration_seconds"] = round((ended_dt - started_dt).total_seconds(), 1)
        log_entry["status"] = "error" if log_entry.get("close_reason") == "error" else "completed"
        log_entry["transcripts"] = build_transcript(session)
        write_call_log(log_entry)

    ctx.add_shutdown_callback(on_shutdown)

    await session.start(
        room=ctx.room,
        agent=FlowAgent(),
        room_input_options=RoomInputOptions(),
    )

    await session.generate_reply(
        instructions="Greet the caller warmly and ask how you can help them today."
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
