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

The manifest enables 39 of the 48 upstream Linux feature IDs. Nine are
excluded on purpose: `community-profile-isolation` conflicts with the enabled
`shared-app-server-socket` and would split the intentionally shared
`~/.codex` home; `account-switcher` conflicts with the enabled
`shared-app-server-socket` because a shared CLI session could otherwise
switch authentication while another client is working; `shallow-repository-watches`
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
artifact. The artifact is a temporary build output, not a release or an
endorsement.
