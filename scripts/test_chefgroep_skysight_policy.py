"""Regression tests for owner-safe, no-auto-start Skysight policy."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name("chefgroep_skysight_policy.py")
spec = importlib.util.spec_from_file_location("skysight_policy", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def running(**kwargs):
    return {
        "state": "running", "is_running": True, "paused": False,
        "pid": 1234, "owner": "manual-continuous",
        "interval_seconds": 120, "ocr_language": "eng+nld",
        "summary_agent_enabled": True, "source": "chronicle-desktop",
        **kwargs,
    }


class PolicyTest(unittest.TestCase):
    def test_default_healthy(self):
        self.assertEqual(mod.decide(running()), "healthy")

    def test_interval_drift(self):
        s = running()
        s["interval_seconds"] = 60
        self.assertEqual(mod.decide(s), "drift")

    def test_language_drift(self):
        s = running()
        s["ocr_language"] = "eng"
        self.assertEqual(mod.decide(s), "drift")

    def test_stopped_never_started(self):
        s = running()
        s.update(state="stopped", is_running=False)
        self.assertEqual(mod.decide(s), "inactive")

    def test_pause_is_respected(self):
        s = running()
        s["paused"] = True
        self.assertEqual(mod.decide(s), "paused")

    def test_recording_session_is_respected(self):
        s = running()
        s["owner"] = "recording-session:123"
        self.assertEqual(mod.decide(s), "other-owner")

    def test_paused_state_is_respected(self):
        s = running()
        s.update(state="paused", is_running=True)
        self.assertEqual(mod.decide(s), "paused")

    def test_check_fails_on_drift(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            state = running()
            state["interval_seconds"] = 60
            status = directory / "status.json"
            status.write_text(json.dumps(state))
            with self.assertRaisesRegex(RuntimeError, "DRIFT"):
                mod.enforce("binary", status, directory / "env.conf",
                            directory / "exclusions.json", dry_run=True)

    def test_apply_restarts_drift_with_owner_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            state = running()
            state["interval_seconds"] = 60
            status = directory / "status.json"
            status.write_text(json.dumps(state))
            calls = []

            def fake_command(binary, args, env):
                calls.append(args)
                if args[0] == "stop":
                    state["state"] = "stopped"
                    state["is_running"] = False
                    status.write_text(json.dumps(state))
                if args[0] == "start":
                    state["state"] = "running"
                    state["is_running"] = True
                    state["interval_seconds"] = 120
                    state["ocr_language"] = "eng+nld"
                    status.write_text(json.dumps(state))
                return dict(state)

            with patch.object(mod, "persist_ocr_env"), patch.object(
                    mod, "missing_exclusions", return_value=()), patch.object(
                    mod, "command", side_effect=fake_command), patch.object(
                    mod, "process_alive", return_value=False), patch.object(
                    mod, "whitelisted_process_env", return_value={}):
                output = mod.enforce("binary", status, directory / "env.conf",
                                     directory / "exclusions.json")
            self.assertIn("repaired", output)
            self.assertEqual([c[0] for c in calls], ["stop", "start", "status"])
            self.assertEqual(calls[1][calls[1].index("--owner")+1], "manual-continuous")
            self.assertEqual(calls[1][calls[1].index("--source")+1], "chronicle-desktop")
            self.assertEqual(calls[1][calls[1].index("--interval-seconds")+1], "120")

    def test_unknown_owner_is_not_overridden(self):
        s = running()
        s.pop("owner")
        self.assertEqual(mod.decide(s), "other-owner")

    def test_missing_pid_is_not_restarted(self):
        s = running()
        s.pop("pid")
        self.assertEqual(mod.decide(s), "missing-pid")

    def test_empty_exclusions_detected(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(mod.missing_exclusions(Path(root) / "missing.json"),
                             mod.PROTECTED_APPS)

    def test_exclusions_are_idempotent(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "exclusions.json"
            path.write_text(json.dumps({"rules": [
                {"kind": "app", "value": app}
                for app in mod.PROTECTED_APPS
            ]}))
            self.assertEqual(mod.missing_exclusions(path), ())

    def test_check_does_not_modify_when_stopped(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            state = running()
            state.update(state="stopped", is_running=False)
            status = directory / "status.json"
            status.write_text(json.dumps(state))
            env_file = directory / "env.conf"
            with patch.object(mod, "command", side_effect=AssertionError("unexpected CLI")):
                result = mod.enforce("binary", status, env_file,
                                     directory / "exclusions.json", dry_run=True)
            self.assertEqual(result, "SKIP inactive")
            self.assertFalse(env_file.exists())

    def test_apply_does_not_start_stopped_collector(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            state = running()
            state.update(state="stopped", is_running=False)
            status = directory / "status.json"
            status.write_text(json.dumps(state))
            exclusion = directory / "exclusions.json"
            exclusion.write_text(json.dumps({"rules": [
                {"kind": "app", "value": app} for app in mod.PROTECTED_APPS
            ]}))
            with patch.object(mod, "persist_ocr_env"), patch.object(
                mod, "command", side_effect=AssertionError("unexpected CLI")
            ):
                result = mod.enforce("binary", status, directory / "env.conf", exclusion)
            self.assertIn("no capture started", result)


if __name__ == "__main__":
    unittest.main()
