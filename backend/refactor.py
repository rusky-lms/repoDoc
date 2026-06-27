import re
with open('server.py', 'r') as f:
    content = f.read()

# Fix the sed mess
content = content.replace('''@api_router.post("/analyses", response_model=dict)
async def create_analysis(body: AnalysisCreate, current_user: dict = Depends(get_current_user)):
async def create_analysis(body: AnalysisCreate):''', '''@api_router.post("/analyses", response_model=dict)
async def create_analysis(body: AnalysisCreate, current_user: dict = Depends(get_current_user)):''')

# Now let's just do a big regex replacement for endpoints.

# 1. analyses routes
content = re.sub(
    r'@api_router\.post\("/analyses", response_model=dict\)\nasync def create_analysis\(body: AnalysisCreate(?:, current_user: dict = Depends\(get_current_user\))?\):',
    '@api_router.post("/analyses", response_model=dict)\nasync def create_analysis(body: AnalysisCreate, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'analysis = Analysis(\n        repo_url=body.repo_url,\n        telegram_chat_id=body.telegram_chat_id,\n    )',
    'analysis = Analysis(\n        user_id=current_user["id"],\n        repo_url=body.repo_url,\n        telegram_chat_id=body.telegram_chat_id,\n    )'
)

content = re.sub(
    r'@api_router\.get\("/analyses", response_model=List\[dict\]\)\nasync def list_analyses\(\):',
    '@api_router.get("/analyses", response_model=List[dict])\nasync def list_analyses(current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'docs = await db.analyses.find({}, {"_id": 0}).sort("created_at", -1).to_list(50)',
    'docs = await db.analyses.find({"user_id": current_user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)'
)

content = re.sub(
    r'@api_router\.get\("/analyses/\{analysis_id\}", response_model=dict\)\nasync def get_analysis\(analysis_id: str\):',
    '@api_router.get("/analyses/{analysis_id}", response_model=dict)\nasync def get_analysis(analysis_id: str, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'doc = await db.analyses.find_one({"id": analysis_id}, {"_id": 0})',
    'doc = await db.analyses.find_one({"id": analysis_id, "user_id": current_user["id"]}, {"_id": 0})'
)

content = re.sub(
    r'@api_router\.delete\("/analyses/\{analysis_id\}"\)\nasync def delete_analysis\(analysis_id: str\):',
    '@api_router.delete("/analyses/{analysis_id}")\nasync def delete_analysis(analysis_id: str, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'result = await db.analyses.delete_one({"id": analysis_id})',
    'result = await db.analyses.delete_one({"id": analysis_id, "user_id": current_user["id"]})'
)

# 2. settings routes
content = re.sub(
    r'@api_router\.get\("/settings"\)\nasync def get_settings\(\):',
    '@api_router.get("/settings")\nasync def get_settings(current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'doc = await db.settings.find_one({"id": "global"}, {"_id": 0})',
    'doc = await db.settings.find_one({"user_id": current_user["id"]}, {"_id": 0})'
)

content = re.sub(
    r'@api_router\.post\("/settings"\)\nasync def save_settings\(body: dict\):',
    '@api_router.post("/settings")\nasync def save_settings(body: dict, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'body["id"] = "global"\n    body["updated_at"] = datetime.now(timezone.utc).isoformat()\n    await db.settings.replace_one({"id": "global"}, body, upsert=True)',
    'body["user_id"] = current_user["id"]\n    body["updated_at"] = datetime.now(timezone.utc).isoformat()\n    await db.settings.replace_one({"user_id": current_user["id"]}, body, upsert=True)'
)

# 3. guardrails routes
content = re.sub(
    r'@api_router\.get\("/guardrails"\)\nasync def list_guardrails\(\):',
    '@api_router.get("/guardrails")\nasync def list_guardrails(current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'docs = await db.guardrails.find({}, {"_id": 0}).sort("created_at", -1).to_list(50)',
    'docs = await db.guardrails.find({"user_id": current_user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(50)'
)

content = re.sub(
    r'@api_router\.get\("/guardrails/\{gid\}"\)\nasync def get_guardrails\(gid: str\):',
    '@api_router.get("/guardrails/{gid}")\nasync def get_guardrails(gid: str, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'doc = await db.guardrails.find_one({"id": gid}, {"_id": 0})',
    'doc = await db.guardrails.find_one({"id": gid, "user_id": current_user["id"]}, {"_id": 0})'
)

