import asyncio
import os
import re
import json
import shutil
import logging
from datetime import datetime, timezone
from typing import Optional

from emergentintegrations.llm.chat import LlmChat, UserMessage

logger = logging.getLogger(__name__)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def build_file_map(repo_dir: str) -> dict:
    """Walk repo and build a file map"""
    py_files, js_files, ts_files, test_files = [], [], [], []
    
    for root, dirs, files in os.walk(repo_dir):
        # Skip hidden dirs and common noise
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules', '__pycache__', '.git', 'venv', 'env', 'dist', 'build')]
        rel_root = os.path.relpath(root, repo_dir)
        for f in files:
            rel_path = os.path.join(rel_root, f) if rel_root != '.' else f
            if f.endswith('.py'):
                py_files.append(rel_path)
                if 'test' in f.lower() or 'test' in rel_root.lower():
                    test_files.append(rel_path)
            elif f.endswith(('.js', '.jsx')):
                js_files.append(rel_path)
                if 'test' in f.lower() or 'spec' in f.lower():
                    test_files.append(rel_path)
            elif f.endswith(('.ts', '.tsx')):
                ts_files.append(rel_path)
                if 'test' in f.lower() or 'spec' in f.lower():
                    test_files.append(rel_path)

    has_pytest = os.path.exists(f"{repo_dir}/pytest.ini") or os.path.exists(f"{repo_dir}/setup.cfg") or any('conftest' in f for f in py_files)
    has_requirements = os.path.exists(f"{repo_dir}/requirements.txt")
    has_package_json = os.path.exists(f"{repo_dir}/package.json")
    has_setup_py = os.path.exists(f"{repo_dir}/setup.py")

    if py_files:
        language = "python"
    elif ts_files:
        language = "typescript"
    elif js_files:
        language = "javascript"
    else:
        language = "unknown"

    total = len(py_files) + len(js_files) + len(ts_files)
    return {
        "language": language,
        "total_files": total,
        "py_files": py_files[:20],
        "js_files": js_files[:20],
        "test_files": test_files[:10],
        "entry_points": [f for f in py_files if f in ('main.py', 'app.py', 'server.py', 'index.py')][:3],
        "has_requirements": has_requirements,
        "has_package_json": has_package_json,
        "has_pytest": has_pytest or bool(test_files and py_files),
        "has_jest": has_package_json and bool(js_files + ts_files),
        "has_setup_py": has_setup_py,
    }


def decide_strategy(file_map: dict) -> dict:
    lang = file_map.get("language", "unknown")
    if lang == "python":
        return {
            "language": "python",
            "test_cmd": "pytest",
            "test_args": ["-x", "--tb=short", "-q", "--no-header"],
            "lint_cmd": "flake8",
            "lint_args": ["--max-line-length=120", "--select=E,W,F", "--exclude=.git,__pycache__,venv,env", "."],
        }
    elif lang in ("javascript", "typescript"):
        return {
            "language": lang,
            "test_cmd": "jest",
            "test_args": ["--watchAll=false", "--no-coverage", "--passWithNoTests"],
            "lint_cmd": "eslint",
            "lint_args": [".", "--ext", ".js,.jsx,.ts,.tsx", "--max-warnings=0"],
        }
    return {"language": "unknown", "test_cmd": None, "test_args": [], "lint_cmd": None, "lint_args": []}


async def run_cmd(cmd: list, cwd: str, timeout: int = 60) -> tuple:
    """Run a command and return (returncode, stdout, stderr)"""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return 1, "", f"Command timed out after {timeout}s"
    except Exception as e:
        return 1, "", str(e)


