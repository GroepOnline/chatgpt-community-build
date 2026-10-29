#!/usr/bin/env python3
"""Non-invasive Chronicle/Skysight runtime policy for ChefGroep Linux desktop.

Does not start the collector when the user stopped or paused it, and never
touches a recording-session-owned collector. No cloud services or secrets.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

TARGET_INTERVAL = 120
TARGET_OCR_LANG = "eng+nld"
PROTECTED_APPS = ("1Password", "Bitwarden", "KeePassXC")
DEFAULT_BINARY = "/opt/codex-desktop/resources/native/codex-record-replay-linux"
KEEP_ENV = frozenset((
    "HOME", "PATH", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY", "CODEX_HOME",
))


def runtime_dir() -> Path:
    return Path(f"/run/user/{os.getuid()}")


def safe_status(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, PermissionError):
        return {}
    return data if isinstance(data, dict) else {}


def decide(status: dict) -> str:
    # Fail closed. Stopped, intentionally paused, and session captures are untouched.
    if status.get("paused") or status.get("is_paused") or status.get("state") == "paused":
        return "paused"
    if status.get("state") != "running" or status.get("is_running") is not True:
        return "inactive"
    if status.get("owner") != "manual-continuous":
        return "other-owner"
    if not isinstance(status.get("pid"), int) or status["pid"] < 1:
        return "missing-pid"
    if (status.get("interval_seconds") == TARGET_INTERVAL
            and status.get("ocr_language") == TARGET_OCR_LANG):
        return "healthy"
    return "drift"


def process_alive(pid: int) -> bool:
    try:
        rest = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return bool(rest) and rest[0] != "Z"
    except (FileNotFoundError, PermissionError, IndexError):
        return False


def whitelisted_process_env(pid: int) -> dict[str, str]:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except (FileNotFoundError, PermissionError):
        return {}
    entries = {}
    for pair in raw.split(b"\0"):
        if b"=" not in pair:
            continue
        raw_key, raw_value = pair.split(b"=", 1)
        key = raw_key.decode("utf-8", errors="replace")
        if key in KEEP_ENV:
            entries[key] = raw_value.decode("utf-8", errors="replace")
    return entries


def command(binary: str, args: list[str], env: dict[str, str]) -> dict:
    p = subprocess.run(
        [binary, "skysight", *args], env=env, check=True,
        capture_output=True, text=True, timeout=25,
    )
    result = json.loads(p.stdout)
    if not isinstance(result, dict) or result.get("ok") is False:
        raise RuntimeError("Skysight command returned a non-success result")
    return result


def exclusions_path() -> Path:
    return Path.home() / ".codex/memories/extensions/chronicle/exclusions.json"


def missing_exclusions(path: Path) -> tuple[str, ...]:
    data = safe_status(path)
    rules = data.get("rules") if isinstance(data.get("rules"), list) else []
    found = {
        (rule.get("kind"), rule.get("value"))
        for rule in rules if isinstance(rule, dict)
    }
    return tuple(app for app in PROTECTED_APPS if ("app", app) not in found)


def persist_ocr_env(path: Path, env: dict[str, str]) -> None:
    desired = (
        "# Chronicle OCR languages; managed by ChefGroep runtime policy\n"
        "CODEX_SKYSIGHT_OCR_LANG=eng+nld\n"
    )
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_file() or path.read_text(encoding="utf-8") != desired:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(desired, encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(path)
    subprocess.run(
        ["systemctl", "--user", "set-environment",
         f"CODEX_SKYSIGHT_OCR_LANG={TARGET_OCR_LANG}"],
        env=env, capture_output=True, check=True, timeout=8,
    )


def enforce(binary: str, status_file: Path, policy_env: Path,
            exclusions: Path, *, dry_run: bool = False) -> str:
    status = safe_status(status_file)
    condition = decide(status)
    # The read-only check remains side-effect-free, even for a running daemon.
    if dry_run:
        missing = missing_exclusions(exclusions)
        if condition == "healthy" and not missing:
            return "PASS healthy"
        if condition in ("inactive", "paused", "other-owner"):
            return f"SKIP {condition}"
        raise RuntimeError(f"DRIFT {condition} missing_exclusions={len(missing)}")

    base_env = os.environ.copy()
    base_env["XDG_RUNTIME_DIR"] = str(runtime_dir())
    base_env["CODEX_SKYSIGHT_OCR_LANG"] = TARGET_OCR_LANG
    persist_ocr_env(policy_env, base_env)
    # Update config without starting the collector, preserving intentional stop.
    for app in missing_exclusions(exclusions):
        command(binary, [
            "update-exclusion", "--kind", "app", "--value", app,
            "--reason", "Protect password manager evidence",
        ], base_env)

    if condition in ("inactive", "paused", "other-owner"):
        return f"SKIP {condition} (no capture started)"
    if condition == "missing-pid":
        raise RuntimeError("Active Skysight has no verifiable daemon PID")
    if condition == "healthy":
        return "PASS healthy (no restart)"

    # A read-before-stop check avoids touching a changed ownership/session.
    current = safe_status(status_file)
    if (decide(current) != "drift"
            or current.get("pid") != status["pid"]
            or current.get("owner") != status.get("owner")):
        return "SKIP state changed concurrently"

    pid = current["pid"]
    old_interval = current.get("interval_seconds")
    source = current.get("source") or "chronicle-desktop"
    summary_flag = "enabled" if current.get("summary_agent_enabled") else "disabled"
    old_process_env = whitelisted_process_env(pid)
    run_env = base_env.copy()
    run_env.update(old_process_env)
    run_env["XDG_RUNTIME_DIR"] = str(runtime_dir())
    run_env["CODEX_SKYSIGHT_OCR_LANG"] = TARGET_OCR_LANG
    command(binary, ["stop"], run_env)
    for _ in range(80):
        if not process_alive(pid):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("Prior Skysight daemon did not exit; refusing duplicate")
    new_args = [
        "start", "--interval-seconds", str(TARGET_INTERVAL),
        "--summary-agent", summary_flag, "--source", source,
        "--owner", "manual-continuous",
    ]
    try:
        command(binary, new_args, run_env)
        verified = command(binary, ["status"], run_env)
        if decide(verified) != "healthy":
            raise RuntimeError("Restart did not reach requested state")
    except Exception:
        # Best effort: do not leave intentionally active collection stopped.
        try:
            old_env = run_env.copy()
            if "CODEX_SKYSIGHT_OCR_LANG" in old_process_env:
                old_env["CODEX_SKYSIGHT_OCR_LANG"] = old_process_env["CODEX_SKYSIGHT_OCR_LANG"]
            else:
                old_env.pop("CODEX_SKYSIGHT_OCR_LANG", None)
            command(binary, [
                "start", "--interval-seconds", str(old_interval or 60),
                "--summary-agent", summary_flag, "--source", source,
                "--owner", "manual-continuous",
            ], old_env)
        except Exception:
            pass
        raise
    return "PASS repaired interval=120 ocr=eng+nld"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply == args.check:
        parser.error("Choose exactly one of --check or --apply")
    binary = os.environ.get("CODEX_SKYSIGHT_BINARY", DEFAULT_BINARY)
    home = Path.home()
    lock_path = home / ".local/state/chefgroep-skysight/policy.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            result = enforce(
                binary,
                runtime_dir() / "skysight/status.json",
                home / ".config/environment.d/89-chefgroep-skysight.conf",
                exclusions_path(),
                dry_run=args.check,
            )
        except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
            print(f"FAIL Skysight policy: {type(exc).__name__}", file=sys.stderr)
            return 1
        print(result)
        return 0


if __name__ == "__main__":
    sys.exit(main())
