"""Built-in guardrail rules and evaluation logic."""
import re
import uuid
import json
import logging
from typing import List, Dict, Optional
from emergentintegrations.llm.chat import LlmChat, UserMessage

logger = logging.getLogger(__name__)


BUILTIN_RULES = [
    {
        "id": "no_secrets",
        "name": "No Hardcoded Secrets",
        "category": "security",
        "description": "Detects hardcoded API keys, passwords, tokens, credentials",
        "type": "pattern",
        "pattern": r"(?i)(api[_-]?key|secret[_-]?key|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[=:]\s*['\"][^'\"]{8,}['\"]",
        "severity": "critical",
    },
    {
        "id": "no_debug",
        "name": "No Debug Statements",
        "category": "quality",
        "description": "No debugger, console.log, pdb.set_trace or breakpoint() in code",
        "type": "pattern",
        "pattern": r"^\+.*(debugger;|console\.log\(|pdb\.set_trace\(\)|breakpoint\(\))",
        "severity": "warning",
    },
    {
        "id": "no_print",
        "name": "No Print Statements",
        "category": "quality",
        "description": "No raw print() statements in production Python code",
        "type": "pattern",
        "pattern": r"^\+\s*print\s*\(",
        "severity": "info",
    },
    {
        "id": "no_todo",
        "name": "No TODO/FIXME Comments",
        "category": "quality",
        "description": "No TODO, FIXME, HACK, or XXX comments in committed code",
        "type": "pattern",
        "pattern": r"^\+.*\b(TODO|FIXME|HACK|XXX)\b",
        "severity": "info",
    },
    {
        "id": "no_hardcoded_ips",
        "name": "No Hardcoded IPs",
        "category": "security",
        "description": "Detects hardcoded private IP addresses that should be config variables",
        "type": "pattern",
        "pattern": r"^\+.*(?<!\d)(?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+",
        "severity": "warning",
    },
    {
        "id": "no_eval",
        "name": "No eval() Usage",
        "category": "security",
        "description": "Detects dangerous eval() or exec() calls",
        "type": "pattern",
        "pattern": r"^\+.*\b(eval|exec)\s*\(",
        "severity": "critical",
    },
    {
        "id": "security_review",
        "name": "AI Security Review",
        "category": "security",
        "description": "AI-powered detection of SQL injection, XSS, SSRF, path traversal, and other vulnerabilities",
        "type": "llm",
        "llm_prompt": "Review this code diff for security vulnerabilities: SQL injection, XSS, path traversal, SSRF, insecure deserialization, command injection, or privilege escalation. Only report genuine, high-confidence issues. Be specific.",
        "severity": "critical",
    },
    {
        "id": "code_quality",
        "name": "AI Code Quality",
        "category": "quality",
        "description": "AI-powered check for bad patterns, unhandled errors, and logical bugs",
        "type": "llm",
        "llm_prompt": "Review this code diff for significant quality issues: unhandled exceptions, race conditions, obvious logical bugs, or memory leaks. Only report genuine issues with clear evidence.",
        "severity": "warning",
    },
]

PRESET_TEMPLATES = {
    "security_first": {
        "name": "Security First",
        "description": "For security-conscious teams: focuses on vulnerabilities and credential safety",
        "rule_ids": ["no_secrets", "no_eval", "no_hardcoded_ips", "security_review"],
    },
    "startup": {
        "name": "Startup Pack",
        "description": "Lightweight quality checks for fast-moving teams",
        "rule_ids": ["no_secrets", "no_debug", "no_print"],
    },
    "enterprise": {
        "name": "Enterprise Grade",
        "description": "Full compliance for large engineering organizations",
        "rule_ids": ["no_secrets", "no_eval", "no_debug", "no_print", "no_todo", "no_hardcoded_ips", "security_review", "code_quality"],
    },
    "open_source": {
        "name": "Open Source Ready",
        "description": "Ensure code is safe to publish publicly",
        "rule_ids": ["no_secrets", "no_hardcoded_ips", "no_eval", "no_todo"],
    },
}


def get_builtin_rule(rule_id: str) -> dict | None:
    return next((r for r in BUILTIN_RULES if r["id"] == rule_id), None)


def build_guardrails_from_preset(preset_key: str) -> dict:
    template = PRESET_TEMPLATES.get(preset_key, PRESET_TEMPLATES["startup"])
    rules = []
    for rid in template["rule_ids"]:
        base = get_builtin_rule(rid)
        if base:
            rules.append({
                "id": str(uuid.uuid4()),
                "name": base["name"],
                "description": base["description"],
                "category": base["category"],
                "type": base["type"],
                "pattern": base.get("pattern"),
                "llm_prompt": base.get("llm_prompt"),
                "builtin_id": rid,
                "severity": base["severity"],
                "enabled": True,
            })
    return {
        "name": template["name"],
        "description": template["description"],
        "rules": rules,
    }


