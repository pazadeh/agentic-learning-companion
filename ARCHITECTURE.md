# Architecture

The Audio Learning Companion is a personalized audio-learning web app built on a
**Strands multi-agent system** running inside **Amazon Bedrock AgentCore**, fronted by
a hardened AWS serverless stack. A learner asks to be taught a topic; the system
researches it, writes a lecture tailored to their knowledge level and learning style,
synthesizes it to speech, and serves it back for playback.

This document covers three views:

1. [System architecture](#1-system-architecture) — the end-to-end AWS design.
2. [Multi-agent architecture](#2-multi-agent-architecture) — the orchestrator and its
   specialist sub-agents.
3. [Request lifecycle](#3-request-lifecycle) — how one "teach me X" request flows through
   the whole system.

---

## 1. System architecture

Every request is authenticated with a Cognito JWT (email-allowlisted, MFA-enforced) and
passes through WAF and a throttled API Gateway before reaching any compute. Lecture
generation is **asynchronous**: the API accepts a job, returns immediately, and a worker
drives the long-running agent run in the background.

```mermaid
flowchart TB
    user["Learner<br/><i>phone / browser</i>"]

    subgraph edge["Edge & Identity"]
        direction TB
        cf["CloudFront<br/>+ AWS WAF"]
        cognito["Amazon Cognito<br/><i>user pool · MFA · email allowlist</i>"]
        presignup["Cognito pre-signup Lambda<br/><i>email allowlist gate</i>"]
    end

    subgraph api["API Layer"]
        direction TB
        apigw["API Gateway<br/><i>Cognito authorizer · throttled</i>"]
        asyncjob["async_job Lambda<br/><i>API role + async worker</i>"]
        presign["presign_audio Lambda<br/><i>1-hour presigned GET URLs</i>"]
    end

    subgraph compute["Agent Runtime"]
        agentcore["Bedrock AgentCore Runtime<br/><b>Strands multi-agent system</b><br/><i>security chain + orchestrator</i>"]
    end

    subgraph data["State & Storage"]
        direction TB
        ddb[("DynamoDB<br/><i>Profiles · Lectures (GSI1)<br/>Jobs (TTL) · RateLimits (TTL)</i>")]
        s3static[("S3<br/><i>static frontend</i>")]
        s3audio[("S3<br/><i>lecture audio (MP3)</i>")]
        secrets["Secrets Manager<br/><i>Tavily API key</i>"]
        cw["CloudWatch Logs<br/><i>metadata-only audit trail</i>"]
    end

    subgraph ext["External / AWS AI Services"]
        direction TB
        bedrock["Amazon Bedrock<br/><i>Claude Sonnet 4.6</i>"]
        polly["Amazon Polly<br/><i>neural TTS · Joanna</i>"]
        acmemory["AgentCore Memory<br/><i>long-term learner recall</i>"]
        tavily["Tavily<br/><i>web search API</i>"]
    end

    user -->|"HTTPS"| cf
    cf -->|"static assets"| s3static
    cf -->|"/api/*"| apigw
    user -.->|"sign in / MFA"| cognito
    cognito -.->|"PreSignUp trigger"| presignup
    apigw -->|"verified JWT claims"| asyncjob
    apigw -->|"verified JWT claims"| presign

    asyncjob -->|"job records (TTL)"| ddb
    asyncjob -->|"async self-invoke<br/>(worker)"| asyncjob
    asyncjob -->|"invoke_agent_runtime"| agentcore
    presign -->|"presign own-prefix key"| s3audio

    agentcore --> bedrock
    agentcore --> polly
    agentcore --> acmemory
    agentcore --> tavily
    agentcore -->|"profiles · lectures"| ddb
    agentcore -->|"upload MP3"| s3audio
    agentcore -->|"read Tavily key"| secrets
    agentcore -->|"audit events"| cw
    asyncjob -->|"audit events"| cw
    presign -->|"audit events"| cw

    classDef edgeCls fill:#e8f0fe,stroke:#4285f4,color:#1a1a1a;
    classDef apiCls fill:#e6f4ea,stroke:#34a853,color:#1a1a1a;
    classDef computeCls fill:#fef7e0,stroke:#f9ab00,color:#1a1a1a;
    classDef dataCls fill:#f3e8fd,stroke:#a142f4,color:#1a1a1a;
    classDef extCls fill:#fce8e6,stroke:#ea4335,color:#1a1a1a;
    classDef userCls fill:#ffffff,stroke:#5f6368,color:#1a1a1a;

    class cf,cognito,presignup edgeCls;
    class apigw,asyncjob,presign apiCls;
    class agentcore computeCls;
    class ddb,s3static,s3audio,secrets,cw dataCls;
    class bedrock,polly,acmemory,tavily extCls;
    class user userCls;
```

### Security chain

Both the `async_job` Lambda (before a job is enqueued) and the AgentCore entrypoint
(before the agent runs) apply the same defense-in-depth sequence, so the runtime is safe
even if invoked directly:

```
validate input  ->  rate limit  ->  content filter  ->  invoke agent  ->  audit log
```

- **Input validation** — length/format checks; prompt-injection patterns are logged (not
  blocked). User ids and job ids must be canonical UUIDs.
- **Rate limiting** — per-user, per-action hourly buckets in DynamoDB (fails open).
- **Content filter** — narrow blocklist (CSAM, WMD/explosives how-tos, malware creation);
  legitimate sensitive topics are intentionally allowed.
- **Audit logging** — one JSON line per event to CloudWatch, **metadata only** via a strict
  key allowlist — never message content, lecture text, or search queries.

Identity is never trusted from the request body: the `user_id` always comes from the
verified Cognito JWT (`requestContext.authorizer.claims.sub`), and audio keys are scoped to
`audio/{user_id}/...` so a user can only ever presign their own files.

---

## 2. Multi-agent architecture

The **orchestrator** is the conversational brain (Claude Sonnet 4.6). It never writes the
lecture or produces audio itself — its job is to coordinate. Each specialist capability is
exposed to it as a **Strands tool**; some of those tools are themselves agent-backed
(`generate_lecture` spins up a dedicated writer sub-agent). A shared, per-invocation
`run_context` carries the large lecture script and final metadata between tools without
round-tripping through the orchestrator LLM.

```mermaid
flowchart TB
    entry["AgentCore entrypoint (main.py)<br/><i>security chain · injects memory · holds run lock</i>"]

    subgraph orch["Orchestrator Agent — Claude Sonnet 4.6"]
        brain["Conversational controller<br/><i>drives the mandated tool sequence</i>"]
    end

    subgraph tools["Specialist tools (agents & functions)"]
        direction TB
        profile["Profile tools<br/><i>get / save profile · save lecture</i>"]
        research["Research Agent<br/><i>research_topic · web_search</i>"]
        ranking["Source ranking<br/><i>authority + relevance tiers</i>"]
        lecture["Lecture Agent<br/><i>writer sub-agent · Claude Sonnet 4.6</i><br/>iterative long-form script"]
        audio["Audio Agent<br/><i>chunk · synthesize · upload</i>"]
    end

    runctx["run_context<br/><i>per-invocation script + lecture metadata</i>"]

    subgraph backing["Backing services"]
        direction TB
        ddb[("DynamoDB<br/>Profiles · Lectures")]
        tavily["Tavily web search"]
        bedrock["Amazon Bedrock"]
        polly["Amazon Polly"]
        s3audio[("S3 audio bucket")]
        acmemory["AgentCore Memory"]
    end

    entry -->|"build_orchestrator(user_id, memory_context)"| brain
    entry -.->|"retrieve_user_memories"| acmemory
    entry -.->|"record_interaction (turn event)"| acmemory

    brain -->|"1 · load learner"| profile
    brain -->|"2 · research topic"| research
    brain -->|"3 · write script"| lecture
    brain -->|"4 · synthesize + upload"| audio
    brain -->|"5 · persist metadata"| profile

    profile --> ddb
    research --> tavily
    research --> ranking
    lecture --> bedrock
    lecture -->|"set_script"| runctx
    audio -->|"get_script"| runctx
    audio --> polly
    audio --> s3audio
    audio -->|"set_lecture"| runctx
    profile -->|"get_lecture"| runctx

    classDef entryCls fill:#fef7e0,stroke:#f9ab00,color:#1a1a1a;
    classDef orchCls fill:#e8f0fe,stroke:#4285f4,color:#1a1a1a;
    classDef toolCls fill:#e6f4ea,stroke:#34a853,color:#1a1a1a;
    classDef ctxCls fill:#fff0f6,stroke:#d63384,color:#1a1a1a;
    classDef backCls fill:#f3e8fd,stroke:#a142f4,color:#1a1a1a;

    class entry entryCls;
    class brain orchCls;
    class profile,research,ranking,lecture,audio toolCls;
    class runctx ctxCls;
    class ddb,tavily,bedrock,polly,s3audio,acmemory backCls;
```

### The agents

| Agent / tool | Model | Responsibility |
|---|---|---|
| **Orchestrator** | `us.anthropic.claude-sonnet-4-6` | Conversational controller. Loads the profile, then drives the fixed tool sequence; never teaches directly and never claims completion without a real `s3Key`. |
| **Research Agent** | — (Tavily API) | Runs several varied search "angles" (quick/standard/deep = 3/5/8 queries), deduplicates, and ranks sources by domain **authority** blended with **relevance**. Optional trusted-only mode keeps academic/reference/encyclopedic tiers. |
| **Lecture Agent** | `us.anthropic.claude-sonnet-4-6` | Spins up a dedicated writer sub-agent that composes the spoken-word script **iteratively** (continuation passes) to reliably hit the target length (~150 wpm), then stores the full script in `run_context`. |
| **Audio Agent** | — (Amazon Polly neural) | Splits the script on sentence boundaries into ≤3000-char chunks, synthesizes each with Polly (Joanna), concatenates the MP3 frames, and uploads to `audio/{user_id}/{lecture_id}/lecture.mp3`. |
| **Profile tools** | — (DynamoDB) | `get_user_profile` / `save_user_profile` / `save_lecture`. Persist learner preferences and lecture history, always scoped to the verified `user_id`. |

### Why `run_context`?

Long lecture scripts (tens of thousands of characters) must not be passed back through the
orchestrator LLM as tool arguments — that risks truncation and wastes tokens. Instead the
Lecture Agent writes the script to `run_context` (`set_script`), and the Audio Agent reads
it directly (`get_script`). The entrypoint holds a lock around the whole run and resets the
context each invocation, so a plain module-level store is safe.

### Long-term memory

`AgentCore Memory` gives cross-session recall. Before the run, the entrypoint retrieves the
learner's relevant long-term memories (prior topics and semantic facts, scoped to
`users/{user_id}/...`) and injects them into the orchestrator's system prompt. After the
run, the turn is recorded as an event, from which AgentCore asynchronously extracts new
long-term records. Memory **fails open** — if it's disabled or errors, the agent still runs
using just the DynamoDB profile.

---

## 3. Request lifecycle

An end-to-end "teach me X" lecture request, from tap to playback:

```mermaid
sequenceDiagram
    autonumber
    participant U as Learner
    participant GW as API Gateway
    participant API as async_job (API)
    participant W as async_job (worker)
    participant AC as AgentCore + Orchestrator
    participant T as Tools/Sub-agents
    participant DDB as DynamoDB library
    participant S3 as S3 audio
    participant PS as presign_audio

    U->>GW: POST /jobs/start (JWT)
    GW->>API: verified claims
    API->>API: validate · rate limit · content filter
    API->>API: write "pending" job (DynamoDB, TTL)
    API-->>U: 202 { job_id }
    API-)W: async self-invoke (Event)

    W->>AC: invoke_agent_runtime(user_id, message)
    AC->>AC: security chain + inject memory
    AC->>T: get_user_profile
    AC->>T: research_topic (Tavily + ranking)
    AC->>T: generate_lecture (writer sub-agent, stores script)
    AC->>T: synthesize_and_upload (Polly)
    T->>S3: put lecture.mp3
    AC->>T: save_lecture (best-effort tool call)
    AC-->>W: { response, lecture }
    W->>DDB: idempotent lecture metadata upsert
    W->>W: update job "completed" (result)

    loop poll until done
        U->>GW: GET /jobs/{id}/status
        GW->>API: verified claims
        API-->>U: { status, progress }
    end

    U->>GW: GET /jobs/{id}/result
    API-->>U: { lecture: { s3Key, ... } }
    U->>PS: POST presign { s3_key } (JWT)
    PS->>PS: verify key under audio/{user_id}/
    PS-->>U: presigned MP3 URL (1h)
    U->>S3: GET MP3 (presigned)
```

---

## 4. Multi-part lecture series

Long subjects (for example a book across 4 × 30-minute lectures) are planned once,
reviewed by the learner, then generated **one episode at a time**. Each episode is a
normal lecture from the unchanged orchestrator pipeline (research → write → Polly →
save), so a series adds coordination, not a second lecture implementation.

```mermaid
stateDiagram-v2
    [*] --> planning: POST /series/drafts
    planning --> ready_for_approval: planner (request_type=series_plan)
    planning --> failed: planner error
    ready_for_approval --> ready_for_approval: POST /plan (edit, revision-checked)
    ready_for_approval --> generating: POST /approve (queues episode 1)
    generating --> generating: episode N completes, N+1 queued
    generating --> attention: an episode fails (later episodes wait)
    attention --> generating: POST /episodes/{id}/retry
    generating --> completed: last episode completes
```

- **Durable state** lives in `SeriesTable`: summaries at `pk=USER#{userId}`,
  `sk=SERIES#{seriesId}`; ordered episodes at `pk=SERIES#{seriesId}`,
  `sk=EPISODE#{nn}`. Work items are `SERIES_PLAN` / `SERIES_EPISODE` rows in the
  existing JobsTable, run by the same async worker Lambda (routed by `jobType`;
  rows without `jobType` are flat lecture jobs, unchanged).
- **Idempotency**: every transition is a conditional DynamoDB transaction keyed on
  the episode's `activeJobId`. A duplicate or late worker delivery cannot claim the
  same episode or enqueue the next one twice. Episode completion and queueing the
  next episode happen in one transaction. If audio succeeds but that transaction
  fails, a retry can leave an orphaned audio object; production exactly-once recovery
  would require reconciliation by `episodeId`.
- **Failure and retry**: a failed episode pauses the series (`attention`) with a
  user-safe error. Retry is allowed for a failed episode, or one stalled longer than
  the 15-minute worker timeout, and creates a new job. The sequence then resumes.
- **Planner**: `agentcore/agents/series_planner.py` returns strict JSON (2–8 episodes,
  1–30 minutes each). It honors an explicit count/length in the request and never
  generates a lecture.
- **Episode requests** include the series title, the episode's focus, and the full
  outline so each lecture stays in scope and links to its neighbors. AgentCore tags
  the saved lecture row with `seriesId`, `episodeId`, and `episodeOrder`.
- **Suggestions are advisory**: Chat has an explicit Lecture/Series choice. An explicit
  multi-lecture request in Lecture mode asks before doing anything. After a broad
  topic (book, history, deep dive) produces one lecture, Chat offers a series. The
  app never converts a request on its own.

Step Functions is intentionally not used yet. The API and schema keep the runner
replaceable, and the current agent loop could later move to AgentCore Harness
episode by episode.

---

## 5. Behavioral learner profile

The learner model separates declared settings from behavioral evidence. Explicit
settings are stored at `ProfilesTable: USER#{userId} / PROFILE#EXPLICIT`; temporary
playback-session checkpoints use `PLAYBACK#{lectureId}#{sessionId}` and expire after
seven days via TTL. Durable listening aggregates remain on the learner-owned lecture
row.

```mermaid
flowchart LR
    request["Current request"] --> resolver["Deterministic profile resolver"]
    explicit["Explicit profile<br/>user-controlled"] --> resolver
    lectures["Lecture + playback history<br/>confidence · decay · reset generation"] --> inference["Explainable inference"]
    inference --> resolver
    defaults["Application defaults"] --> resolver
    resolver -->|"request > explicit > confident inference > default"| agent["AgentCore orchestrator"]
    agent --> generated["Lecture + personalizationUsed"]
    generated --> lectures
    player["Audio player<br/>actual media time consumed"] -->|"20s heartbeat / pause / ended"| playback["Authenticated playback API"]
    playback --> lectures

    classDef declared fill:#e8f0fe,stroke:#4285f4,color:#1a1a1a;
    classDef inferred fill:#e6f4ea,stroke:#34a853,color:#1a1a1a;
    classDef runtime fill:#fef7e0,stroke:#f9ab00,color:#1a1a1a;
    class explicit,request declared;
    class lectures,inference,playback inferred;
    class resolver,agent,generated,player,defaults runtime;
```

- **Signals**: generated topics contribute weak interest evidence; ≥80% actual
  listening contributes duration/style/depth evidence. Old evidence decays over a
  180-day horizon. At least three independent samples and 70% confidence are required
  before an inference can affect generation.
- **Playback integrity**: the client accumulates media time consumed from wall-clock
  playback time × playback rate. Seeking does not count. Cumulative session updates
  are sequence-numbered and conditionally transacted with the lecture aggregate, so
  duplicate delivery cannot double-count.
- **Privacy**: behavioral personalization can be disabled. Reset or consent changes
  atomically advance an `inferenceGeneration`; playback transactions are revision-fenced
  and write only to the active generation. Older or delayed evidence therefore remains
  permanently excluded without deleting factual playback progress/history. Explicit
  settings always remain visible and authoritative.
- **Observability**: each generated lecture stores `personalizationUsed`, including
  the value, source (`current_request`, `explicit`, `inferred`, or `default`), and
  confidence. AgentCore Memory remains supplemental semantic context rather than the
  preference source of truth.

---

## Where things live

| Path | What |
|------|------|
| `agentcore/main.py` | AgentCore entrypoint + security chain + memory wiring |
| `agentcore/agents/orchestrator.py` | Orchestrator agent and the mandated tool sequence |
| `agentcore/agents/{research,lecture,audio}_agent.py` | Specialist sub-agents/tools |
| `agentcore/agents/{profile_store,memory,run_context,research_ranking,config}.py` | Persistence, memory, shared context, ranking, config/model ids |
| `agentcore/security/` | Input validation, rate limiting, content filter, audit logging |
| `lambdas/async_job/` | Job API + async worker; `series.py` coordinates lecture series and `learner_profile.py` handles explicit profiles, playback, and inference |
| `agentcore/agents/series_planner.py` | Strict-JSON lecture-series planner |
| `lambdas/presign_audio/` | Own-prefix presigned audio URLs |
| `infrastructure/` | AWS CDK v2 (Python) — all cloud resources |
| `frontend/` | React 19 + TypeScript + Vite PWA |
