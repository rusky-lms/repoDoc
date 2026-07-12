"""Continuous repo monitor: polls watched repos for new commits, evaluates guardrails,
creates GitHub issues, sends Telegram alerts, and triggers fix PRs."""

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from guardrails_service import evaluate_diff, violations_to_bugs

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 300  # 5 minutes


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def _format_violations_md(violations: list) -> str:
    if not violations:
        return "_No specific violations recorded._"
    lines = []
    for v in violations[:20]:
        sev = v.get("severity", "warning").upper()
        rule = v.get("rule_name", "rule")
        file = v.get("file", "?")
        desc = v.get("description", "")[:200]
        snippet = v.get("line_snippet", "")
        line = f"- **[{sev}] {rule}** in `{file}` — {desc}"
        if snippet:
            line += f"\n    ```\n    {snippet}\n    ```"
        lines.append(line)
    return "\n".join(lines)


def _format_violations_telegram(violations: list) -> str:
    if not violations:
        return ""
    lines = []
    for v in violations[:5]:
        sev = v.get("severity", "warning").upper()
        rule = v.get("rule_name", "rule")
        file = v.get("file", "?")
        lines.append(f"  • <b>[{sev}]</b> {rule} — <code>{file}</code>")
    extra = f"\n  …and {len(violations)-5} more" if len(violations) > 5 else ""
    return "\n".join(lines) + extra


