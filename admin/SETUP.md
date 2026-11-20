# Private Website Control Center — Setup

The dashboard runs as a separate Render web service. It is not linked from the public portfolio, and it does not use or modify the Spi_tech bot service.

## 1. Add three private environment variables in Render

Open the [NSR Control Center service](https://dashboard.render.com/web/srv-dbvuu9n40ujc73ev2fc0), then open **Environment** and add:

| Key | What to enter |
|---|---|
| `GITHUB_TOKEN` | A GitHub fine-grained personal access token restricted to the portfolio repository below. |
| `ADMIN_PASSWORD` | A unique password of at least 20 characters, generated and stored in a password manager. |
| `ADMIN_TOTP_SECRET` | A random Base32 secret for your authenticator app (instructions below). |

Do not put these values in this repository, website JavaScript, screenshots, or a chat message.

### GitHub token permissions

Create a fine-grained token in GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens.

- Repository access: **Only select repositories** → `Nasif-Spica-Rollins-Ug/Nasif-Spica-Rollins-Ug.github.io`
- Repository permissions: **Contents: Read and write**
- Metadata: **Read-only** (automatically required)
- Do not grant Actions, Administration, Workflows, or access to other repositories.
- Set an expiry and renew the token before it expires.

Paste the token only into Render's `GITHUB_TOKEN` environment variable.

### Authenticator setup

Generate a fresh 20-byte Base32 secret on a trusted device. If Python is installed, run:

```bash
python -c "import secrets,base64; print(base64.b32encode(secrets.token_bytes(20)).decode().rstrip('='))"
```

Copy the generated value directly into Render as `ADMIN_TOTP_SECRET`. In your authenticator app, add an account manually using that same secret, choose **Time-based (TOTP)**, and use a six-digit code. Keep the secret in your password manager as a recovery backup.

Create a different long random password for `ADMIN_PASSWORD`; do not reuse your GitHub password.

## 2. Save and redeploy

After all three variables are saved, Render will redeploy the service. Wait for its latest deploy to show **Live**.

## 3. Sign in

Open:

https://nsr-website-control-center.onrender.com/admin

Sign in with your owner password and current six-digit authenticator code.

## How publishing works

- The editor reads the current website files from GitHub.
- Saving requires a confirmation and commits the edited file to `main`.
- GitHub Pages then publishes the change automatically.
- The preview tab is for checking a draft before saving.
- Image replacement keeps the existing image filename, so the current website image roles continue to work.
- GitHub commit history is the recovery path if you need to restore an earlier file version.

## Security notes

- The GitHub token is used only by the server; it is never sent to the browser.
- The dashboard requires a password and TOTP code.
- Sessions use an HttpOnly, Secure, SameSite=Strict cookie and expire after eight hours.
- Repeated failed sign-ins are rate-limited.
- Keep the GitHub token, password, and authenticator seed private. If a token is exposed, revoke it in GitHub immediately and create a replacement.
