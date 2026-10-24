# Unofficial ChatGPT Community Linux build

This repository contains a small build recipe and feature manifest for an
unofficial Linux Community package. It is not published, maintained, or endorsed
by OpenAI. The workflow fetches the signed official Linux package from its
APT repository, verifies the repository metadata, and applies the Linux
Community patches before creating a Debian package.

The build is pinned to [`ilysenko/codex-desktop-linux` commit
`cc4c4fd294b3a8d0581680b8cba0d3dabb8d21ec`](https://github.com/ilysenko/codex-desktop-linux/tree/cc4c4fd294b3a8d0581680b8cba0d3dabb8d21ec).
That upstream project is distributed under the [MIT License](https://github.com/ilysenko/codex-desktop-linux/blob/cc4c4fd294b3a8d0581680b8cba0d3dabb8d21ec/LICENSE).
The source patch in `patches/` adapts the optional model-list tweak to the
26.1016.51333 native composer, whose inline model list and model-specific
reasoning-effort catalog supersede the previous Community transforms. It
changes both Chat and Work initial views and close/select resets atomically.
Missing, duplicate or partially changed contracts fail closed; the build keeps
critical patch enforcement enabled. Existing legacy feature tests are retained.
The patch is applied to Community source before packaging; generated application
bundles are not edited by hand. OpenAI software,
product names, and marks remain subject to their own terms and licenses.

The manifest preserves 28 documented Linux feature IDs and enables four
`ui-tweaks` settings: show model choices by default, allow UI font sizes up to
24 px, allow a custom font stack, and restore the selected-text “More details”
action. It contains no account credentials, model/provider configuration, or
machine-specific paths.

Pushes to the initial build branch run the pinned amd64 build on a standard GitHub-hosted Ubuntu
runner. The workflow runs the upstream feature tests before resolving the
signed package and building. A successful run retains the `.deb`, its build
metadata, the signed package metadata, feature manifest, and SHA-256 checksums
as a one-day Actions artifact. The artifact is a temporary build output, not a
release or an endorsement.
