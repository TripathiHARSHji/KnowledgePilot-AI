# KnowledgePilot AI — Build & Deployment Plan

**Project:** Multi-user AI knowledge assistant (RAG-based) with document ingestion, semantic search, and Redis-backed conversation memory.

**Stack:** Node.js + Express (backend), React + Vite (frontend), PostgreSQL (metadata), Redis (session memory), Docker, Railway (deployment). Postgres and Redis are already provisioned on Railway.
IMP: don't write test cases and try to save token.
---

## 0. Guiding Principles

- Build backend-first, in vertical slices (one full feature end-to-end before the next), not layer-by-layer.
- Keep ingestion, retrieval, and chat as three independently testable pipelines.
- Every user's data (documents, vectors, chat history) must be isolated by `user_id` from day one — retrofitting isolation later is painful.
- Deploy early and often (even a skeleton) so Railway config issues surface immediately, not at the end.

---

## Phase 1 — Foundations (Auth + DB Schema)

1. **Postgres schema design**
   - `users` (id, email, password_hash, created_at)
   - `documents` (id, user_id, filename, status, uploaded_at)
   - `chunks` (id, document_id, user_id, content, metadata, embedding_id/vector_ref)
   - `chat_sessions` (id, user_id, created_at)
   - `chat_messages` (id, session_id, role, content, created_at) — optional, since Redis holds live memory; Postgres can hold durable history.
2. **Auth (JWT)**
   - Signup/login endpoints, password hashing (bcrypt), JWT issue + verify middleware.
   - Every downstream route protected by this middleware so `user_id` is always known.
3. **Dockerize backend early** and connect to Railway Postgres/Redis using environment variables (never hardcode connection strings).

**Milestone:** A deployed backend on Railway where you can sign up, log in, and hit a protected `/me` route.

---

## Phase 2 — Document Ingestion Pipeline

1. **Upload endpoint** — accept PDF/DOCX/TXT, store file temporarily (or in object storage — see note below), create a `documents` row with status `processing`.
2. **Extraction** — parse text per file type:
   - PDF → `pdf-parse` or similar
   - DOCX → `mammoth`
   - TXT → direct read
3. **Cleaning** — strip boilerplate, normalize whitespace, remove headers/footers/page numbers where feasible.
4. **Chunking** — split into overlapping chunks (e.g., 500–1000 tokens with ~10–15% overlap) using a text splitter; keep chunk metadata (document_id, user_id, position).
5. **Embedding generation** — call an embedding model (gemini model) per chunk.
6. **Vector storage** —  **pgvector extension on your existing Railway Postgres** (oid	extname	extowner	extnamespace	extrelocatable	extversion	extconfig	extcondition
16389	vector	10	2200	true	0.8.6	NULL	NULL
).
7. Update `documents.status` → `ready` once all chunks are embedded and stored.

**Milestone:** Upload a PDF, confirm chunks + embeddings land in the DB, scoped to the uploading user.

> **Note on file storage:** Railway's filesystem is ephemeral on redeploys. For anything beyond a quick demo, use an object store (Cloudflare R2 / AWS S3 / Railway volume) for the raw uploaded files, even though the extracted text/embeddings live in Postgres.

---

## Phase 3 — RAG Query Pipeline

1. **Query endpoint** — user sends a question tied to their session.
2. **Query embedding** — embed the incoming question with the same embedding model used for chunks.
3. **Semantic search** — similarity search (cosine/L2) via pgvector, filtered by `user_id` (and optionally `document_id` if scoped to one doc).
4. **Context assembly** — take top-k chunks, format into a prompt template with clear source separation.
5. **LLM call** — send system prompt + retrieved context + user question + recent conversation memory (from Redis) to the LLM.
6. **Response streaming (optional but recommended)** — stream tokens back to the frontend for a responsive feel.

**Milestone:** Ask a question about an uploaded document and get a grounded answer with retrieved context visible (log it for debugging).

---

## Phase 4 — Redis Conversation Memory

1. **Session key design** — `session:{user_id}:{session_id}` storing a rolling window of recent turns (e.g., last N messages) as JSON.
2. **Read-before-generate** — on each query, pull recent turns from Redis, inject into the prompt as conversation history.
3. **Write-after-generate** — append the new user message + assistant reply back to Redis, trim to window size.
4. **TTL** — set an expiry on session keys (e.g., 24–48h) so idle sessions clean themselves up.
5. Optionally persist full history to Postgres `chat_messages` for durability beyond Redis's TTL.

**Milestone:** Ask a follow-up question ("what about the second point?") and confirm the assistant retains context.

---

## Phase 5 — Frontend (React + Vite)

1. Auth screens (login/signup) storing JWT (httpOnly cookie preferred over localStorage).
2. Document upload UI with status polling (processing → ready).
3. Chat UI: message list, streaming responses, session switcher, "sources used" panel showing retrieved chunks.
4. Multi-document management view (list, delete, re-index).

**Milestone:** A working end-to-end demo: sign up → upload → ask → follow-up → see sources.

---

## Phase 6 — Deployment (Railway)

1. Two Railway services: `client` (static build or Vite preview) and `server` (Node/Express), both pointing at the existing Postgres and Redis services.
2. Environment variables per service (DB_URL, REDIS_URL, JWT_SECRET, embedding/LLM API keys) — set in Railway dashboard, never committed.
3. `docker-compose.yml` (you already have this) mirrors Railway's service topology for local dev parity.
4. Enable pgvector extension on the Railway Postgres instance (`CREATE EXTENSION IF NOT EXISTS vector;`).
5. Set up health-check endpoints so Railway restarts unhealthy deploys automatically.
6. Custom domain + HTTPS via Railway once stable.

**Milestone:** Publicly accessible URL, fully functioning, backed by Railway-hosted Postgres/Redis.

---

## Phase 7 — Hardening (do after the demo works)

- Rate limiting on upload/query endpoints.
- File size/type validation on upload.
- Input sanitization, prompt-injection basic mitigations (treat retrieved doc content as data, not instructions).
- Logging/monitoring (Railway logs or an external tool).
- Cost controls: cap tokens per request, cap documents per user, cap uploads per day.

---

## Suggested Build Order (for momentum)

1. Auth + DB schema → deploy skeleton to Railway
2. Ingestion pipeline (upload → chunks → embeddings in pgvector)
3. RAG query pipeline (no memory yet — single-turn Q&A)
4. Redis conversation memory (multi-turn)
5. Frontend polish
6. Hardening + final deployment cleanup

This order keeps every phase independently demoable, which makes debugging and handing off to another AI assistant (with this plan as context) straightforward — just say "I'm on Phase X" and share the relevant code.