class WatcherService:
    def __init__(self):
        self._running = False

    async def start(self, db, agent_runner, get_llm_key):
        """Background poller. Pass getter functions so we always pick up the latest service refs."""
        self._running = True
        logger.info(f"Watcher service started (interval={POLL_INTERVAL_SECONDS}s)")
        while self._running:
            try:
                await self.tick(db, agent_runner, get_llm_key())
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Watcher tick error: {e}")
            await asyncio.sleep(POLL_INTERVAL_SECONDS)

    def stop(self):
        self._running = False

    async def tick(self, db, agent_runner, llm_key: str):
        """Run one polling pass over all active watched repos."""
        
        repos = await db.watched_repos.find({"active": True}, {"_id": 0}).to_list(100)
        if not repos:
            return
        logger.info(f"Watcher tick: scanning {len(repos)} repo(s)")
        for repo in repos:
            try:
                await self.check_repo(repo, db, agent_runner, llm_key)
            except Exception as e:
                logger.warning(f"Watcher check_repo error for {repo.get('repo_url')}: {e}")

    async def check_repo(self, watched: dict, db, agent_runner, llm_key: str):
        """Check a single watched repo: detect new commits per branch and process them."""
        repo_url = watched.get("repo_url", "")
        user_id = watched.get("user_id")
        settings = await db.settings.find_one({"user_id": user_id})
        if not settings or not settings.get("github_token"):
            logger.warning(f"No github token for user_id {user_id}")
            return
            
        from github_service import GitHubService
        from telegram_service import TelegramService
        github_svc = GitHubService(settings["github_token"])
        telegram_svc = TelegramService(settings["telegram_bot_token"]) if settings.get("telegram_bot_token") else None
        
        try:
            owner, repo = github_svc._parse_repo(repo_url)
        except Exception as e:
            logger.warning(f"Bad repo_url {repo_url}: {e}")
            return

        full_name = f"{owner}/{repo}"
        await db.watched_repos.update_one(
            {"id": watched["id"]},
            {"$set": {"last_checked_at": utc_now(), "repo_name": full_name}},
        )

        branches = await github_svc.list_branches(owner, repo)
        if not branches:
            return

        last_commits = dict(watched.get("last_commits") or {})
        is_first_run = len(last_commits) == 0

        # Load guardrails (per-repo)
        guardrails = None
        gid = watched.get("guardrails_id")
        if gid:
            guardrails = await db.guardrails.find_one({"id": gid}, {"_id": 0})

        chat_id = watched.get("telegram_chat_id") or ""

        for b in branches:
            branch = b["name"]
            sha = b["sha"]
            if not sha:
                continue
            previous_sha = last_commits.get(branch)

            # First-ever check: just record current SHAs without alerting
            if is_first_run:
                last_commits[branch] = sha
                # Trigger an initial scan for the main/master branch to check existing code
                if branch in ("main", "master") and agent_runner:
                    from models import Analysis
                    analysis = Analysis(
                        repo_url=repo_url,
                        telegram_chat_id=chat_id or None,
                        target_branch=branch,
                        triggered_by="initial_scan",
                    )
                    doc_analysis = analysis.model_dump()
                    await db.analyses.insert_one(doc_analysis)
                    asyncio.create_task(agent_runner(
                        analysis_id=analysis.id,
                        repo_url=repo_url,
                        target_branch=branch,
                        seed_bugs=None,
                        watch_event_id=None,
                        telegram_chat_id=chat_id or None,
                    ))
                continue

            if previous_sha == sha:
                continue  # no new commit

            # New commit on this branch — process it
            await self._process_commit(
                watched, full_name, repo_url, owner, repo, branch, sha,
                guardrails, db, github_svc, telegram_svc, agent_runner, llm_key, chat_id,
            )
            last_commits[branch] = sha

        await db.watched_repos.update_one(
            {"id": watched["id"]},
            {"$set": {"last_commits": last_commits}},
        )

    async def _process_commit(self, watched, full_name, repo_url, owner, repo,
                              branch, sha, guardrails, db, github_svc, telegram_svc,
                              agent_runner, llm_key, chat_id):
        commit_data = await github_svc.get_commit(owner, repo, sha)
        if not isinstance(commit_data, dict) or "sha" not in commit_data:
            return
        commit_msg = (commit_data.get("commit") or {}).get("message", "")[:200]
        author_obj = (commit_data.get("commit") or {}).get("author") or {}
        author = author_obj.get("name", "unknown")

        diff_text = github_svc.build_diff_from_commit(commit_data)
        violations = []
        if guardrails and diff_text:
            violations = await evaluate_diff(diff_text, guardrails, llm_key)

        event = {
            "id": str(uuid.uuid4()),
            "watched_repo_id": watched["id"],
            "repo_name": full_name,
            "repo_url": repo_url,
            "branch": branch,
            "commit_sha": sha,
            "commit_message": commit_msg,
            "commit_author": author,
            "issues": violations,
            "github_issue_url": None,
            "analysis_id": None,
            "pr_url": None,
            "status": "issues_found" if violations else "clean",
            "created_at": utc_now(),
        }
        await db.watch_events.insert_one(dict(event))

        await db.watched_repos.update_one(
            {"id": watched["id"]},
            {"$inc": {"events_count": 1}},
        )

        if not violations:
            logger.info(f"[watcher] {full_name}@{branch[:20]} {sha[:7]} clean")
            return

        # Tell Telegram
        if telegram_svc and chat_id:
            tg_text = (
                f"<b>repoDoc — Guardrail Alert</b>\n"
                f"Repo: <code>{full_name}</code>\n"
                f"Branch: <code>{branch}</code>\n"
                f"Commit: <code>{sha[:8]}</code> by {author}\n"
                f"Message: <i>{commit_msg[:120]}</i>\n\n"
                f"Found <b>{len(violations)}</b> violation(s):\n"
                f"{_format_violations_telegram(violations)}\n\n"
                f"Auto-generating fix PR…"
            )
            try:
                await telegram_svc.send_message(chat_id, tg_text)
            except Exception:
                pass

        # Create GitHub issue
        issue_body = (
            f"**repoDoc** detected guardrail violations in commit "
            f"[`{sha[:8]}`]({commit_data.get('html_url','')}) on branch `{branch}`.\n\n"
            f"### Violations ({len(violations)})\n"
            f"{_format_violations_md(violations)}\n\n"
            f"---\n"
            f"_repoDoc will open an automated fix PR targeting `{branch}` shortly._"
        )
        issue_title = f"[repoDoc] {len(violations)} guardrail violation(s) on {branch}@{sha[:7]}"
        try:
            issue_url = await github_svc.create_issue(owner, repo, issue_title, issue_body, labels=["repodoc", "guardrails"])
        except Exception as e:
            logger.warning(f"create_issue failed: {e}")
            issue_url = ""

        if issue_url:
            await db.watch_events.update_one(
                {"id": event["id"]}, {"$set": {"github_issue_url": issue_url}}
            )
            await db.watched_repos.update_one(
                {"id": watched["id"]}, {"$inc": {"issues_count": 1}}
            )

        # Trigger fix PR via agent (asynchronously)
        if agent_runner:
            seed = violations_to_bugs(violations)
            from models import Analysis  # local import to avoid cycles
            analysis = Analysis(
                repo_url=repo_url,
                telegram_chat_id=chat_id or None,
                target_branch=branch,
                triggered_by="watcher",
            )
            doc = analysis.model_dump()
            await db.analyses.insert_one(doc)
            asyncio.create_task(agent_runner(
                analysis_id=analysis.id,
                repo_url=repo_url,
                target_branch=branch,
                seed_bugs=seed,
                watch_event_id=event["id"],
                telegram_chat_id=chat_id or None,
            ))
            await db.watch_events.update_one(
                {"id": event["id"]}, {"$set": {"analysis_id": analysis.id}}
            )