content = re.sub(
    r'@api_router\.post\("/guardrails"\)\nasync def create_guardrails\(body: dict\):',
    '@api_router.post("/guardrails")\nasync def create_guardrails(body: dict, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'gr = Guardrails(\n        name=body.get("name", "Custom Ruleset"),',
    'gr = Guardrails(\n        user_id=current_user["id"],\n        name=body.get("name", "Custom Ruleset"),'
)

content = re.sub(
    r'@api_router\.put\("/guardrails/\{gid\}"\)\nasync def update_guardrails\(gid: str, body: dict\):',
    '@api_router.put("/guardrails/{gid}")\nasync def update_guardrails(gid: str, body: dict, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'result = await db.guardrails.update_one({"id": gid}, {"$set": body})',
    'result = await db.guardrails.update_one({"id": gid, "user_id": current_user["id"]}, {"$set": body})'
)

content = re.sub(
    r'@api_router\.delete\("/guardrails/\{gid\}"\)\nasync def delete_guardrails\(gid: str\):',
    '@api_router.delete("/guardrails/{gid}")\nasync def delete_guardrails(gid: str, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'result = await db.guardrails.delete_one({"id": gid})',
    'result = await db.guardrails.delete_one({"id": gid, "user_id": current_user["id"]})'
)

# 4. watched repos
content = re.sub(
    r'@api_router\.get\("/watched-repos"\)\nasync def list_watched_repos\(\):',
    '@api_router.get("/watched-repos")\nasync def list_watched_repos(current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'docs = await db.watched_repos.find({}, {"_id": 0}).sort("created_at", -1).to_list(100)',
    'docs = await db.watched_repos.find({"user_id": current_user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(100)'
)

content = re.sub(
    r'@api_router\.post\("/watched-repos"\)\nasync def add_watched_repo\(body: dict\):',
    '@api_router.post("/watched-repos")\nasync def add_watched_repo(body: dict, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'wr = WatchedRepo(\n        repo_url=body.get("repo_url", ""),',
    'wr = WatchedRepo(\n        user_id=current_user["id"],\n        repo_url=body.get("repo_url", ""),'
)

content = re.sub(
    r'@api_router\.put\("/watched-repos/\{wid\}"\)\nasync def update_watched_repo\(wid: str, body: dict\):',
    '@api_router.put("/watched-repos/{wid}")\nasync def update_watched_repo(wid: str, body: dict, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'result = await db.watched_repos.update_one({"id": wid}, {"$set": body})',
    'result = await db.watched_repos.update_one({"id": wid, "user_id": current_user["id"]}, {"$set": body})'
)

content = re.sub(
    r'@api_router\.delete\("/watched-repos/\{wid\}"\)\nasync def delete_watched_repo\(wid: str\):',
    '@api_router.delete("/watched-repos/{wid}")\nasync def delete_watched_repo(wid: str, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'result = await db.watched_repos.delete_one({"id": wid})',
    'result = await db.watched_repos.delete_one({"id": wid, "user_id": current_user["id"]})'
)

content = re.sub(
    r'@api_router\.get\("/watch-events"\)\nasync def list_watch_events\(watched_repo_id: Optional\[str\] = None, limit: int = 50\):',
    '@api_router.get("/watch-events")\nasync def list_watch_events(watched_repo_id: Optional[str] = None, limit: int = 50, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'q = {}',
    'q = {"user_id": current_user["id"]}'
)

content = re.sub(
    r'@api_router\.post\("/guardrails/from-preset"\)\nasync def create_guardrails_from_preset\(body: dict\):',
    '@api_router.post("/guardrails/from-preset")\nasync def create_guardrails_from_preset(body: dict, current_user: dict = Depends(get_current_user)):',
    content
)
content = content.replace(
    'gr = Guardrails(\n        name=body.get("name") or template["name"],',
    'gr = Guardrails(\n        user_id=current_user["id"],\n        name=body.get("name") or template["name"],'
)

with open('server.py', 'w') as f:
    f.write(content)
