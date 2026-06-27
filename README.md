# repoDoc

An autonomous AI-powered code review and bug-fixing agent. Point it at any GitHub repository and it will clone the repo, detect bugs via tests and static analysis, generate fixes using Google Gemini, open a pull request, and notify you over Telegram — all hands-free.

---

## Features

| Feature | Description |
|---|---|
| 🤖 **Autonomous Bug Fixing** | OODA-loop agent (Observe → Decide → Act → Verify) that detects and patches bugs automatically |
| 🔍 **Repo Watcher** | Polls watched repos every 5 minutes for new commits and evaluates each diff against guardrail rules |
| 🛡️ **Guardrails** | Configurable rule sets (pattern-based & LLM-based) for security, quality, and compliance checks |
| 🐙 **GitHub Integration** | Clones repos, creates fix branches, opens PRs, and replies to PR review comments with AI |
| 📬 **Telegram Alerts** | Sends real-time notifications for analysis results, watch events, and violations |
| 📊 **Dashboard** | React frontend to manage analyses, watched repos, guardrail profiles, settings, and history |
| 🔐 **Auth** | JWT-based user registration and login |

---

## Tech Stack

### Backend
- **Python 3.12** · FastAPI · Uvicorn
- **Google Gemini** (`google-genai`) — LLM for bug analysis and fix generation
- **PostgreSQL** (Neon) via `asyncpg`
- **GitHub REST API** — cloning, PR creation, issue creation, comment replies
- **Telegram Bot API** — notifications
- Tools: `pytest`, `flake8`, `black`

### Frontend
- **React 19** · React Router v7
- **Tailwind CSS** · Radix UI · shadcn/ui component library
- **Recharts** for data visualisation
- Built with **CRACO**

### Infrastructure
- **Docker** — multi-stage build (Node 22 for frontend, Python 3.12-slim for runtime)
- Single container serves the React SPA as static files through FastAPI

---

## Project Structure

```
repoDocv1/
├── backend/
│   ├── server.py             # FastAPI app & all API routes
│   ├── agent.py              # Core OODA bug-fixing agent
│   ├── models.py             # Pydantic data models
│   ├── db.py                 # PostgreSQL database layer
│   ├── github_service.py     # GitHub API client & PR/issue helpers
│   ├── guardrails_service.py # Built-in & custom guardrail rule evaluation
│   ├── watcher_service.py    # Continuous repo polling & event processing
│   ├── telegram_service.py   # Telegram bot notifications
│   ├── auth.py               # JWT authentication helpers
│   ├── llm.py                # LLM chat wrapper (Gemini)
│   ├── refactor.py           # Code refactoring utilities
│   └── requirements.txt
├── frontend/
│   └── src/
│       └── pages/
│           ├── Dashboard.jsx       # Submit repo for analysis
│           ├── AnalysisDetail.jsx  # Live agent step & bug/fix viewer
│           ├── Watch.jsx           # Watched repos management
│           ├── Guardrails.jsx      # Guardrail rule profiles
│           ├── History.jsx         # Past analyses
│           ├── Settings.jsx        # GitHub/Telegram token config
│           ├── Login.jsx
│           └── Register.jsx
├── Dockerfile
├── build.sh
└── .env
```

---

## Getting Started

### Prerequisites
- Python 3.12+
- Node 22+
- A PostgreSQL database (Neon or any Postgres-compatible)
- Google Gemini API key
- GitHub personal access token
- *(Optional)* Telegram bot token

### Environment Variables

Create a `.env` file in the project root:

```env
LLM_API_KEY=<your-gemini-api-key>
GITHUB_TOKEN=<your-github-pat>
TELEGRAM_BOT_TOKEN=<your-telegram-bot-token>
TELEGRAM_CHAT_ID=<your-chat-id>
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
```

### Run Locally

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8000

# Frontend (separate terminal)
cd frontend
npm install --legacy-peer-deps
npm start          # runs on http://localhost:3000
```

### Docker

```bash
docker build -t repodoc .
docker run -p 8000:8000 --env-file .env repodoc
```

The container serves both the API (`/api/...`) and the React SPA on port **8000**.

---

## How It Works

1. **Submit** a GitHub repo URL from the Dashboard.
2. The **agent** clones the repo, runs `pytest` and `flake8`, and uses Gemini to analyse failures.
3. It generates minimal code fixes, re-runs checks to **verify**, then opens a **pull request**.
4. Results stream back to the UI in real time; a **Telegram notification** is sent on completion.
5. The **Watcher** can continuously monitor repos — on each new commit it evaluates the diff against your **Guardrail** rules (e.g. no hardcoded secrets, no debug statements) and creates GitHub issues or triggers auto-fix PRs.

---

## Agent Steps

```
Observe  →  Decide  →  Act  →  Verify  →  Create PR
```

Each step is tracked in the database and displayed live in the Analysis Detail page.

---

## License

MIT
