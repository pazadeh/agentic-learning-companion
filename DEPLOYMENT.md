# Deployment Guide

This deploys the Audio Learning Companion to **your own** AWS account. Nothing is
deployed for you — you run the steps below with your credentials.

> Region is **us-east-1** throughout (WAF for CloudFront must live there).

## 0. Prerequisites on your machine

- AWS CLI v2, configured for a **personal** AWS account (not Isengard/corporate)
- Node.js 20+ and npm
- Python 3.11 (`python3.11`)
- The repo cloned locally

Verify:

```bash
aws sts get-caller-identity   # confirms your account/profile
node --version && python3.11 --version
```

## 1. Bedrock model access (now automatic)

AWS has **retired the manual "Model access" page** — serverless foundation models,
including **Claude Sonnet 4.6**, are automatically enabled in all commercial regions.
There is nothing to request.

> Optional verification (us-east-1):
> ```bash
> aws bedrock list-inference-profiles --region us-east-1 \
>   --query "inferenceProfileSummaries[?contains(inferenceProfileId,'claude-sonnet-4-6')].inferenceProfileId"
> ```
> Seeing `us.anthropic.claude-sonnet-4-6` confirms availability. The app uses the
> US cross-region inference profile by default (override via `ORCHESTRATOR_MODEL_ID`
> / `LECTURE_MODEL_ID`). For top-tier prose you can later set
> `LECTURE_MODEL_ID=us.anthropic.claude-opus-4-6-v1`. There is no Haiku in the 4.6 family.
>
> Note: a provider may still gate *first use* behind a one-time form. **Anthropic
> requires a one-time "use case details" (First-Time-Use) form per AWS account**
> before any Claude model can be invoked — even though model access is otherwise
> automatic. Submit it once via the Bedrock console (open the **Chat/Playground**,
> pick any Claude model, fill the short form) or the `PutUseCaseForModelAccess` API.
> After submitting, allow up to ~15 minutes. Until then, agent calls fail with
> `ResourceNotFoundException: Model use case details have not been submitted`.

## 2. Get a Tavily API key

Sign up at [tavily.com](https://tavily.com) (free tier is fine) and copy your API
key. You will store it in Secrets Manager after the stack deploys (step 6).

## 3. Bootstrap CDK (once per account/region)

```bash
cd infrastructure
python3.11 -m venv .venv-infra && source .venv-infra/bin/activate
pip install -r requirements.txt
npm install            # installs the pinned CDK CLI locally
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
deactivate && cd ..
```

## 4. Set the allowlist and alert email

Only these emails will ever be able to register (enforced by the Cognito
pre-sign-up Lambda):

```bash
export ALLOWED_EMAILS="you@example.com,trusted@example.com"
export ALERT_EMAIL="you@example.com"
```

## 5. Deploy everything

```bash
./scripts/deploy.sh
```

This deploys the stack, writes `frontend/.env` from the stack outputs, builds the
React app, uploads it to S3, and invalidates the CloudFront cache. At the end it
prints your **App URL**.

## 6. Store the Tavily key in Secrets Manager

Use the `TavilySecretArn` value printed in `outputs.json`:

```bash
aws secretsmanager put-secret-value \
  --secret-id audio-companion/tavily-api-key \
  --secret-string '{"apiKey":"YOUR_TAVILY_KEY"}' \
  --region us-east-1
```

## 7. Deploy the AgentCore agent

The conversational backend runs on Bedrock AgentCore. Deploy the agent from the
`agentcore/` directory using the AgentCore starter toolkit / CLI, providing these
environment variables to the runtime (names come from `outputs.json`):

- `PROFILES_TABLE`, `LECTURES_TABLE`, `AUDIO_BUCKET`
- `TAVILY_SECRET_NAME=audio-companion/tavily-api-key`
- `MEMORY_ID` (the `MemoryId` output — enables AgentCore Memory; omit to disable)
- `ORCHESTRATOR_MODEL_ID`, `LECTURE_MODEL_ID` (optional overrides)

The runtime's execution role needs: Bedrock `InvokeModel` on the Claude Sonnet 4.6
**inference profile** *and* its underlying foundation models, DynamoDB read/write on
the Profiles and Lectures tables, `s3:PutObject` on the audio bucket,
`polly:SynthesizeSpeech`, `secretsmanager:GetSecretValue` on the Tavily secret, and
the AgentCore Memory data-plane actions on the memory resource:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock-agentcore:CreateEvent",
    "bedrock-agentcore:RetrieveMemoryRecords",
    "bedrock-agentcore:ListMemoryRecords"
  ],
  "Resource": "arn:aws:bedrock-agentcore:us-east-1:<acct>:memory/*"
}
```

Because 4.6 uses a cross-region inference profile, the Bedrock statement must cover
both the profile ARN and the foundation-model ARNs across the profile's destination
regions, e.g.:

```json
{
  "Effect": "Allow",
  "Action": "bedrock:InvokeModel",
  "Resource": [
    "arn:aws:bedrock:us-east-1:<acct>:inference-profile/us.anthropic.claude-sonnet-4-6",
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*"
  ]
}
```

(Add the Opus 4.6 profile/model ARNs too if you set `LECTURE_MODEL_ID` to Opus.)

Once deployed, copy the agent **runtime ARN** and redeploy the stack so the job
Lambda can invoke it:

```bash
cd infrastructure && source .venv-infra/bin/activate
npx cdk deploy AudioCompanionStack \
  -c agentRuntimeArn="arn:aws:bedrock-agentcore:us-east-1:<acct>:runtime/<id>" \
  --parameters AlertEmail="$ALERT_EMAIL" \
  --outputs-file ../outputs.json
