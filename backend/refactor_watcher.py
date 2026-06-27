import re
with open('watcher_service.py', 'r') as f:
    content = f.read()

content = content.replace(
    'async def start(self, db, get_github, get_telegram, agent_runner, get_llm_key):',
    'async def start(self, db, agent_runner, get_llm_key):'
)

content = content.replace(
    'await self.tick(db, get_github(), get_telegram(), agent_runner, get_llm_key())',
    'await self.tick(db, agent_runner, get_llm_key())'
)

content = content.replace(
    'async def tick(self, db, github_svc, telegram_svc, agent_runner, llm_key: str):',
    'async def tick(self, db, agent_runner, llm_key: str):'
)

content = content.replace(
    'if not github_svc:\n            return',
    ''
)

content = content.replace(
    'await self.check_repo(repo, db, github_svc, telegram_svc, agent_runner, llm_key)',
    'await self.check_repo(repo, db, agent_runner, llm_key)'
)

content = content.replace(
    'async def check_repo(self, watched: dict, db, github_svc, telegram_svc, agent_runner, llm_key: str):',
    'async def check_repo(self, watched: dict, db, agent_runner, llm_key: str):'
)

content = content.replace(
    '''        repo_url = watched.get("repo_url", "")
        try:
            owner, repo = github_svc._parse_repo(repo_url)
        except Exception as e:
            logger.warning(f"Bad repo_url {repo_url}: {e}")
            return''',
    '''        repo_url = watched.get("repo_url", "")
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
            return'''
)

with open('watcher_service.py', 'w') as f:
    f.write(content)
