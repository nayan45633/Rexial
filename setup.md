# Project Setup Guide (Turborepo + Pnpm + Docker):

### Project Folder Structure
```
├── apps/
│   ├── http-server/
│   ├── ws-server/
│   ├── genAI/     # FastAPI GenAI service (Python)
│   └── frontend/
│
├── packages/
│   └── db/   # Prisma + PostgreSQL setup
│
├── docker-compose.yml
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

### Prerequisites

#### Make sure you have the following installed:

- Node.js 22 or newer (the version used by CI and the Docker images)
- pnpm 9 or newer
- Python 3.11 or newer for the GenAI service
- Docker and Docker Compose for the container setup below
- Redis 7 for live quiz messaging and caching (Compose starts it for you)

For a local run without Compose, you also need PostgreSQL 15 and Redis 7
running on your machine.

#### (1) Now, fork & clone the repository
```bash
git clone https://github.com/TheCodeHeist-Coder/Rexial.git
cd Rexial
```

#### (2) Install pnpm globally if not installed

```bash
npm install -g pnpm
```

#### (3) Install dependencies
```bash
pnpm install
```

#### (4) Setup Environment Variables

*Create a `.env` in `/packages/db` and put this ennvironment variable

```bash
DATABASE_URL=postgresql://postgres:postgres@db:5432/Qtrive
```

*Create a `.env` file in `/apps/http-server` and put these variables
```bash
PORT=4000

JWT_SECRET=<yourJWTSecret>

DATABASE_URL=postgresql://postgres:postgres@db:5432/Qtrive

FRONTEND_URL=http://localhost:5173

```

If you run the WebSocket server outside Docker, copy its example environment
file and set `JWT_SECRET` to the **same value** as in `apps/http-server/.env`:

```bash
cp apps/ws-server/.env.example apps/ws-server/.env
```

With Docker Compose, `ws-server` reads `apps/http-server/.env` directly so
both services use the same signing secret. Compose also starts Redis and sets
its connection variables. You do not need a separate `apps/ws-server/.env`
for `docker compose up`.

*Create a `.env` file in `/apps/genAI` (copy from `.env.example`)
```bash
cp apps/genAI/.env.example apps/genAI/.env
```
Then fill in your keys:
```bash
GROQ_API_KEY=<yourGroqKey>
GOOGLE_API_KEY=<yourGoogleKey>
TAVILY_API_KEY=<yourTavilyKey>
```

#### (5) Start services with Docker
```bash
docker compose up --build
```
*Build all services (http-server, ws-server, frontend, genAI)
*Start PostgreSQL database
*Start Redis for WebSocket live quiz messaging and caching
*Start all containers


#### (6) Access the application
```
Frontend → http://localhost:5173
HTTP Server → http://localhost:4000
WebSocket Server → ws://localhost:8080
GenAI Service → http://localhost:8000  (docs at /docs)
PostgreSQL → localhost:5432
```

---

### Running the JavaScript services locally

The hostname `db` and the default Redis hostname `redis` work **inside**
Compose only. For a local `pnpm dev` run, start PostgreSQL 15 and Redis 7
locally, or start just those services with `docker compose up -d db redis`.
Then use `localhost` in the environment files:

```dotenv
# packages/db/.env and apps/http-server/.env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/Qtrive

# apps/ws-server/.env (in addition to the shared JWT_SECRET)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/Qtrive
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=thisistheredisPassword
```

The password above is for the Redis service in `docker-compose.yml`. If you
run a separate Redis installation without a password, leave `REDIS_PASSWORD`
unset. If you override Compose's published Redis port with `REDIS_HOST_PORT`,
set `REDIS_PORT` to that host port too.

### Running the GenAI service without Docker

The Python service is part of the Turborepo workspace, so `pnpm dev` at the
repo root starts it alongside the JS apps — but it needs a virtualenv first:

```bash
cd apps/genAI
pnpm run setup      # creates .venv and installs requirements.txt
```

After that, from the repo root:

```bash
pnpm dev            # runs frontend, http-server, ws-server and genAI
```

Or run just the AI service:

```bash
pnpm --filter genai dev
```

#### Endpoints

| Method | Path                  | Description                             |
| ------ | --------------------- | --------------------------------------- |
| GET    | `/health`             | Health check (used by Docker)           |
| POST   | `/chat`               | Chat agent, with web search when needed |
| POST   | `/generate-questions` | Generate quiz questions from a PDF      |
| POST   | `/ask-pdf`            | Ask a question about an uploaded PDF    |