# ── Evaluation Logic ─────────────────────────────────────────────────────────

def _evaluate_pattern_rule(rule: dict, diff_text: str) -> List[dict]:
    """Run a regex pattern against added lines (lines starting with +) in a diff."""
    pattern = rule.get("pattern")
    if not pattern:
        return []
    try:
        regex = re.compile(pattern, re.MULTILINE)
    except re.error as e:
        logger.warning(f"Invalid regex in rule {rule.get('name')}: {e}")
        return []

    violations = []
    current_file = None
    for line in diff_text.split("\n"):
        if line.startswith("diff --git"):
            # extract b/<path>
            m = re.search(r"b/(\S+)", line)
            current_file = m.group(1) if m else None
            continue
        if line.startswith("+++"):
            m = re.match(r"\+\+\+ b/(.+)", line)
            if m:
                current_file = m.group(1)
            continue
        # Only inspect added lines (start with single +, not +++)
        if line.startswith("+") and not line.startswith("+++"):
            if regex.search(line):
                violations.append({
                    "rule_id": rule.get("id") or rule.get("builtin_id"),
                    "rule_name": rule.get("name"),
                    "category": rule.get("category", "quality"),
                    "severity": rule.get("severity", "warning"),
                    "file": current_file or "unknown",
                    "line_snippet": line[1:].strip()[:200],
                    "description": rule.get("description", ""),
                    "type": "pattern",
                })
                if len(violations) >= 5:
                    break
    return violations


async def _evaluate_llm_rule(rule: dict, diff_text: str, llm_key: str) -> List[dict]:
    """Use Gemini to inspect the diff for the specific concern described in the rule."""
    if not llm_key or not diff_text.strip():
        return []
    prompt_focus = rule.get("llm_prompt", "")
    truncated_diff = diff_text[:6000]
    system = (
        "You are a strict code reviewer. Examine the provided git diff. "
        "Only flag genuine, high-confidence issues directly relevant to the focus. "
        "Reply with valid JSON only — no markdown, no commentary.\n\n"
        'Schema: {"violations":[{"file":"path","reason":"short text","severity":"critical|warning|info"}]}'
    )
    user_msg = f"Focus: {prompt_focus}\n\nDiff:\n{truncated_diff}"
    try:
        chat = LlmChat(
            api_key=llm_key,
            session_id=f"guardrail-{uuid.uuid4()}",
            system_message=system,
        ).with_model("gemini", "gemini-3-flash-preview")
        raw = await chat.send_message(UserMessage(text=user_msg))
        text = re.sub(r"```(?:json)?\n?", "", raw.strip()).rstrip("`").strip()
        data = json.loads(text)
        out = []
        for v in data.get("violations", [])[:5]:
            out.append({
                "rule_id": rule.get("id") or rule.get("builtin_id"),
                "rule_name": rule.get("name"),
                "category": rule.get("category", "quality"),
                "severity": v.get("severity", rule.get("severity", "warning")),
                "file": v.get("file", "unknown"),
                "line_snippet": "",
                "description": v.get("reason", "")[:240],
                "type": "llm",
            })
        return out
    except json.JSONDecodeError:
        logger.warning(f"LLM rule {rule.get('name')} returned non-JSON")
        return []
    except Exception as e:
        logger.warning(f"LLM rule {rule.get('name')} error: {e}")
        return []


async def evaluate_diff(diff_text: str, guardrails: Optional[dict], llm_key: str) -> List[dict]:
    """Evaluate a git diff against a guardrails ruleset. Returns list of violation dicts."""
    if not guardrails or not diff_text:
        return []
    rules = [r for r in guardrails.get("rules", []) if r.get("enabled", True)]
    violations: List[dict] = []
    for rule in rules:
        if rule.get("type") == "pattern":
            violations.extend(_evaluate_pattern_rule(rule, diff_text))
        elif rule.get("type") == "llm":
            violations.extend(await _evaluate_llm_rule(rule, diff_text, llm_key))
        if len(violations) >= 15:
            break
    return violations


def violations_to_bugs(violations: List[dict]) -> List[dict]:
    """Convert guardrail violations to agent-compatible bug dicts so the LLM fixer can act on them."""
    bugs = []
    for i, v in enumerate(violations):
        bugs.append({
            "id": f"guard-{i}",
            "type": "guardrail",
            "file": v.get("file", ""),
            "line": None,
            "description": f"[{v.get('rule_name','rule')}] {v.get('description','')[:160]}".strip(),
            "stacktrace": v.get("line_snippet", ""),
            "severity": v.get("severity", "warning"),
        })
    return bugs