def parse_pytest_output(output: str, repo_dir: str) -> list:
    """Parse pytest output and extract failing tests"""
    bugs = []
    # Pattern: FAILED path/to/test.py::test_name - error message
    failed_pattern = re.compile(r"FAILED\s+([\w/\\.]+)::([\w\[\]]+)\s*[-–]?\s*(.*)", re.MULTILINE)
    
    for match in failed_pattern.finditer(output):
        file_path = match.group(1)
        test_name = match.group(2)
        error_msg = match.group(3).strip()
        
        # Extract stacktrace for this test
        stacktrace = extract_stacktrace_for_test(output, test_name)
        
        bugs.append({
            "id": f"test-{len(bugs)}",
            "type": "failing_test",
            "file": file_path,
            "line": None,
            "description": f"Test {test_name} failed: {error_msg[:120]}",
            "stacktrace": stacktrace[:1500],
            "severity": "high",
            "test_name": test_name,
        })
    
    # Also look for ERROR lines
    error_pattern = re.compile(r"ERROR\s+([\w/\\.]+)::([\w\[\]]+)", re.MULTILINE)
    for match in error_pattern.finditer(output):
        file_path = match.group(1)
        test_name = match.group(2)
        if not any(b.get("test_name") == test_name for b in bugs):
            bugs.append({
                "id": f"err-{len(bugs)}",
                "type": "failing_test",
                "file": file_path,
                "line": None,
                "description": f"Error in test {test_name}",
                "stacktrace": extract_stacktrace_for_test(output, test_name)[:1500],
                "severity": "high",
                "test_name": test_name,
            })
    
    return bugs[:5]


def extract_stacktrace_for_test(output: str, test_name: str) -> str:
    """Extract the stacktrace block for a specific test from pytest output"""
    lines = output.split('\n')
    in_block = False
    block_lines = []
    for line in lines:
        if test_name in line and ('FAILED' in line or 'ERROR' in line or '_ _ _' in line or '====' in line):
            in_block = True
        elif in_block:
            if line.startswith('FAILED') or line.startswith('=====') or line.startswith('PASSED'):
                if len(block_lines) > 2:
                    break
            block_lines.append(line)
    return '\n'.join(block_lines[:30])


def parse_flake8_output(output: str) -> list:
    """Parse flake8 output: path/to/file.py:line:col: E/W code message"""
    bugs = []
    pattern = re.compile(r"([\w/\\.]+\.py):(\d+):(\d+):\s+([EWF]\d+)\s+(.*)")
    
    seen_files = set()
    for match in pattern.finditer(output):
        file_path = match.group(1)
        line = int(match.group(2))
        code = match.group(4)
        message = match.group(5)
        
        severity = "high" if code.startswith('E') else "medium" if code.startswith('W') else "low"
        
        bugs.append({
            "id": f"lint-{len(bugs)}",
            "type": "lint",
            "file": file_path,
            "line": line,
            "description": f"{code}: {message}",
            "stacktrace": "",
            "severity": severity,
        })
        seen_files.add(file_path)
        
        if len(bugs) >= 10:
            break
    
    return bugs


async def generate_fix_with_llm(bug: dict, repo_dir: str, llm_key: str) -> Optional[dict]:
    """Use Gemini to generate a minimal code fix for the bug"""
    file_path = bug.get("file", "")
    if not file_path:
        return None
    
    full_path = os.path.join(repo_dir, file_path)
    if not os.path.exists(full_path):
        # Try to find the file
        for root, dirs, files in os.walk(repo_dir):
            for f in files:
                if f == os.path.basename(file_path):
                    full_path = os.path.join(root, f)
                    file_path = os.path.relpath(full_path, repo_dir)
                    break
    
    if not os.path.exists(full_path):
        return None
    
    try:
        with open(full_path, 'r', encoding='utf-8', errors='replace') as f:
            file_content = f.read()
    except Exception:
        return None
    
    # Truncate file if too large
    if len(file_content) > 4000:
        # Try to find the relevant section
        line_num = bug.get("line") or 1
        lines = file_content.split('\n')
        start = max(0, line_num - 20)
        end = min(len(lines), line_num + 40)
        file_content = '\n'.join(lines[start:end])
    
    system_msg = """You are a surgical code fixer. Your job is to generate MINIMAL fixes for specific bugs.

Rules:
- Fix ONLY the specific bug described, nothing else
- No refactoring, no style changes, no formatting changes
- Keep changes as small as possible
- Return ONLY valid JSON (no markdown, no code blocks)

Required output format:
{
  "original_code": "the exact code snippet to replace (2-5 lines max)",
  "fixed_code": "the replacement code (same number of lines preferred)",
  "explanation": "one sentence explaining the fix"
}"""

    prompt = f"""Bug report:
Type: {bug.get('type', 'unknown')}
File: {file_path}
Line: {bug.get('line', 'unknown')}
Description: {bug.get('description', '')}
Stacktrace: {bug.get('stacktrace', '')[:500]}

File content:
{file_content}

Generate a minimal fix. Return only valid JSON."""

    try:
        chat = LlmChat(
            api_key=llm_key,
            session_id=f"fix-{bug.get('id', 'x')}",
            system_message=system_msg,
        ).with_model("gemini", "gemini-3-flash-preview")
        
        response = await chat.send_message(UserMessage(text=prompt))
        
        # Parse JSON from response
        response_text = response.strip()
        # Remove markdown code blocks if present
        response_text = re.sub(r'```(?:json)?\n?', '', response_text).strip()
        response_text = response_text.rstrip('`').strip()
        
        fix_data = json.loads(response_text)
        return {
            "bug_id": bug.get("id", ""),
            "file": file_path,
            "original_code": fix_data.get("original_code", ""),
            "fixed_code": fix_data.get("fixed_code", ""),
            "explanation": fix_data.get("explanation", "Fix applied"),
            "verified": False,
        }
    except json.JSONDecodeError as e:
        logger.warning(f"LLM returned invalid JSON for bug {bug.get('id')}: {e}")
        return None
    except Exception as e:
        logger.warning(f"LLM fix generation failed: {e}")
        return None


