# Unofficial ChatGPT Community Linux build

This repository contains a small build recipe and feature manifest for an
unofficial Linux Community package. It is not published, maintained, or endorsed
by OpenAI. The workflow fetches the signed official Linux package from its
APT repository, verifies the repository metadata, and applies the Linux
Community patches before creating a Debian package.

The build is pinned to [`ilysenko/codex-desktop-linux` commit
`fc533a9346095e74d47c506e3103b7282c5c54d9`](https://github.com/ilysenko/codex-desktop-linux/tree/fc533a9346095e74d47c506e3103b7282c5c54d9).
That upstream project is distributed under the [MIT License](https://github.com/ilysenko/codex-desktop-linux/blob/fc533a9346095e74d47c506e3103b7282c5c54d9/LICENSE).
The source patch in `patches/` adapts the optional model-list tweak to the
26.1021.22027 native composer, whose inline model list and model-specific
reasoning-effort catalog supersede the previous Community transforms. It
changes both Chat and Work initial views and close/select resets atomically.
Missing, duplicate or partially changed contracts fail closed; the build keeps
critical patch enforcement enabled. Existing legacy feature tests are retained.
The patch is applied to Community source before packaging; generated application
bundles are not edited by hand. OpenAI software,
product names, and marks remain subject to their own terms and licenses.

The manifest enables 38 of the 48 upstream Linux feature IDs. Ten are
excluded on purpose: `community-profile-isolation` would split the deliberately
shared `~/.codex` home; `account-switcher` could change the shared session
authentication while another client is working; `shared-app-server-socket`
is incompatible with the bundled 0.164.0-alpha.11.1 CLI: its launcher hook
switches the app-server connection into UNIX-socket proxy mode, where the
desktop's initialization never completes. The same extracted 26.1021.22027
Community binary initializes successfully when only that hook is disabled.
Keep it excluded until a protocol-compatible implementation has been
tested end-to-end; `shallow-repository-watches`
conflicts with the enabled `directory-only-working-tree-watch`, the functional
successor for the working-tree watch route; `community-features-in-gui-settings`
cannot apply to the 26.1021.22027 bundle because its native General settings
contract is missing or ambiguous there (upstream ships it `defaultEnabled:
false`); `remote-mobile-control` rewrites the local app-server spawn
arguments in the desktop's startup policy-read path
(`codexLinuxRemoteMobileLocalAppServerArgs` in `application-network-startup`)
and with it the desktop pauses on a non-retryable `policy-read
reason=protocol` failure against the bundled 0.164.0-alpha.11.1 app-server,
so it stays off until upstream repairs that interaction;
`flatpak-chrome-native-messaging`, `thorium-chrome-plugin` and
`omarchy-theme` target runtimes that are not installed;
and `nix-store-bundled-marketplace-permissions` applies to Nix builds only.
The `ui-tweaks` settings enable six options: show model choices by default
(native composer mode), allow UI font sizes up to 24 px, allow a custom font
stack, restore the selected-text “More details” action, Ctrl+Enter annotation
submit, and the dock icon tweak. The suggested-prompts tweak stays off: the
26.1021.22027 webview no longer ships the Suggested Prompts feature-sync
bundle its patch contracts against. The manifest contains no account
credentials, model/provider configuration, or machine-specific paths.

Pushes to the initial build branch run the pinned amd64 build on a standard GitHub-hosted Ubuntu
runner. The workflow generates every feature-set check from
`.github/community-build/features.json`, rejects IDs that upstream marked
retired or aliased, and stamps the package version with the UTC build date. It
runs the upstream feature tests before resolving the signed package and
building. A successful run retains the `.deb`, its build metadata, the signed
package metadata, feature manifest, and SHA-256 checksums as a one-day Actions
artifact. The Actions artifact is temporary. After a successful trusted-branch push,
`.github/workflows/community-release.yml` downloads and rechecks both AMD64 and
ARM64 artifacts, then creates a SHA256-verified **release draft** containing versioned assets.
Public publication remains blocked unless licensed redistribution rights are
explicitly verified and the repository variable
`COMMUNITY_BINARY_REDISTRIBUTION_AUTHORIZED=true` is set. This is not an official OpenAI release or
proof of a working desktop login. See `docs/release-flow.md`.

With the laptop offline, the cloud build and release-draft flow still complete.
Only repository writers can access drafts. No workstation installation is triggered. Later, `bash scripts/install-from-release.sh --stage`
only downloads and verifies a release; `--apply` is an explicitly opt-in local
package change with zero-process checks, a private rollback .deb, profile
snapshot, and two live chat acceptance checks.

## Zero-process installation preflight

The official **ChatGPT** and **ChatGPT Community** share the upstream Codex
profile. Before replacing a native package, close **every** official and
Community ChatGPT window and any Codex CLI/app-server processes. Also stop
bundled helpers and temporarily suspend any background Codex timers that may
restart them. Leave ZCode and unrelated applications alone.

Run the fail-closed local guard as the logged-in desktop user (without sudo) immediately before `sudo dpkg -i`:

```bash
node scripts/verify-desktop-quiescence.mjs
```

`PASS install_quiescence` is mandatory. A `BLOCK` means **do not install**:
identify and gracefully terminate the remaining PID(s), then rerun. Never
override upstream's `CODEX_INSTALL_ALLOW_RUNNING` guard. Staged builds and
signature/checksum verification may run while the old app is open, but the
**actual package swap** requires zero ChatGPT/Codex processes. Confirm the
process-free condition again immediately before touching the package. Preserve
both the previous .deb and a profile snapshot for rollback. After installing,
start **only Community** and run the logged-in chat-composer gate below.

This procedure follows the upstream README and
`docs/troubleshooting.md` sections *The app does not launch*,
*Official and custom apps interfere*, and *Updater is waiting*.

## Runtime acceptance gate (required before promoting a build)

The temporary 28-feature bisect in commit edd7f83 reproduced the shell
failure because it still contained the shared app-server bridge. On
2026-10-25 a one-variable headless comparison reproduced the stalled
0.164.0 app-server with the bridge hook enabled and confirmed successful
initialization with that hook disabled; the same unpatched official
26.1021.22027 application also initialized. The manifest now excludes
the incompatible bridge and must still pass the authenticated chat
composer gate on the laptop before release acceptance.

**Build CI is not a desktop boot test.** On 2026-10-25 the signed
26.1021.22027 bundle, both with Community features and without patches,
displayed only an idle app:// shell on the joep workstation (no usable
chat composer). The older installed codex-desktop 2026.10.21.9 was still working.
A successful Actions build must therefore remain a candidate, not be
automatically installed or called runtime-verified.

On a logged-in workstation with an actual ChatGPT window open, start the
Community app with a dedicated local CDP port (for example 9223) and run:

    node scripts/check-chat-boot.mjs --port 9223 --timeout 20

This probe requires Node.js 22+ for the built-in WebSocket client; older
Node versions fail with an explicit capability error.

This command probes IPv4 and IPv6 loopback (127.0.0.1 and ::1) only, requires an app:// desktop shell,
and checks Codex runtime identity plus a visible **Ask ChatGPT** editable
composer and **Send** control (or **Stop** while generating) in the primary
app shell. A hidden 1-pixel
codex-sandbox webview cannot satisfy this gate. CDP target discovery reads
URL metadata only to identify the app shell; the probe never stores or
prints URLs, chat messages, tokens, or account settings. Exit 0 and
PASS chat_boot mean **UI composer readiness only**, not successful message
submission or account/API functionality. A real send/response check is
required to claim end-to-end chat usability. Nonzero means do not promote.
Port 9224 is commonly occupied by Brave on this workstation; a normal
web-browser CDP endpoint is deliberately rejected.

The regression tests (node --test scripts/check-chat-boot.test.mjs) cover
the historical good shell and the broken 26.1021 shell, plus the 2026-10-26
case where the only webview belongs to the invisible codex-sandbox. They
run in build CI but do not replace authenticated workstation verification. Before any upgrade,
retain an installable, checksum-verified .deb of the known-good version
outside temporary GitHub Actions artifacts. If the candidate fails, keep
(or reinstall) the known-good package; never classify a build-only CI
result as a successful upgrade.
