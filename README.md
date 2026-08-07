# KnowledgePilot-AI
A multi-user AI knowledge assistant. Users can upload PDFs, Word documents, or text files, which go through a document ingestion pipeline where the content is extracted, cleaned, chunked, converted into embeddings, and stored in a vector database.

## Phase 1 status

Phase 1 is scaffolded in the `server` app:

- JWT auth endpoints: `POST /auth/signup` and `POST /auth/login`
- Protected identity endpoint: `GET /me`
- Health endpoint: `GET /health`
- Postgres schema bootstrap on server startup
- Redis connection wiring for local Docker and Railway env-based deploys

## Run locally

1. Copy `server/.env.example` to `server/.env` and adjust secrets if needed.
2. Start the stack with `docker compose up --build`.
3. The backend will be available at `http://localhost:8080`.
