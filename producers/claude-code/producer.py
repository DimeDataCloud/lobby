#!/usr/bin/env python3
"""
Claude Code Observability Producer
Drop-in replacement for the original send_event.py that emits to the
multimodal observability server with the generalized event schema.

Usage:
  uv run producer.py --source-app my-project --event-type PreToolUse
  uv run producer.py --source-app my-project --event-type Stop --add-chat
  uv run producer.py --test
"""

import json
import sys
import os
import argparse
import getpass
import urllib.request
import urllib.error
from datetime import datetime

DEFAULT_SERVER = "http://localhost:4000"

# Multi-user identity
def _detect_user_id() -> str:
    uid = os.environ.get("OBSERVABILITY_USER_ID")
    if uid:
        return uid
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"

def _detect_workspace_id() -> str:
    wid = os.environ.get("OBSERVABILITY_WORKSPACE_ID")
    if wid:
        return wid
    # Try git remote or directory name
    import subprocess
    try:
        result = subprocess.run(["git", "config", "--get", "remote.origin.url"],
                                capture_output=True, text=True, timeout=2)
        if result.returncode == 0 and result.stdout.strip():
            # Extract repo name from URL
            url = result.stdout.strip()
            return url.split("/")[-1].replace(".git", "")
    except Exception:
        pass
    return os.path.basename(os.getcwd()) or "default"

USER_ID = _detect_user_id()
WORKSPACE_ID = _detect_workspace_id()

# Map Claude Code hook event names to generalized event types
EVENT_TYPE_MAP = {
    "PreToolUse": "tool_call",
    "PostToolUse": "tool_result",
    "PostToolUseFailure": "tool_failure",
    "PermissionRequest": "permission_request",
    "Notification": "notification",
    "Stop": "turn_end",
    "SubagentStop": "subagent_stop",
    "SubagentStart": "subagent_start",
    "PreCompact": "compression",
    "UserPromptSubmit": "user_prompt",
    "SessionStart": "session_start",
    "SessionEnd": "session_end",
}


def send_event(event_data, server_url=DEFAULT_SERVER):
    try:
        url = server_url.rstrip("/")
        if not url.endswith("/events"):
            url = f"{url}/events"
        req = urllib.request.Request(
            url,
            data=json.dumps(event_data).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": "ClaudeCode-Producer/1.0"},
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status == 200
    except Exception as e:
        print(f"Failed to send event: {e}", file=sys.stderr)
        return False


def make_event(source_app, event_type, input_data, add_chat=False):
    session_id = input_data.get("session_id", "unknown")
    agent_id = input_data.get("agent_id", session_id)

    # Map to generalized event type
    mapped_type = EVENT_TYPE_MAP.get(event_type, event_type.lower())

    event = {
        "source": "claude-code",
        "agent_id": agent_id,
        "event_type": mapped_type,
        "session_id": session_id,
        "payload": input_data,
        "timestamp": int(datetime.now().timestamp() * 1000),
        "user_id": USER_ID,
        "workspace_id": WORKSPACE_ID,
    }

    # Extract model if present
    if "model" in input_data:
        event["model"] = input_data["model"]

    # Forward common fields as top-level
    if "tool_name" in input_data:
        event["payload"]["tool_name"] = input_data["tool_name"]
    if "agent_type" in input_data:
        event["payload"]["agent_type"] = input_data["agent_type"]
    if "agent_transcript_path" in input_data:
        event["payload"]["agent_transcript_path"] = input_data["agent_transcript_path"]

    # Handle --add-chat
    if add_chat and "transcript_path" in input_data:
        transcript_path = input_data["transcript_path"]
        if os.path.exists(transcript_path):
            chat_data = []
            try:
                with open(transcript_path, "r") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                chat_data.append(json.loads(line))
                            except json.JSONDecodeError:
                                pass
                event["payload"]["chat"] = chat_data
            except Exception as e:
                print(f"Failed to read transcript: {e}", file=sys.stderr)

    return event


def send_test_events(server_url):
    session = "cc-test-001"
    events = [
        ("SessionStart", {"session_id": session, "model": "claude-sonnet-4", "source": "cli"}),
        ("UserPromptSubmit", {"session_id": session, "prompt": "Fix the auth bug"}),
        ("PreToolUse", {"session_id": session, "tool_name": "Bash", "tool_input": {"command": "ls"}}),
        ("PostToolUse", {"session_id": session, "tool_name": "Bash", "tool_response": "file1.py\nfile2.py"}),
        ("Stop", {"session_id": session, "stop_hook_active": False}),
        ("SessionEnd", {"session_id": session, "reason": "clear"}),
    ]

    for cc_type, payload in events:
        ev = make_event("cc-test", cc_type, payload)
        ok = send_event(ev, server_url)
        mapped = EVENT_TYPE_MAP.get(cc_type, cc_type)
        print(f"  {'✓' if ok else '✗'} {cc_type:20s} -> {mapped:20s} agent={ev['agent_id']}")

    print(f"\nSent {len(events)} test events to {server_url}")


def main():
    parser = argparse.ArgumentParser(description="Claude Code Observability Producer")
    parser.add_argument("--source-app", default="claude-code", help="Source app name")
    parser.add_argument("--event-type", help="Hook event type (PreToolUse, PostToolUse, etc.)")
    parser.add_argument("--server-url", default=DEFAULT_SERVER, help="Server URL")
    parser.add_argument("--add-chat", action="store_true", help="Include chat transcript")
    parser.add_argument("--summarize", action="store_true", help="Generate summary (requires API key)")
    parser.add_argument("--test", action="store_true", help="Send test events and exit")
    args = parser.parse_args()

    if args.test:
        print(f"Sending test events to {args.server_url}...")
        send_test_events(args.server_url)
        return

    if not args.event_type:
        parser.error("--event-type is required (unless --test)")

    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"Failed to parse JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    event = make_event(args.source_app, args.event_type, input_data, add_chat=args.add_chat)
    send_event(event, args.server_url)
    sys.exit(0)


if __name__ == "__main__":
    main()