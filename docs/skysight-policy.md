# Chronicle / Skysight policy for ChefGroep's Linux Community desktop

This opt-in local policy **does not enable recording**. It only checks and
repairs policy drift if Skysight is already running as `manual-continuous`.
It leaves stopped or paused recording alone and never changes a
`recording-session:<id>` owner. Record & Replay remains independent.

## Verified decision (2026-10-27)

On the `joep` laptop, Chromium/Wayland Skysight recorded one 10-minute
rolling fallback every **60 seconds** (not a distinct AI request per resource).
The separate AI summarizer ran about every ten minutes. The resource
collection and scheduled summarizer ran, but automatic retrieval of those
memories by ChatGPT/Codex was **not** established.

Live tuning:
- Capture interval: 120 seconds while manual continuous capture is active.
- Local OCR: `eng+nld` (both already installed for Tesseract).
- Excluded apps: 1Password, Bitwarden, KeePassXC.
- Keep the separate AI summarizer enabled, retain all existing memories.

Do not add `domain` exclusion rules on current Linux Community builds:
the Skysight browser provider often lacks URL/domain metadata. The current
implementation correctly suppresses unmatched/unverifiable browser capture
when domain exclusions are active, potentially removing all useful
browser activity. App-based exclusions avoid this broad side effect, but
are **not a complete privacy boundary** for web login pages. Pause Skysight
manually before displaying credentials or other sensitive information.

## Setup

As the *logged-in desktop user* on a Linux Community build:

```bash
install -Dm755 scripts/chefgroep_skysight_policy.py \
  "$HOME/.local/bin/chefgroep-skysight-policy"
install -Dm644 systemd/user/chefgroep-skysight-policy.service \
  "$HOME/.config/systemd/user/chefgroep-skysight-policy.service"
install -Dm644 systemd/user/chefgroep-skysight-policy.timer \
  "$HOME/.config/systemd/user/chefgroep-skysight-policy.timer"
systemctl --user daemon-reload
systemctl --user enable --now chefgroep-skysight-policy.timer
"$HOME/.local/bin/chefgroep-skysight-policy" --check
```

The timer only performs idempotent checks and repairs, every ten minutes.
It does **not** start a stopped collector. For an immediate repair:

```bash
"$HOME/.local/bin/chefgroep-skysight-policy" --apply
systemctl --user status chefgroep-skysight-policy.timer
journalctl --user -u chefgroep-skysight-policy.service --no-pager -n 15
```

Run tests without a desktop or captured screenshots:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts -p 'test_chefgroep_skysight_policy.py' -v
```

Note: when launching the `skysight` CLI from an SSH shell, set
`XDG_RUNTIME_DIR=/run/user/$(id -u)`. Otherwise the command may
read `/tmp/skysight` and report **not started** despite a running daemon.

## Disable / rollback

```bash
systemctl --user disable --now chefgroep-skysight-policy.timer
rm "$HOME/.config/systemd/user/chefgroep-skysight-policy."{service,timer}
systemctl --user daemon-reload
```

This does not stop or delete Skysight memories. To restore the previous
60-second cadence while recording is actively running, issue an
explicit `skysight stop` then `skysight start --interval-seconds 60`
under the logged-in desktop environment. Remove the OCR environment override
only if you want English-only OCR. The three app exclusions are managed with
`skysight update-exclusion --remove` and do not need to be removed to
disable the timer. Preserve any privacy exclusions the user configured.