deactivate && cd ..
```

## 8. First user setup

1. Open the App URL.
2. **Create account** with an allowlisted email → confirm via the emailed code.
3. Sign in → you'll be prompted to set up **TOTP MFA** (scan the secret into an
   authenticator app) → enter the 6-digit code.
4. You're in.

## 9. Manual test checklist

- [ ] A non-allowlisted email cannot sign up (rejected at confirmation).
- [ ] MFA is required on sign-in.
- [ ] Ask "Teach me about black holes" → progress shows → audio plays.
- [ ] Playback controls work: play/pause, ±15s, speed 0.5×–2×, seek.
- [ ] The lecture appears in **History**; reopening it refreshes a fresh audio URL.
- [ ] Profile edits persist across reloads.
- [ ] Visiting an audio URL after ~1 hour fails (presigned URL expired) — refresh works.
- [ ] Hitting the API without a token returns 401.

## 9a. Automated smoke test (optional)

After deploying, run an end-to-end check against the live API. It verifies that
unauthenticated access is rejected, an authenticated user can generate a lecture,
audio can be presigned, and cross-user audio access is forbidden.

Authenticate one of two ways:

**Easiest — paste an ID token** (works regardless of MFA): sign into the app, copy
the ID token (browser devtools → Application → Local Storage → the
`...idToken` value), then:

```bash
SMOKE_ID_TOKEN="<paste-id-token>" python3 scripts/smoke_test.py
```

**Or — email/password** (uses Cognito SRP + auto-answers TOTP if you provide the
secret):

```bash
pip install -r scripts/requirements-smoke.txt
SMOKE_EMAIL="you@example.com" \
SMOKE_PASSWORD="..." \
SMOKE_TOTP_SECRET="<base32 TOTP secret>" \
python3 scripts/smoke_test.py
```

The script reads `outputs.json` for the API URL and Cognito IDs (override with
`SMOKE_API_URL` etc.). It exits non-zero if any check fails. Note: it generates a
real lecture, so it consumes a small amount of Bedrock/Polly usage.

## Regenerating the PWA icons

Placeholder icons (`frontend/public/icon-192.png`, `icon-512.png`) ship in the repo.
To regenerate or restyle them:

```bash
python3 scripts/generate_icons.py
```

## Teardown

```bash
./scripts/teardown.sh   # type 'destroy' to confirm
```

This empties both S3 buckets and destroys the stack. Delete the AgentCore agent and
the Tavily secret separately if you want a completely clean account.
