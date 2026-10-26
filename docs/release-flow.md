# ChatGPT Community Linux release flow

The repository is public. Only **standard** GitHub-hosted runners are used:
ubuntu-24.04 (AMD64), ubuntu-24.04-arm (ARM64). They are free for public
repositories. The workflow avoids large/premium runners and keeps expensive,
temporary Actions artifacts for only one day. GitHub Release drafts hold the durable, access-restricted package assets,
not an Actions artifact that expires. After verifying all release assets, the
release workflow deletes only its two exact, matching temporary Actions
artifacts from the originating build run. This reduces storage accumulation;
the public-repo runner minutes are free, but artifact storage is quota-limited.

## What runs without the laptop

1. Push/merge to the protected/default build branch
   (build/community-20261021) triggers the existing pinned-source build.
2. The runtime-contract tests, upstream feature tests, signed upstream APT
   metadata validation, AMD64 and ARM64 package builds must all pass.
3. The separate release workflow is triggered by a completed, successful
   **push** build. A private fork PR or failed run cannot publish.
4. The release workflow validates the workflow run through GitHub's API:
   same repository, exact workflow name, trusted branch, success, and SHA equal
   to the branch's current head. A superseded build is rejected.
5. Each downloaded architecture artifact is checksum-verified independently.
   The packager checks Debian package identity, version equality, pinned
   official upstream version and source commit, and the **38** compatible
   enabled Community feature IDs. The incompatible shared-app-server-socket
   feature must not reappear.
6. Publication creates a checked **draft release** with a deterministic tag
   such as community-v2026.10.25.26. The proprietary OpenAI binary is not
   publicly redistributed by default. Publication as a public prerelease
   additionally requires documented redistribution rights and the explicit
   repository variable COMMUNITY_BINARY_REDISTRIBUTION_AUTHORIZED=true.
7. Release assets: both .deb packages, per-architecture build information and
   signed-upstream metadata, features.json, release-metadata.json,
   RELEASE_NOTES.md, and combined SHA256SUMS. The metadata labels
   runtimeAccepted=false. Build CI is not a desktop login test.

Existing **published** tags cannot be overwritten. An interrupted draft can
be resumed only when its downloadable release-metadata.json is byte-for-byte
identical to the current verified build; every existing asset is checked against
the local verified output before uploading only missing assets. Nothing is deleted
or clobbered. If the draft's provenance is missing or differs, the workflow fails
closed for manual reconciliation. Drafts are visible only to authorized writers.

The optional workflow_dispatch path requires a specific previously successful
build-run ID and applies the *same* trust checks. It cannot publish from an
arbitrary fork or build branch.

## What runs later on the laptop

**No laptop access, install, service, or update has been performed by this
release flow.** The laptop can stay offline while GitHub builds/releases.

After reconnecting, with an authenticated GitHub CLI account that has write
access to the repository, Node.js 22+, and the local checkout available, first
stage a **draft** (or, if licensed, public prerelease):

    bash scripts/install-from-release.sh --stage

Or pin a version:

    bash scripts/install-from-release.sh --stage --tag community-v2026.10.25.26

Staging checks the release's metadata, SHA256SUMS, DEB architecture/version,
38-feature identity and repository/commit provenance. It cannot install,
stop processes, start services, or alter the existing desktop.

**Only after an explicit local decision**:

    sudo -v
    bash scripts/install-from-release.sh --apply --tag community-v2026.10.25.26

Local apply requires:
- Current installed codex-desktop plus a validated previous .deb. A supplied
  --rollback-deb can be used; otherwise the script uses a known private cache,
  or dpkg-repack if installed. No valid rollback package means no install.
- At least 8 GiB free disk, 512 MiB free runtime tmpfs, and a graphical session.
- A private, quiescent snapshot of the shared ~/.codex config/auth and the
  Electron profile. No profile or token data enters a GitHub artifact.
- Temporary suspension/reinstatement of the known Codex memory timer.
- Exact process identity shutdown by /proc (NOT pkill or grep); two zero-process
  checks before dpkg. No sudo override of the vendor's running-process guard.
- Only Community launched, on loopback CDP port 9223. Twice passing
  check-chat-boot.mjs, once after a settling interval, is needed to record
  LIVE_ACCEPTED (desktop composer readiness, **not** end-to-end send/response).
  The gate rejects shell-only and hidden codex-sandbox webview false positives.
  Actual chat functionality must be verified separately with a real new-chat
  send and received answer; no successful CI or composer-only check proves it.
- On failure after the package switch: stop candidate, reinstall prior .deb,
  restore the private pre-upgrade profile and verify previous chat boot.
  The previous package and receipt are preserved on disk for recovery.

This installer does not automatically start when the laptop comes online:
doing that would unexpectedly terminate ChatGPT/Codex work and require sudo.
Its preflight is staged safely; opt-in application is a deliberate separate
step. The release can be created without a connected laptop.

## Manual recovery

If local rollback cannot complete, first close all ChatGPT/Codex processes,
then install the saved rollback.deb from the private backup under
~/.local/share/chatgpt-community/backups/.promotion.*/. Restore the private
snapshot only with the apps fully closed. Never force a package switch over
running official ChatGPT or Codex, and do not set
CODEX_INSTALL_ALLOW_RUNNING=1.

The official ChatGPT package is never installed, modified, or removed by the
Community release workflows.
