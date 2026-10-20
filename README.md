# Audio Learning Companion

A personalized audio learning web app powered by a multi-agent AI system on AWS.
Ask the AI to teach you any topic; it researches the subject, writes a personalized
lecture tailored to your knowledge level and learning style, learns from completed
listening activity with transparent privacy controls, synthesizes it to audio,
and lets you listen with full playback controls on any phone or browser.

Designed for private use by 1–5 allowlisted users, deployed publicly with strong
security hardening (Cognito, email allowlist, WAF, CloudFront, per-user rate
limiting, encryption everywhere).

## Highlights

- Single personalized lectures and editable 2–8 episode lecture series
- Multi-agent research, long-form writing, Nova 2.5 Sonic narration, and durable orchestration
- Live, truthful generation stages from profile loading through source research, writing,
  Nova speech sessions, upload, and save
- Cross-device lecture library with fresh, user-scoped audio URLs
- Explicit owner-scoped offline downloads with audio, transcript, quota handling, and removal
- Cloud-synced explicit profile plus explainable listening-derived preferences
- Revision-safe profile edits, idempotent playback telemetry, confidence/decay, opt-out, and reset
- Cognito email/password authentication and allowlist, WAF, encryption, scoped IAM, rate limits, and metadata-only audit logs

## Architecture

```text
Browser / React PWA
   ├─ static app ──► CloudFront + WAF ──► private S3 bucket
   ├─ sign-in ─────► Cognito (email/password + email allowlist)
   └─ ID token ────► API Gateway (Cognito authorizer + throttling)
                         ├─► async_job Lambda
                         │      ├─ jobs, profiles, playback, history, series (DynamoDB)
                         │      └─► Bedrock AgentCore (Strands)
                         │             ├─ orchestrator (Claude Sonnet 5.5, low)
                         │             ├─ series planner (Claude Haiku 5.5, low)
                         │             ├─ research agent (Tavily)
                         │             ├─ lecture writer (Claude Sonnet 5.5, calibrated)
                         │             └─ audio agent (Nova 2.5 Sonic ──► WAV in private S3)
                         └─► presign_audio Lambda ──► 1-hour owned-prefix S3 URL

DynamoDB: Profiles + playback TTL · Lectures/GSI1 · Series · Jobs TTL · RateLimits TTL
AgentCore Memory: prior topics and semantic facts (not behavioral preferences)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for diagrams, trust boundaries, data flow,
series coordination, and adaptive-profile design. See [API.md](./API.md) for endpoint
contracts and state transitions.

## Layout

| Path | What |
|------|------|
| `infrastructure/` | AWS CDK v2 (Python) — all cloud resources |
| `agentcore/`      | Bedrock AgentCore multi-agent backend |
| `lambdas/`        | Lambda handlers (async job, presign audio, Cognito pre-signup) |
| `frontend/`       | React 19 + TypeScript + Vite PWA |
| `tests/`          | Backend pytest suite |
| `scripts/`        | deploy / teardown / populate-env |
| `ARCHITECTURE.md` | System, multi-agent, series, and adaptive-profile architecture |
| `API.md`          | Authenticated API contracts, schemas, states, and errors |
| `experiments/lecture_model_eval/RESULTS_2026.md` | Model quality, latency, constraint, and cost evaluation |
| `DEPLOYMENT.md`   | First-time deployment and validation guide |
| `RUNBOOK.md`      | Operational procedures and recovery |

## Quick start (local dev / tests)

```bash
# Backend tests (AgentCore direct-code deployment uses Python 3.12+)
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r tests/requirements-dev.txt
pytest

# Frontend
cd frontend && npm install
npm run typecheck && npm test && npm run build
```

## Deploy

See [DEPLOYMENT.md](./DEPLOYMENT.md). Short version (after prerequisites):

```bash
git checkout main
export ALLOWED_EMAILS="you@example.com"
./scripts/deploy.sh
```

Production deployment is intentionally restricted to `main`; develop and validate on
`development`, then merge before deploying.

> Deployment requires your own AWS account, Bedrock access to the configured Claude
> models (evaluated defaults: Sonnet/Haiku 5.5; Sonnet 4.6 is the live-account fallback),
> Amazon Nova 2.5 Sonic in us-east-1, and a Tavily API key. Nothing is deployed for you.
> Set `NARRATION_PROVIDER=polly` on AgentCore for the Neural Joanna rollback path.

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You may
view, run, study, modify, and share this project for **noncommercial** purposes.
**Commercial use is not permitted.** See [LICENSE](./LICENSE) for the full terms.
