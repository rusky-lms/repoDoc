# RepoDoctor — PRD

## Problem Statement
Autonomous Bug Fixing Agent: "Give me a repo → I find, reproduce, fix, and PR bugs automatically—with explainable reasoning."

## Architecture
- **Frontend**: React 19 + Tailwind CSS + shadcn UI (dark terminal theme)
- **Backend**: FastAPI + MongoDB (Motor async)
- **LLM**: Gemini 3 Flash via emergentintegrations (Emergent Universal Key)
- **Agent Loop**: Inspired by OpenClaw — observe → decide → act → verify → create_pr
- **Integrations**: Telegram Bot (direct API), GitHub REST API

## Core Requirements (Static)
1. Accept GitHub repo URL via web UI or Telegram `/analyze` command
2. Clone repo and build file map (language, test files, entry points)
3. Detect bugs: failing tests (pytest), lint errors (flake8), logical bugs
4. Generate minimal fixes using Gemini 3 Flash
5. Verify fixes by re-running failed tests (max 2 retries)
6. Create GitHub PR with verified fixes
7. Send Telegram progress updates throughout
8. Web dashboard: live agent loop, bug cards, code diffs, PR links

## What's Been Implemented (v1 — Feb 2026)
### Backend
- `server.py` — FastAPI with all endpoints, background task management
- `models.py` — Analysis, Bug, Fix, Settings, AgentStep Pydantic models
- `agent.py` — Full agentic loop: clone → file map → strategy → run tests → run lint → generate fixes (Gemini) → apply → verify → create PR
- `github_service.py` — GitHubService: create branch, commit, push, create PR via REST API
- `telegram_service.py` — TelegramService: polling loop, `/analyze` command handler, message sending

### Frontend
- `App.js` — Router with NavBar layout
- `Dashboard.jsx` — Stats bar, submit form, active/recent analyses list
- `AnalysisDetail.jsx` — Live agent loop stepper + tabs (Bugs/Fixes/Logs) + PR link
- `History.jsx` — All analyses with filter, delete
- `Settings.jsx` — GitHub PAT + Telegram token + chat ID config
- `AgentStepper.jsx` — Animated 5-step stepper (observe/decide/act/verify/create_pr)
- `CodeDiff.jsx` — Red/green diff viewer with JetBrains Mono
- `LogStream.jsx` — Live auto-scrolling log stream
- `BugCard.jsx` — Bug type badges (test/lint/logical), severity, stacktrace, fix explanation
- `NavBar.jsx` — Fixed header with logo, nav links, live indicator

### API Endpoints
- `POST /api/analyses` — Start analysis (triggers background asyncio task)
- `GET /api/analyses` — List all analyses
- `GET /api/analyses/{id}` — Get full analysis (with logs, bugs, fixes, agent_steps)
- `DELETE /api/analyses/{id}` — Delete analysis
- `GET /api/analyses/{id}/stream` — SSE log stream
- `GET /api/stats` — Dashboard stats
- `GET /api/settings` — Get settings
- `POST /api/settings` — Save settings (triggers service re-init)
- `GET /api/health` — Health check (shows telegram/github status)

## Test Results (Feb 2026)
- Backend: 8/8 tests passed (100%)
- Frontend: 95% pass rate (minor data-testid issues fixed)
- Live analysis tested: mgedmin/check-python-versions — completed successfully

## Prioritized Backlog

### P0 (Critical — missing for full functionality)
- [ ] User needs to add their GitHub PAT via Settings page
- [ ] User needs to create Telegram bot via @BotFather and add token

### P1 (High Value Next Steps)
- [ ] JavaScript/TypeScript repo support (jest + eslint detection)
- [ ] Logical bug detection via LLM static analysis (no test runner needed)
- [ ] Analysis retry/re-run button in UI
- [ ] Webhook mode for Telegram (instead of polling) for production

### P2 (Nice to Have)
- [ ] Multi-language support (Java, Ruby, Go)
- [ ] Analysis progress percentage
- [ ] Email notifications
- [ ] GitHub App integration (no PAT needed)
- [ ] Diff syntax highlighting (prism.js)

## Next Tasks
1. Add GitHub PAT in Settings → Enable PR creation
2. Add Telegram Bot Token → Enable bot commands
3. Test with a Python repo that has known failing tests
4. Test JS/TS repo support
