from fastapi import FastAPI, APIRouter, HTTPException, Depends, status
from fastapi.security import OAuth2PasswordRequestForm
from auth import get_password_hash, verify_password, create_access_token, oauth2_scheme, ALGORITHM, SECRET_KEY
from jose import JWTError, jwt
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import asyncpg
from db import PgDatabase
import certifi
import os
import logging
import asyncio
import json
import httpx
from pathlib import Path
from datetime import datetime, timezone
import time
import uuid
from typing import List, Optional

from models import Analysis, AnalysisCreate, Settings, AskRequest
from agent import run_analysis_task
from llm import LlmChat, UserMessage
from github_service import GitHubService
from watcher_service import WatcherService
import guardrails_service as gs_mod

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

class UnavailableDatabase:
    def __init__(self, reason: str):
        self.reason = reason

    def __getattr__(self, name: str):
        raise HTTPException(status_code=503, detail=f"Database unavailable: {self.reason}")

database_url = os.environ.get("DATABASE_URL", "")
pool = None
db = None

app = FastAPI(title="repoDoc API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

async def get_current_user(token: str = Depends(oauth2_scheme)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    
    if db is None or isinstance(db, UnavailableDatabase):
        raise HTTPException(status_code=503, detail="Database unavailable")
        
    user = await db.users.find_one({"username": username})
    if user is None:
        raise credentials_exception
    return user

@api_router.post("/auth/register")
async def register(body: dict):
    username = body.get("username")
    password = body.get("password")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required")
    
    existing = await db.users.find_one({"username": username})
    if existing:
        raise HTTPException(status_code=400, detail="Username already registered")
        
    import uuid
    user_id = str(uuid.uuid4())
    hashed_password = get_password_hash(password)
    new_user = {
        "id": user_id,
        "username": username,
        "hashed_password": hashed_password
    }
    await db.users.insert_one(new_user)
    return {"id": user_id, "username": username}

@api_router.post("/auth/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = await db.users.find_one({"username": form_data.username})
    if not user or not verify_password(form_data.password, user["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = create_access_token(data={"sub": user["username"]})
    return {"access_token": access_token, "token_type": "bearer"}


# Global services
github_svc: Optional[GitHubService] = None
watcher_svc: Optional[WatcherService] = None
_gh_comment_task = None
_watcher_task = None
_keepalive_task = None


def get_llm_key():
    return os.environ.get("LLM_API_KEY", "")


def get_keepalive_url():
    url = (os.environ.get("KEEPALIVE_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "").strip()
    if not url:
        return ""
    url = url.rstrip("/")
    if not url.endswith("/api/health"):
        url += "/api/health"
    return url


async def keepalive_loop():
    url = get_keepalive_url()
    if not url:
        return

    try:
        interval = int(os.environ.get("KEEPALIVE_INTERVAL_SECONDS", "540"))
    except ValueError:
        interval = 540
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        while True:
            await asyncio.sleep(interval)
            try:
                response = await client.get(url)
                logger.info("Keepalive ping %s -> %s", url, response.status_code)
            except Exception as exc:
                logger.warning("Keepalive ping failed: %s", exc)


async def _agent_runner(analysis_id: str, repo_url: str, target_branch: Optional[str] = None,
                        seed_bugs: Optional[list] = None, watch_event_id: Optional[str] = None):
    """Wrapper that injects current service refs into the agent."""
    analysis = await db.analyses.find_one({"id": analysis_id})
    user_id = analysis.get("user_id") if analysis else None

    local_gh = None

    if user_id:
        settings = await db.settings.find_one({"user_id": user_id})
        if settings:
            from github_service import GitHubService
            if settings.get("github_token"):
                local_gh = GitHubService(settings["github_token"])

    await run_analysis_task(
        analysis_id=analysis_id,
        repo_url=repo_url,
        db=db,
        llm_key=get_llm_key(),
        github_svc=local_gh,
        target_branch=target_branch,
        seed_bugs=seed_bugs,
        watch_event_id=watch_event_id,
    )


async def init_services():
    global github_svc, watcher_svc, _gh_comment_task, _watcher_task
    try:
        settings = await db.settings.find_one({"id": "global"})
        if not settings:
            # Fallback to the first user's settings
            settings = await db.settings.find_one({})
    except Exception as exc:
        logger.warning("Skipping optional service initialization; DB is not reachable: %s", exc)
        return

    gh_token = (settings or {}).get("github_token") or os.environ.get("GITHUB_TOKEN", "")

    if gh_token:
        github_svc = GitHubService(gh_token)
        # Start GitHub PR comment polling
        if _gh_comment_task is None or _gh_comment_task.done():
            _gh_comment_task = asyncio.create_task(
                github_svc.poll_pr_comments(db, get_llm_key())
            )

    # Start the continuous repo watcher (runs always; no-op if no watched repos)
    if watcher_svc is None:
        watcher_svc = WatcherService()
    if _watcher_task is None or _watcher_task.done():
        _watcher_task = asyncio.create_task(
            watcher_svc.start(db, _agent_runner, get_llm_key)
        )


@app.on_event("startup")
async def startup():
    global pool, db, _keepalive_task
    if database_url:
        try:
            pool = await asyncpg.create_pool(database_url, ssl='require')
            db = PgDatabase(pool)
        except Exception as exc:
            db = UnavailableDatabase(str(exc))
    else:
        db = UnavailableDatabase("DATABASE_URL is not configured")

    try:
        await db.analyses.update_many(
            {"status": {"$in": ["cloning", "analyzing", "fixing", "verifying", "creating_pr"]}},
            {"$set": {"status": "failed", "error": "Server restarted during analysis"}}
        )
    except Exception as exc:
        logger.warning("DB startup cleanup failed; continuing so web server can bind: %s", exc)
    await init_services()
    if get_keepalive_url() and (_keepalive_task is None or _keepalive_task.done()):
        _keepalive_task = asyncio.create_task(keepalive_loop())


@app.on_event("shutdown")
async def shutdown():
    global _gh_comment_task, _watcher_task, _keepalive_task
    if _gh_comment_task:
        _gh_comment_task.cancel()
    if _watcher_task:
        _watcher_task.cancel()
    if _keepalive_task:
        _keepalive_task.cancel()
    if pool:
        await pool.close()


# ── GitHub Webhook ────────────────────────────────────────────────────────────

@api_router.post("/webhook/github")
async def github_webhook(request: dict):
    """Receive GitHub webhook events for PR comments."""
    action = request.get("action", "")
    comment = request.get("comment", {})
    pr = request.get("issue", {}) or request.get("pull_request", {})
    pr_url = pr.get("html_url", "")

    if action == "created" and comment and pr_url:
        # Find the matching analysis
        analysis = await db.analyses.find_one({"pr_url": pr_url}, {"_id": 0})
        if analysis:
            user_id = analysis.get("user_id")
            if user_id:
                settings = await db.settings.find_one({"user_id": user_id})
                if settings and settings.get("github_token"):
                    from github_service import GitHubService
                    local_github_svc = GitHubService(settings["github_token"])
                    asyncio.create_task(
                        local_github_svc._check_and_reply(analysis, db, get_llm_key())
                    )
    return {"ok": True}


# ── Analysis Routes ───────────────────────────────────────────────────────────

@api_router.post("/analyses", response_model=dict)
async def create_analysis(body: AnalysisCreate, current_user: dict = Depends(get_current_user)):
    analysis = Analysis(
        user_id=current_user["id"],
        repo_url=body.repo_url,
    )
    doc = analysis.model_dump()
    await db.analyses.insert_one(doc)

    settings = await db.settings.find_one({"user_id": current_user["id"]})
    local_gh = None
    if settings:
        from github_service import GitHubService
        if settings.get("github_token"):
            local_gh = GitHubService(settings["github_token"])

    asyncio.create_task(run_analysis_task(
        analysis.id, body.repo_url, db, get_llm_key(),
        github_svc=local_gh,
    ))

    return {"id": analysis.id, "status": "queued", "message": "Analysis started"}


@api_router.get("/analyses", response_model=List[dict])
async def list_analyses(current_user: dict = Depends(get_current_user)):
    docs = await db.analyses.find({"user_id": current_user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)
    for doc in docs:
        doc.pop("logs", None)
        doc.pop("file_map", None)
    return docs


@api_router.get("/analyses/{analysis_id}", response_model=dict)
async def get_analysis(analysis_id: str, current_user: dict = Depends(get_current_user)):
    doc = await db.analyses.find_one({"id": analysis_id, "user_id": current_user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return doc


@api_router.delete("/analyses/{analysis_id}")
async def delete_analysis(analysis_id: str, current_user: dict = Depends(get_current_user)):
    result = await db.analyses.delete_one({"id": analysis_id, "user_id": current_user["id"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Analysis not found")
    return {"message": "Deleted"}


@api_router.get("/analyses/{analysis_id}/stream")
async def stream_logs(analysis_id: str, token: str = None):
    # Decode token manually since EventSource can't send headers easily
    if not token:
        raise HTTPException(status_code=401, detail="Token required")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise HTTPException(status_code=401, detail="Invalid token")
        user = await db.users.find_one({"username": username})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        user_id = user["id"]
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    async def event_generator():
        last_count = 0
        attempts = 0
        while attempts < 300:
            doc = await db.analyses.find_one({"id": analysis_id, "user_id": user_id}, {"_id": 0, "logs": 1, "status": 1})
            if not doc:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Not found'})}\n\n"
                break
            logs = doc.get("logs", [])
            if len(logs) > last_count:
                for log in logs[last_count:]:
                    yield f"data: {json.dumps({'type': 'log', **log})}\n\n"
                last_count = len(logs)
            status = doc.get("status", "")
            if status in ("completed", "failed"):
                yield f"data: {json.dumps({'type': 'done', 'status': status})}\n\n"
                break
            yield f"data: {json.dumps({'type': 'heartbeat', 'status': status})}\n\n"
            await asyncio.sleep(1)
            attempts += 1

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Follow-up Q&A Rate Limiter & Route ─────────────────────────────────────────

_user_ask_history: dict[str, list[float]] = {}
ASK_RATE_LIMIT = 10
ASK_WINDOW_SECONDS = 60.0

def check_ask_rate_limit(user_id: str):
    now = time.time()
    history = _user_ask_history.get(user_id, [])
    history = [t for t in history if now - t < ASK_WINDOW_SECONDS]
    if len(history) >= ASK_RATE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded. Maximum {ASK_RATE_LIMIT} questions per minute. Please try again shortly."
        )
    history.append(now)
    _user_ask_history[user_id] = history


@api_router.post("/analyses/{analysis_id}/ask")
async def ask_analysis_question(
    analysis_id: str,
    body: AskRequest,
    current_user: dict = Depends(get_current_user)
):
    question = (body.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    check_ask_rate_limit(current_user["id"])

    analysis = await db.analyses.find_one({"id": analysis_id, "user_id": current_user["id"]}, {"_id": 0})
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    repo_name = analysis.get("repo_name") or analysis.get("repo_url", "unknown")
    summary = analysis.get("summary", "")
    bugs = analysis.get("bugs", [])
    fixes = analysis.get("fixes", [])

    context_lines = [
        f"Repository: {repo_name}",
        f"Analysis Status: {analysis.get('status', 'unknown')}",
    ]
    if summary:
        context_lines.append(f"\nStored Summary:\n{summary}")

    if bugs:
        context_lines.append(f"\nStored Findings ({len(bugs)}):")
        for b in bugs:
            context_lines.append(
                f"- [{b.get('severity', 'medium')}] {b.get('type', 'bug')} in {b.get('file', '?')}:{b.get('line', '?')} - {b.get('description', '')}"
            )
    else:
        context_lines.append("\nStored Findings: No bugs or issues found.")

    if fixes:
        context_lines.append(f"\nStored Fixes & Diff Explanations ({len(fixes)}):")
        for f in fixes:
            why = f.get("why_this_change") or f.get("explanation", "")
            context_lines.append(
                f"File: {f.get('file', '')}\nVerified: {f.get('verified', False)}\nExplanation: {why}"
            )
            diff = f.get("diff", "")
            if diff:
                context_lines.append(f"Diff:\n{diff[:1500]}")
    else:
        context_lines.append("\nStored Fixes: No fixes generated.")

    context_str = "\n".join(context_lines)

    history_lines = []
    if body.history:
        for turn in body.history[-6:]:
            role = turn.get("role", "user")
            content = turn.get("content", "")
            history_lines.append(f"{role.capitalize()}: {content}")
    history_str = ("\n\nRecent Conversation History:\n" + "\n".join(history_lines)) if history_lines else ""

    prompt = f"""You are repoDoc AI assistant answering a follow-up question about this code analysis run.

CRITICAL INSTRUCTIONS:
1. Answer using ONLY the stored findings, diffs, explanations, and summary provided in the context below.
2. Do NOT invent, assume, or fabricate any facts, files, lines of code, or fixes outside of this provided context.
3. If the question cannot be answered using the stored findings, diffs, or explanations below, reply:
   "I cannot answer this based on the stored findings and diffs for this analysis."
4. Be concise, technical, and helpful.

Context for Analysis {analysis_id}:
{context_str}{history_str}

User Question: {question}
"""

    llm_key = get_llm_key()
    if not llm_key:
        raise HTTPException(status_code=500, detail="LLM API key not configured")

    try:
        chat = LlmChat(
            api_key=llm_key,
            session_id=f"qa-{analysis_id}-{uuid.uuid4()}",
            system_message="You are repoDoc Q&A assistant. You answer questions strictly grounded in the provided analysis findings, diffs, and explanations."
        ).with_model("gemini", "gemini-3-flash-preview")
        answer = await chat.send_message(UserMessage(text=prompt))
        return {
            "analysis_id": analysis_id,
            "question": question,
            "answer": answer.strip()
        }
    except Exception as e:
        logger.error(f"Error in ask endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate answer: {str(e)}")


@app.post("/analyses/{analysis_id}/ask")
async def ask_analysis_question_root(
    analysis_id: str,
    body: AskRequest,
    current_user: dict = Depends(get_current_user)
):
    return await ask_analysis_question(analysis_id, body, current_user)


# ── Stats Route ───────────────────────────────────────────────────────────────

@api_router.get("/stats")
async def get_stats(current_user: dict = Depends(get_current_user)):
    user_id = current_user["id"]
    total = await db.analyses.count_documents({"user_id": user_id})
    completed = await db.analyses.count_documents({"user_id": user_id, "status": "completed"})
    failed = await db.analyses.count_documents({"user_id": user_id, "status": "failed"})
    running = await db.analyses.count_documents({"user_id": user_id, "status": {"$nin": ["completed", "failed", "queued"]}})
    pipeline = [
        {"$group": {"_id": None,
                    "bugs": {"$sum": {"$size": {"$ifNull": ["$bugs", []]}}},
                    "fixes": {"$sum": {"$size": {"$filter": {"input": {"$ifNull": ["$fixes", []]},
                                                              "cond": {"$eq": ["$$this.verified", True]}}}}}}}
    ]
    # For stats, our mock db.aggregate doesn't support $match, so we just return total bugs/fixes for all analyses 
    # Or we can just calculate them here
    docs = await db.analyses.find({"user_id": user_id}).to_list()
    bugs_total = sum(len(d.get("bugs") or []) for d in docs)
    fixes_total = sum(1 for d in docs for fix in (d.get("fixes") or []) if isinstance(fix, dict) and fix.get("verified"))
    prs = sum(1 for d in docs if d.get("pr_url"))
    return {
        "total_analyses": total,
        "completed": completed,
        "failed": failed,
        "running": running,
        "bugs_found": bugs_total,
        "fixes_applied": fixes_total,
        "prs_created": prs,
    }


# ── Settings Routes ───────────────────────────────────────────────────────────

@api_router.get("/settings")
async def get_settings(current_user: dict = Depends(get_current_user)):
    doc = await db.settings.find_one({"user_id": current_user["id"]}, {"_id": 0})
    if not doc:
        return Settings().model_dump()
    result = dict(doc)
    result.pop("telegram_bot_token", None)
    result.pop("telegram_chat_id", None)
    if result.get("github_token"):
        t = result["github_token"]
        result["github_token_masked"] = t[:4] + "****" + t[-4:] if len(t) > 8 else "****"
    return result


@api_router.post("/settings")
async def save_settings(body: dict, current_user: dict = Depends(get_current_user)):
    import uuid
    body["user_id"] = current_user["id"]
    body["updated_at"] = datetime.now(timezone.utc).isoformat()
    body.pop("telegram_bot_token", None)
    body.pop("telegram_chat_id", None)
    
    # Avoid duplicate 'global' ID constraint violations from default frontend payload
    existing = await db.settings.find_one({"user_id": current_user["id"]})
    if existing:
        body["id"] = existing.get("id", str(uuid.uuid4()))
    else:
        body["id"] = str(uuid.uuid4())
        
    await db.settings.replace_one({"user_id": current_user["id"]}, body, upsert=True)
    await init_services()
    return {"message": "Settings saved"}


@api_router.get("/health")
async def health():
    return {"status": "ok", "github": github_svc is not None}


# ── Guardrails Routes ─────────────────────────────────────────────────────────

@api_router.get("/guardrails/builtin")
async def list_builtin_guardrails():
    return {
        "rules": gs_mod.BUILTIN_RULES,
        "presets": [
            {"key": k, **v} for k, v in gs_mod.PRESET_TEMPLATES.items()
        ],
    }


@api_router.post("/guardrails/from-preset")
async def create_guardrails_from_preset(body: dict, current_user: dict = Depends(get_current_user)):
    preset_key = body.get("preset", "startup")
    template = gs_mod.build_guardrails_from_preset(preset_key)
    from models import Guardrails
    gr = Guardrails(
        user_id=current_user["id"],
        name=body.get("name") or template["name"],
        description=template["description"],
        rules=template["rules"],
    )
    doc = gr.model_dump()
    await db.guardrails.insert_one(dict(doc))
    return doc


@api_router.get("/guardrails")
async def list_guardrails(current_user: dict = Depends(get_current_user)):
    docs = await db.guardrails.find({"user_id": current_user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return docs


@api_router.get("/guardrails/{gid}")
async def get_guardrails(gid: str, current_user: dict = Depends(get_current_user)):
    doc = await db.guardrails.find_one({"id": gid, "user_id": current_user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Guardrails not found")
    return doc


@api_router.post("/guardrails")
async def create_guardrails(body: dict, current_user: dict = Depends(get_current_user)):
    from models import Guardrails
    gr = Guardrails(
        user_id=current_user["id"],
        name=body.get("name", "Custom Ruleset"),
        description=body.get("description", ""),
        rules=body.get("rules", []),
    )
    doc = gr.model_dump()
    await db.guardrails.insert_one(dict(doc))
    return doc


@api_router.put("/guardrails/{gid}")
async def update_guardrails(gid: str, body: dict, current_user: dict = Depends(get_current_user)):
    body.pop("_id", None)
    body["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await db.guardrails.update_one({"id": gid, "user_id": current_user["id"]}, {"$set": body})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Guardrails not found")
    return await db.guardrails.find_one({"id": gid}, {"_id": 0})


@api_router.delete("/guardrails/{gid}")
async def delete_guardrails(gid: str, current_user: dict = Depends(get_current_user)):
    result = await db.guardrails.delete_one({"id": gid, "user_id": current_user["id"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Guardrails not found")
    # Detach from any watched repos
    await db.watched_repos.update_many({"guardrails_id": gid}, {"$set": {"guardrails_id": None}})
    return {"message": "Deleted"}


# ── Watched Repos Routes ──────────────────────────────────────────────────────

@api_router.get("/watched-repos")
async def list_watched_repos(current_user: dict = Depends(get_current_user)):
    docs = await db.watched_repos.find({"user_id": current_user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return docs


@api_router.post("/watched-repos")
async def add_watched_repo(body: dict, current_user: dict = Depends(get_current_user)):
    from models import WatchedRepo
    wr = WatchedRepo(
        user_id=current_user["id"],
        repo_url=body.get("repo_url", ""),
        guardrails_id=body.get("guardrails_id"),
    )
    if not wr.repo_url:
        raise HTTPException(status_code=400, detail="repo_url required")
    # Pre-fill repo_name
    try:
        owner = wr.repo_url.rstrip("/").split("/")[-2]
        name = wr.repo_url.rstrip("/").split("/")[-1].replace(".git", "")
        wr.repo_name = f"{owner}/{name}"
    except Exception:
        pass
    doc = wr.model_dump()
    await db.watched_repos.insert_one(dict(doc))
    return doc


@api_router.put("/watched-repos/{wid}")
async def update_watched_repo(wid: str, body: dict, current_user: dict = Depends(get_current_user)):
    body.pop("_id", None)
    body.pop("id", None)
    result = await db.watched_repos.update_one({"id": wid, "user_id": current_user["id"]}, {"$set": body})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Watched repo not found")
    return await db.watched_repos.find_one({"id": wid}, {"_id": 0})


@api_router.delete("/watched-repos/{wid}")
async def delete_watched_repo(wid: str, current_user: dict = Depends(get_current_user)):
    result = await db.watched_repos.delete_one({"id": wid, "user_id": current_user["id"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Watched repo not found")
    return {"message": "Deleted"}


@api_router.post("/watched-repos/{wid}/check-now")
async def check_watched_repo_now(wid: str):
    """Force an immediate watcher pass for a single repo."""
    watched = await db.watched_repos.find_one({"id": wid}, {"_id": 0})
    if not watched:
        raise HTTPException(status_code=404, detail="Watched repo not found")
    
    if watcher_svc is None:
        raise HTTPException(status_code=400, detail="Watcher not initialized")
    asyncio.create_task(
        watcher_svc.check_repo(watched, db, _agent_runner, get_llm_key())
    )
    return {"message": "Check triggered"}


@api_router.post("/watched-repos/{wid}/replay")
async def replay_last_commit(wid: str):
    """Demo helper: reset all branch SHAs to a fake old value so the next
    watcher pass treats the current HEAD of every branch as a new commit
    (re-evaluates guardrails + opens issue + fix PR). Then trigger a check."""
    watched = await db.watched_repos.find_one({"id": wid}, {"_id": 0})
    if not watched:
        raise HTTPException(status_code=404, detail="Watched repo not found")
    
    if watcher_svc is None:
        raise HTTPException(status_code=400, detail="Watcher not initialized")

    fake_sha = "0" * 40
    current = watched.get("last_commits") or {}
    reset = {b: fake_sha for b in current.keys()} if current else {"main": fake_sha}
    await db.watched_repos.update_one(
        {"id": wid}, {"$set": {"last_commits": reset}}
    )
    watched["last_commits"] = reset
    asyncio.create_task(
        watcher_svc.check_repo(watched, db, _agent_runner, get_llm_key())
    )
    return {"message": "Replay triggered — alert + PR will land in ~25s"}


@api_router.get("/watch-events")
async def list_watch_events(watched_repo_id: Optional[str] = None, limit: int = 50, current_user: dict = Depends(get_current_user)):
    q = {"user_id": current_user["id"]}
    if watched_repo_id:
        q["watched_repo_id"] = watched_repo_id
    docs = await db.watch_events.find(q, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return docs


app.include_router(api_router)

BUILD_DIR = ROOT_DIR / "static"
STATIC_ASSETS_DIR = BUILD_DIR / "static"

if BUILD_DIR.exists():
    if STATIC_ASSETS_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_ASSETS_DIR), name="static-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        return FileResponse(BUILD_DIR / "index.html")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
