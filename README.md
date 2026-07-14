# Audio Learning Companion

A personalized audio learning web app powered by a multi-agent AI system on AWS.
Ask the AI to teach you any topic; it researches the subject, writes a personalized
lecture tailored to your knowledge level and learning style, synthesizes it to audio,
and lets you listen with full playback controls on any phone or browser.

Designed for private use by 1–5 allowlisted users, deployed publicly with strong
security hardening (Cognito + MFA, email allowlist, WAF, CloudFront, per-user rate
limiting, encryption everywhere).

## Architecture

```
Browser (React 19 PWA)
   │  Cognito JWT (MFA)
   ▼
CloudFront + WAF ──► S3 (static frontend)
   │
   ▼
API Gateway (Cognito authorizer, throttled)
   │
   ├─► async_job Lambda ──► Bedrock AgentCore (Strands multi-agent)
   │                           ├─ orchestrator (Claude Sonnet 4.6)
   │                           ├─ research_agent (Tavily)
   │                           ├─ lecture_agent (Claude Sonnet 4.6)
   │                           └─ audio_agent (Amazon Polly ─► S3)
   │
   └─► presign_audio Lambda ──► S3 (1-hour presigned URLs)

DynamoDB: Profiles · Lectures · Jobs (TTL) · RateLimits (TTL)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed diagrams of the system design,
the multi-agent architecture, and the end-to-end request lifecycle.

## Layout

| Path | What |
|------|------|
| `infrastructure/` | AWS CDK v2 (Python) — all cloud resources |
| `agentcore/`      | Bedrock AgentCore multi-agent backend |
| `lambdas/`        | Lambda handlers (async job, presign audio, Cognito pre-signup) |
| `frontend/`       | React 19 + TypeScript + Vite PWA |
| `tests/`          | Backend pytest suite |
| `scripts/`        | deploy / teardown / populate-env |
| `DEPLOYMENT.md`   | First-time deploy guide |
| `RUNBOOK.md`      | Operational procedures |

## Quick start (local dev / tests)

```bash
# Backend tests
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r tests/requirements-dev.txt
pytest

# Frontend
cd frontend && npm install
npm run typecheck && npm test && npm run build
```

## Deploy

See [DEPLOYMENT.md](./DEPLOYMENT.md). Short version (after prerequisites):

```bash
export ALLOWED_EMAILS="you@example.com"
./scripts/deploy.sh
```

> Deployment requires your own AWS account, Bedrock model access (Claude 3.5
> Haiku + Sonnet in us-east-1), and a Tavily API key. Nothing is deployed for you.

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You may
view, run, study, modify, and share this project for **noncommercial** purposes.
**Commercial use is not permitted.** See [LICENSE](./LICENSE) for the full terms.
