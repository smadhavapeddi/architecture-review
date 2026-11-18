# Architecture reviewer

Upload an architecture diagram or describe a setup. The app returns single points of failure, ranked by severity, plus the DigitalOcean building blocks that fix them (load balancers, VPC, managed databases, and more) and a suggested topology.

- Frontend: plain HTML, CSS, and JavaScript. No build step.
- Backend: Node.js 22 with zero npm dependencies.
- AI: [DigitalOcean Serverless Inference](https://docs.digitalocean.com/products/inference/how-to/use-serverless-inference/), default model `glm-5.3-flash` (reads diagrams, supports structured JSON output).
- Access: password protected. The model access key stays on the server and is never sent to the browser.

## How it works

1. You sign in. The server sets a signed, HttpOnly session cookie (12 hours).
2. The browser shrinks the diagram to 1800 px on the longest side and posts it with your description to `/api/review`.
3. The server calls `POST https://inference.do-ai.run/v1/chat/completions` with your model access key. It asks for strict JSON output and falls back to prompt-only JSON if the model rejects that.
4. The server validates and normalizes the model's answer, and the browser renders it. Model text is never inserted as HTML.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `APP_USER` | yes | Sign-in user ID |
| `APP_PASSWORD` | yes | Sign-in password. Store as an encrypted variable |
| `SESSION_SECRET` | yes in production | Random string that signs cookies. `openssl rand -hex 32` |
| `MODEL_ACCESS_KEY` | yes | Serverless Inference model access key |
| `MODEL` | no | Defaults to `glm-5.3-flash` |
| `INFERENCE_BASE_URL` | no | Defaults to `https://inference.do-ai.run/v1` |

The app refuses to start without `APP_USER` and `APP_PASSWORD`.

## Run locally

```bash
cp .env.example .env      # fill in the values
npm run dev               # http://localhost:8080
```

Try it without spending tokens, using the bundled mock:

```bash
node scripts/mock-inference.js &
APP_USER=solutions APP_PASSWORD=your-password SESSION_SECRET=dev \
MODEL_ACCESS_KEY=test-key INFERENCE_BASE_URL=http://localhost:9999/v1 npm start
```

## Deploy on DigitalOcean App Platform

1. **Create a model access key** in the control panel under Inference, then Model access keys. Scope it to the one model you use. See [Manage model access keys](https://docs.digitalocean.com/products/inference/how-to/manage-model-access-keys/).
2. **Push this folder to a new GitHub repository.**
   ```bash
   git init && git add . && git commit -m "Architecture reviewer"
   git branch -M main
   git remote add origin git@github.com:YOUR-GITHUB-USERNAME/architecture-reviewer.git
   git push -u origin main
   ```
3. **Create the app.** Control panel, Create, App Platform, choose GitHub and the repo. It detects a Node.js web service. Confirm:
   - HTTP port `8080`, run command `npm start`
   - Plan: Basic, 1 instance (keep it at 1)
   - Health check path `/healthz`
4. **Add environment variables** (Settings, web component, Environment variables). Tick **Encrypt** on the secrets.
   - `APP_USER` = your user ID
   - `APP_PASSWORD` = your password (encrypted)
   - `SESSION_SECRET` = output of `openssl rand -hex 32` (encrypted)
   - `MODEL_ACCESS_KEY` = the key from step 1 (encrypted)
5. **Deploy**, open the `*.ondigitalocean.app` URL, and sign in.

Prefer the CLI? Edit `.do/app.yaml` (repo name only), then `doctl apps create --spec .do/app.yaml`, and set the three secrets in the control panel afterward.

## Confirm the model name

If you see "Model not found", list the slugs your key can use:

```bash
curl https://inference.do-ai.run/v1/models -H "Authorization: Bearer $MODEL_ACCESS_KEY"
```

Set `MODEL` to a slug that supports image input if you want diagram uploads. Text-only models work for written descriptions.

## Security and cost controls

- Sign-in: constant-time credential check, 5 failed attempts per client IP per 15 minutes, and 30 failed attempts across all clients per 15 minutes.
- Reviews: 12 per client IP per 10 minutes and 150 per hour overall, so a shared password cannot run up your bill.
- Cookies are HttpOnly, SameSite=Lax, and Secure over HTTPS. A strict Content Security Policy is set on every response.
- Limits are held in memory, which is why the app runs as a single instance. Restarting the app resets them.
- Do not paste secrets or customer data into reviews. Diagrams and descriptions are sent to the model provider.

## Known limits

- Reviews are AI-generated. Verify product details in the DigitalOcean docs before sharing with a customer.
- Image requests need a vision-capable model. Very dense diagrams may need a higher-resolution crop of the part you care about.
- This is a shared-password demo, not per-user authentication. For wider use, put it behind your SSO.