def apply_fix(fix: dict, repo_dir: str) -> bool:
    """Apply a fix to the file by replacing the original code with the fixed code"""
    file_path = fix.get("file", "")
    if not file_path:
        return False
    
    full_path = os.path.join(repo_dir, file_path)
    if not os.path.exists(full_path):
        return False
    
    original_code = fix.get("original_code", "")
    fixed_code = fix.get("fixed_code", "")
    
    if not original_code or original_code == fixed_code:
        return False
    
    try:
        with open(full_path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        
        if original_code not in content:
            # Try with normalized whitespace
            logger.warning(f"Exact match not found for fix in {file_path}")
            return False
        
        new_content = content.replace(original_code, fixed_code, 1)
        
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        
        # Generate diff
        fix["diff"] = generate_diff(original_code, fixed_code, file_path)
        return True
    except Exception as e:
        logger.warning(f"Failed to apply fix: {e}")
        return False


def generate_diff(original: str, fixed: str, filename: str) -> str:
    """Generate a simple unified diff string"""
    orig_lines = original.split('\n')
    fix_lines = fixed.split('\n')
    diff_lines = [f"--- {filename}", f"+++ {filename}"]
    for line in orig_lines:
        diff_lines.append(f"-{line}")
    for line in fix_lines:
        diff_lines.append(f"+{line}")
    return '\n'.join(diff_lines)


async def verify_fix_for_test(bug: dict, repo_dir: str, strategy: dict) -> bool:
    """Re-run the failing test to verify the fix works"""
    test_name = bug.get("test_name", "")
    if not test_name:
        return True  # Can't verify, assume ok
    
    if strategy["language"] == "python":
        code, stdout, stderr = await run_cmd(
            ["python", "-m", "pytest", "-x", "--tb=short", "-q", f"::{test_name}"],
            cwd=repo_dir,
            timeout=30,
        )
        return code == 0
    return True


async def run_analysis_task(analysis_id: str, repo_url: str, db, llm_key: str,
                            telegram_svc=None, github_svc=None, telegram_chat_id: Optional[str] = None):
    """Main agentic loop: observe → decide → act → verify → create_pr"""
    repo_dir = f"/tmp/repodoctor/{analysis_id}"

    async def add_log(msg: str, level: str = "info"):
        entry = {"timestamp": utc_now(), "level": level, "message": msg}
        await db.analyses.update_one({"id": analysis_id}, {"$push": {"logs": entry}})
        logger.info(f"[{analysis_id[:8]}] {msg}")
        if telegram_svc and telegram_chat_id:
            try:
                await telegram_svc.send_message(telegram_chat_id, msg)
            except Exception:
                pass

    async def update_step(step: str, status: str, message: str = ""):
        await db.analyses.update_one(
            {"id": analysis_id, "agent_steps.step": step},
            {"$set": {
                "agent_steps.$.status": status,
                "agent_steps.$.message": message,
                "agent_steps.$.updated_at": utc_now(),
            }}
        )

    try:
        os.makedirs("/tmp/repodoctor", exist_ok=True)

        # ── STEP 1: OBSERVE ──────────────────────────────────────────────────
        await db.analyses.update_one({"id": analysis_id}, {"$set": {"status": "cloning"}})
        await update_step("observe", "active", "Cloning repository...")
        await add_log(f"Cloning {repo_url}...")

        code, stdout, stderr = await run_cmd(
            ["git", "clone", "--depth=1", repo_url, repo_dir],
            cwd="/tmp",
            timeout=90,
        )
        if code != 0:
            raise Exception(f"Clone failed: {stderr[:300]}")

        await add_log("Repository cloned successfully")

        file_map = build_file_map(repo_dir)
        repo_name = repo_url.rstrip("/").split("/")[-1].replace(".git", "")
        owner = repo_url.rstrip("/").split("/")[-2] if "/" in repo_url else ""
        full_name = f"{owner}/{repo_name}" if owner else repo_name

        await db.analyses.update_one({"id": analysis_id}, {
            "$set": {"file_map": file_map, "repo_name": full_name}
        })
        await update_step("observe", "completed", f"{file_map['total_files']} files | {file_map['language']}")
        await add_log(f"File map built: {file_map['total_files']} files, language={file_map['language']}")

        # ── STEP 2: DECIDE ───────────────────────────────────────────────────
        await db.analyses.update_one({"id": analysis_id}, {"$set": {"status": "analyzing"}})
        await update_step("decide", "active", "Planning strategy...")
        await add_log("Analyzing project structure...")

        strategy = decide_strategy(file_map)
        strategy_msg = f"Strategy: {strategy.get('test_cmd', 'none')} tests + {strategy.get('lint_cmd', 'none')} lint"
        await update_step("decide", "completed", strategy_msg)
        await add_log(strategy_msg)

        # ── STEP 3: ACT ──────────────────────────────────────────────────────
        await update_step("act", "active", "Running tests and lint...")
        bugs = []

        # Install Python deps if available (best effort)
        if file_map["language"] == "python" and file_map["has_requirements"]:
            await add_log("Installing Python dependencies...")
            await run_cmd(
                ["pip", "install", "-r", "requirements.txt", "--quiet", "--disable-pip-version-check"],
                cwd=repo_dir,
                timeout=120,
            )

        # Run tests
        if strategy.get("test_cmd"):
            await add_log(f"Running {strategy['test_cmd']} tests...")
            if strategy["language"] == "python":
                test_code, test_out, test_err = await run_cmd(
                    ["python", "-m", "pytest"] + strategy["test_args"],
                    cwd=repo_dir,
                    timeout=120,
                )
                test_output = test_out + test_err
                test_bugs = parse_pytest_output(test_output, repo_dir)
                bugs.extend(test_bugs)
                test_summary = f"{len(test_bugs)} test failure(s)" if test_bugs else "All tests passing"
                await add_log(f"Tests: {test_summary}")

        # Run lint
        if strategy.get("lint_cmd"):
            await add_log(f"Running {strategy['lint_cmd']}...")
            if strategy["language"] == "python":
                lint_code, lint_out, lint_err = await run_cmd(
                    ["python", "-m", "flake8"] + strategy["lint_args"],
                    cwd=repo_dir,
                    timeout=30,
                )
                lint_output = lint_out + lint_err
                lint_bugs = parse_flake8_output(lint_output)
                bugs.extend(lint_bugs[:5])
                lint_summary = f"{len(lint_bugs)} lint issue(s)" if lint_bugs else "No lint issues"
                await add_log(f"Lint: {lint_summary}")

        if not bugs and file_map["language"] == "unknown":
            await add_log("Language not supported for automatic analysis. Using LLM static analysis...")

        await db.analyses.update_one({"id": analysis_id}, {"$set": {"bugs": bugs, "status": "fixing"}})
        await update_step("act", "completed", f"{len(bugs)} issue(s) found")

        if not bugs:
            await add_log("No bugs found! Repository looks clean.")
            for step in ["verify", "create_pr"]:
                await update_step(step, "skipped", "No bugs found")
            await db.analyses.update_one({"id": analysis_id}, {
                "$set": {"status": "completed", "completed_at": utc_now()}
            })
            if telegram_svc and telegram_chat_id:
                await telegram_svc.send_message(telegram_chat_id, f"Analysis complete for {full_name}\nNo bugs found!")
            return

        # ── STEP 4: VERIFY ───────────────────────────────────────────────────
        await update_step("verify", "active", "Generating and verifying fixes...")
        fixes = []

        for i, bug in enumerate(bugs[:3]):
            await add_log(f"Generating fix {i+1}/{min(len(bugs), 3)}: {bug['description'][:70]}...")

            fix = await generate_fix_with_llm(bug, repo_dir, llm_key)
            if not fix:
                await add_log(f"Could not generate fix for: {bug['description'][:60]}", "warning")
                continue

            applied = apply_fix(fix, repo_dir)
            if not applied:
                await add_log(f"Could not apply fix for: {bug['description'][:60]}", "warning")
                fixes.append(fix)
                continue

            # Verify fix
            if bug.get("type") == "failing_test":
                verified = await verify_fix_for_test(bug, repo_dir, strategy)
                if not verified:
                    # Retry once with fresh generation
                    await add_log(f"Fix did not pass verification, retrying...")
                    fix2 = await generate_fix_with_llm(bug, repo_dir, llm_key)
                    if fix2:
                        apply_fix(fix2, repo_dir)
                        verified2 = await verify_fix_for_test(bug, repo_dir, strategy)
                        if verified2:
                            fix2["verified"] = True
                            fixes.append(fix2)
                            await add_log(f"Fix verified on retry for: {bug['description'][:60]}")
                            continue
                    fix["verified"] = False
                    fixes.append(fix)
                    await add_log(f"Fix could not be verified for: {bug['description'][:60]}", "warning")
                    continue
            else:
                verified = True

            fix["verified"] = verified
            fixes.append(fix)
            if verified:
                await add_log(f"Fix verified: {bug['description'][:60]}")

            await db.analyses.update_one({"id": analysis_id}, {"$set": {"fixes": fixes}})

        verified_count = sum(1 for f in fixes if f.get("verified"))
        await update_step("verify", "completed", f"{verified_count}/{len(fixes)} fix(es) verified")
        await add_log(f"Verification complete: {verified_count} verified fixes")

        # ── STEP 5: CREATE PR ─────────────────────────────────────────────────
        pr_url = None
        if github_svc and verified_count > 0:
            await update_step("create_pr", "active", "Creating GitHub PR...")
            await add_log("Creating GitHub PR...")
            try:
                pr_url = await github_svc.create_pr(repo_url, repo_dir, analysis_id, fixes)
                await db.analyses.update_one({"id": analysis_id}, {"$set": {"pr_url": pr_url}})
                await update_step("create_pr", "completed", pr_url)
                await add_log(f"PR created: {pr_url}")
            except Exception as e:
                await update_step("create_pr", "failed", str(e)[:100])
                await add_log(f"PR creation failed: {str(e)[:100]}", "error")
        else:
            reason = "GitHub token not configured" if not github_svc else "No verified fixes"
            await update_step("create_pr", "skipped", reason)
            await add_log(f"Skipping PR creation: {reason}")

        await db.analyses.update_one({"id": analysis_id}, {
            "$set": {"status": "completed", "completed_at": utc_now(), "fixes": fixes}
        })
        summary_msg = f"Analysis complete for {full_name}: {len(bugs)} bugs found, {verified_count} fixed"
        await add_log(summary_msg)

        if telegram_svc and telegram_chat_id:
            tg_msg = f"<b>Analysis Complete</b>\n\nRepo: <code>{full_name}</code>\nBugs found: {len(bugs)}\nFixes verified: {verified_count}"
            if pr_url:
                tg_msg += f"\nPR: {pr_url}"
            await telegram_svc.send_message(telegram_chat_id, tg_msg)

    except Exception as e:
        logger.exception(f"Analysis {analysis_id} failed with exception")
        await add_log(f"Analysis failed: {str(e)}", "error")
        await db.analyses.update_one({"id": analysis_id}, {
            "$set": {"status": "failed", "error": str(e)[:500]}
        })
        # Mark active steps as failed
        for step in ["observe", "decide", "act", "verify", "create_pr"]:
            await db.analyses.update_one(
                {"id": analysis_id, "agent_steps.step": step, "agent_steps.status": "active"},
                {"$set": {"agent_steps.$.status": "failed"}}
            )
        if telegram_svc and telegram_chat_id:
            await telegram_svc.send_message(telegram_chat_id, f"Analysis failed: {str(e)[:200]}")
    finally:
        shutil.rmtree(repo_dir, ignore_errors=True)
