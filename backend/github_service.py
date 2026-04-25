import httpx
import asyncio
import logging
import os
import re
import base64
from typing import List

logger = logging.getLogger(__name__)


class GitHubService:
    def __init__(self, token: str):
        self.token = token
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        self.api_url = "https://api.github.com"

    def _parse_repo(self, repo_url: str):
        match = re.search(r"github\.com[/:]([^/]+)/([^/\\.]+)", repo_url)
        if not match:
            raise ValueError(f"Cannot parse GitHub URL: {repo_url}")
        return match.group(1), match.group(2).replace(".git", "")

    async def _get(self, path: str) -> dict:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{self.api_url}{path}", headers=self.headers)
            return r.json()

    async def _post(self, path: str, data: dict) -> dict:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(f"{self.api_url}{path}", headers=self.headers, json=data)
            return r.json()

    async def _put(self, path: str, data: dict) -> dict:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.put(f"{self.api_url}{path}", headers=self.headers, json=data)
            return r.json()

    async def get_default_branch(self, owner: str, repo: str) -> str:
        data = await self._get(f"/repos/{owner}/{repo}")
        return data.get("default_branch", "main")

    async def get_branch_sha(self, owner: str, repo: str, branch: str) -> str:
        data = await self._get(f"/repos/{owner}/{repo}/git/ref/heads/{branch}")
        return data["object"]["sha"]

    async def create_branch(self, owner: str, repo: str, branch: str, sha: str) -> bool:
        data = await self._post(
            f"/repos/{owner}/{repo}/git/refs",
            {"ref": f"refs/heads/{branch}", "sha": sha},
        )
        return "ref" in data

    async def get_file_sha(self, owner: str, repo: str, path: str, branch: str) -> str:
        """Get existing file SHA for update (required by GitHub API)"""
        try:
            data = await self._get(f"/repos/{owner}/{repo}/contents/{path}?ref={branch}")
            return data.get("sha", "")
        except Exception:
            return ""

    async def upsert_file(self, owner: str, repo: str, path: str,
                          content: str, message: str, branch: str) -> bool:
        """Create or update a file on a branch via GitHub Contents API"""
        encoded = base64.b64encode(content.encode("utf-8")).decode("utf-8")
        existing_sha = await self.get_file_sha(owner, repo, path, branch)
        payload = {
            "message": message,
            "content": encoded,
            "branch": branch,
        }
        if existing_sha:
            payload["sha"] = existing_sha
        data = await self._put(f"/repos/{owner}/{repo}/contents/{path}", payload)
        return "content" in data

    async def create_pr(self, repo_url: str, repo_dir: str, analysis_id: str, fixes: list) -> str:
        owner, repo = self._parse_repo(repo_url)
        branch_name = f"repodoctor/fix-{analysis_id[:8]}"
        short_id = analysis_id[:8]

        # Get default branch and its HEAD SHA
        default_branch = await self.get_default_branch(owner, repo)
        base_sha = await self.get_branch_sha(owner, repo, default_branch)

        # Create new branch
        created = await self.create_branch(owner, repo, branch_name, base_sha)
        if not created:
            # Branch might already exist — ignore
            logger.warning(f"Branch {branch_name} may already exist")

        # Commit each fixed file via Contents API
        committed_files = []
        verified_fixes = [f for f in fixes if f.get("verified")]

        for fix in verified_fixes:
            file_rel = fix.get("file", "").lstrip("./")
            if not file_rel:
                continue

            full_path = os.path.join(repo_dir, file_rel)
            if not os.path.exists(full_path):
                # Try with leading ./
                alt = os.path.join(repo_dir, fix.get("file", ""))
                if os.path.exists(alt):
                    full_path = alt
                    file_rel = fix.get("file", "").lstrip("./")
                else:
                    logger.warning(f"Fixed file not found: {file_rel}")
                    continue

            try:
                with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                    new_content = f.read()
            except Exception as e:
                logger.warning(f"Could not read fixed file {file_rel}: {e}")
                continue

            commit_msg = f"fix({file_rel}): {fix.get('explanation', 'bug fix')[:72]}"
            ok = await self.upsert_file(owner, repo, file_rel, new_content, commit_msg, branch_name)
            if ok:
                committed_files.append(file_rel)
                logger.info(f"Committed fix to {file_rel} on branch {branch_name}")
            else:
                logger.warning(f"Failed to commit fix to {file_rel}")

        if not committed_files:
            raise Exception("No fixed files could be committed to the branch")

        # Build PR description
        fix_lines = "\n".join(
            f"- **{f.get('file', '?')}**: {f.get('explanation', 'fixed')}"
            for f in verified_fixes[:5]
        )
        pr_body = f"""## RepoDoctor Autonomous Fix

This PR was automatically generated by **[RepoDoctor](https://repodoctor-1.preview.emergentagent.com)** — an autonomous bug fixing agent.

### Bugs Fixed ({len(verified_fixes)})
{fix_lines}

### What RepoDoctor did
1. Cloned repository and built file map
2. Ran tests (`pytest`) and lint (`flake8`) to find failures
3. Used **Gemini 3 Flash** to generate minimal, targeted fixes
4. Verified each fix by re-running the checks
5. Opened this PR for your review

> Analysis ID: `{short_id}` &nbsp;|&nbsp; Files changed: `{', '.join(committed_files[:3])}`

---
*Please review the changes above and merge if they look correct.*
"""

        pr_data = await self._post(
            f"/repos/{owner}/{repo}/pulls",
            {
                "title": f"fix: {len(verified_fixes)} bug(s) fixed by RepoDoctor [{short_id}]",
                "body": pr_body,
                "head": branch_name,
                "base": default_branch,
            },
        )

        if "html_url" not in pr_data:
            raise Exception(f"PR creation failed: {pr_data.get('message', str(pr_data))}")

        return pr_data["html_url"]
