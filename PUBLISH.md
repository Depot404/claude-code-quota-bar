# Publish to VS Code Marketplace — step-by-step

Local build/install is done. Final publishing requires accounts & secrets that only you can create. Follow these steps once, then `vsce publish` does the rest for future versions.

## 1. Screenshot and icon

`images/screenshot.png` exists (a real capture of the panel — conversation list + quota bars) and `images/icon.png` (128×128) is set. **The README embeds it as a relative link**, which the Marketplace only resolves through the `repository` URL in `package.json` (already set to `github.com/octopus-tools/claude-code-quota-bar`) — **the image stays broken on the listing page until that repo actually exists and the file is pushed to it**. See step 2 below.

## 2. Create the GitHub repo (needed for the screenshot to render)

```powershell
# Authenticate gh (one-time, ~30s)
gh auth login -h github.com -p https -w -s "repo,delete_repo"
# Follow the device-code flow in your browser

# Create the org first if you don't have it, then:
cd "c:\Users\Komega2\Documents\Projets VSCODE\Octopus\Tools\ClaudeCodeQuotaBar"
gh repo create octopus-tools/claude-code-quota-bar --public --source=. --push --description "VS Code panel: Claude Code conversation state + quota, in the Secondary Side Bar"
```

If `octopus-tools` is not an org you own, either:
- Create the org first at <https://github.com/account/organizations/new> (free), or
- Use a personal repo (e.g. `<your-user>/claude-code-quota-bar`) and update the `repository.url`, `bugs.url`, `homepage` fields in `package.json` accordingly before publishing.

Skip this step and the extension still installs and works fine — only the README's screenshot stays broken on the Marketplace listing page (it renders locally and in the packaged `.vsix`).

## 3. Create an Azure DevOps publisher

The VS Code marketplace runs on Azure DevOps under the hood.

1. Go to <https://aka.ms/vscode-publishers> and sign in with a Microsoft account.
   - Use any MSA — does not need to be your personal email. The MSA email is **not** displayed publicly. Only the **Publisher ID** is.
2. Click **Create publisher**.
3. Fill in:
   - **ID**: `octopus-tools` (must match `publisher` field in `package.json`).
   - **Name**: anything, shown publicly (e.g. `Octopus Tools`).
   - **Logo**: optional, can reuse `images/icon.png`.
4. Save.

## 4. Generate a Personal Access Token (PAT)

Different from a GitHub PAT — this is the Azure DevOps PAT.

1. From the publisher dashboard, click your profile (top right) → **Personal access tokens**.
2. **+ New Token**:
   - **Name**: `vsce-publish`
   - **Organization**: **All accessible organizations** ← *important*
   - **Expiration**: 1 year max (you can renew later).
   - **Scopes**: click **Show all scopes** → check **Marketplace > Manage**.
3. Copy the token (shown once).

Store it in KeePassXC under `/Internet/VSCode-Marketplace-PAT` so you can find it again next year.

## 5. Login `vsce` with the PAT

```powershell
vsce login octopus-tools
# pastes PAT when asked
```

The token is stored in OS keyring (DPAPI on Windows) — no plaintext file.

## 6. Publish

From the project folder:

```powershell
cd "c:\Users\Komega2\Documents\Projets VSCODE\Octopus\Tools\ClaudeCodeQuotaBar"
vsce publish
```

The first publish takes ~1 min. The extension appears immediately at:
<https://marketplace.visualstudio.com/items?itemName=octopus-tools.claude-code-quota-bar>

After validation (usually within minutes, sometimes hours), it's installable by anyone via:
```
code --install-extension octopus-tools.claude-code-quota-bar
```

## 7. Future updates

Bump `version` in `package.json` (or run `vsce publish patch` / `minor` / `major`), then `vsce publish`. Add a section in `CHANGELOG.md` first.

## Privacy reminder

You're publishing under `octopus-tools`, not your personal handle. Do **not** add your real email anywhere in `package.json` — current `author.email` is intentionally omitted. The `LICENSE` file's copyright line currently reads `octopus-tools`, change it only if you want.
