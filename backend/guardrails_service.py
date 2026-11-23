"""Built-in guardrail rules and evaluation logic."""
import re
import uuid
import json
import logging
from typing import List, Dict, Optional
from llm import LlmChat, UserMessage

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
        if rule.get("type") in ("pattern", "regex"):
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


# ── ADR / LLD / HLD -> Guardrails Compiler (Gemini) ──────────────────────────

def _slugify_id(raw: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", (raw or "").lower()).strip("_")[:60]
    return slug or "doc_rule"


def _normalize_severity(val: Optional[str]) -> str:
    s = (val or "").lower().strip()
    if s in ("critical", "high", "error", "blocker", "must"):
        return "critical"
    if s in ("info", "low", "minor", "note"):
        return "info"
    return "warning"


def _normalize_category(val: Optional[str]) -> str:
    s = (val or "").lower().strip()
    if s in ("security", "quality", "compliance"):
        return s
    return "quality"


def _normalize_extracted_rules(raw_rules: list) -> List[dict]:
    seen = set()
    normalized: List[dict] = []
    for item in raw_rules:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("id") or "").strip()
        description = str(item.get("description") or "").strip()
        if not name and not description:
            continue

        base_id = _slugify_id(str(item.get("id") or name))
        rule_id = base_id
        idx = 2
        while rule_id in seen:
            rule_id = f"{base_id}_{idx}"
            idx += 1
        seen.add(rule_id)

        raw_type = str(item.get("type") or "").lower().strip()
        pattern = str(item.get("pattern") or "").strip()
        # Strip accidental /.../flags wrappers
        m = re.match(r"^/(.+)/[gimsuy]*$", pattern)
        if m:
            pattern = m.group(1)

        rule_type = "llm"
        valid_pattern = None
        if raw_type in ("regex", "pattern") and pattern:
            try:
                re.compile(pattern)
                rule_type = "regex"
                valid_pattern = pattern
            except re.error:
                logger.warning(f"Generated rule {rule_id} had invalid regex; falling back to llm")

        normalized.append({
            "id": rule_id,
            "name": name or rule_id,
            "category": _normalize_category(item.get("category")),
            "severity": _normalize_severity(item.get("severity")),
            "description": description or name,
            "type": rule_type,
            "pattern": valid_pattern,
            "llm_prompt": (description or name) if rule_type == "llm" else None,
            "enabled": True,
        })
    return normalized


async def generate_rules_from_doc(content: str, filename: str, llm_key: str) -> List[dict]:
    """Use Gemini (google-genai) with structured JSON output to extract guardrail rules from an ADR/LLD/HLD."""
    if not llm_key:
        raise ValueError("LLM_API_KEY is not configured on the server")
    text = (content or "").strip()
    if not text:
        raise ValueError("Document content is empty")

    # Cap document length safely for a single structured Gemini call
    truncated = text[:40_000]
    prompt = (
        f"You convert software architecture documents (ADR, LLD, HLD) into enforceable code guardrails.\n"
        f"Read the document '{filename}' below and extract ONLY concrete, checkable engineering rules "
        f"stated or clearly implied as MUST / MUST NOT / SHALL / NEVER / ALWAYS.\n"
        f"Ignore background, goals, history, and anything that cannot be checked in source code.\n"
        f"Never invent rules that are not grounded in the document.\n\n"
        f"For each rule return:\n"
        f"- id: short snake_case identifier\n"
        f"- name: short human-readable title\n"
        f"- severity: \"critical\" | \"warning\" | \"info\"\n"
        f"- category: \"security\" | \"quality\" | \"compliance\"\n"
        f"- description: one sentence stating the must / must-not rule\n"
        f"- type: \"regex\" if a single-line regular expression can detect a violation in source code, otherwise \"llm\"\n"
        f"- pattern: valid regular expression (no surrounding slashes) matching a violating line when type is \"regex\", otherwise null\n\n"
        f"Respond with ONLY a JSON object matching: "
        f'{{"rules":[{{"id":"...","name":"...","severity":"warning","category":"quality","description":"...","type":"regex","pattern":"..."}}]}}\n\n'
        f"--- DOCUMENT START ---\n{truncated}\n--- DOCUMENT END ---"
    )

    import asyncio
    from google import genai
    from google.genai import types

    def _call_gemini() -> str:
        client = genai.Client(api_key=llm_key)
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.0,
            ),
        )
        return response.text or "{}"

    raw_text = await asyncio.to_thread(_call_gemini)
    cleaned = re.sub(r"```(?:json)?\n?", "", raw_text.strip()).rstrip("`").strip()
    data = json.loads(cleaned)
    raw_rules = data.get("rules", []) if isinstance(data, dict) else []
    return _normalize_extracted_rules(raw_rules)


# ── Export to repodoc.yml (compatible with packages/repodoc-local) ───────────

def _yaml_single_quote(val: str) -> str:
    clean = str(val or "").replace("\r\n", " ").replace("\n", " ")
    return "'" + clean.replace("'", "''") + "'"


def _adapt_pattern_for_local(pattern: str) -> str:
    """Adapt git-diff-anchored patterns (^\\+.* or ^\\+) so they match full source lines in repodoc-local."""
    if pattern.startswith(r"^\+.*"):
        return pattern[len(r"^\+.*"):]
    if pattern.startswith(r"^\+"):
        return "^" + pattern[len(r"^\+"):]
    return pattern


def serialize_guardrails_to_yaml(guardrails_doc: dict) -> str:
    """Serialize a Guardrails profile document into repodoc.yml matching packages/repodoc-local/src/guardrails.ts."""
    name = guardrails_doc.get("name") or "repoDoc Guardrails"
    rules = [r for r in guardrails_doc.get("rules", []) if r.get("enabled", True)]

    lines = [
        f"# repoDoc guardrail configuration exported from profile: {name}",
        "# Use locally with: repodoc . --rules repodoc.yml",
        "version: 1",
        f"name: {_yaml_single_quote(name)}",
        "rules:",
    ]

    seen_ids = set()
    for r in rules:
        raw_id = r.get("builtin_id") or r.get("id") or r.get("name") or "rule"
        rule_id = _slugify_id(str(raw_id))
        if rule_id in seen_ids:
            idx = 2
            while f"{rule_id}_{idx}" in seen_ids:
                idx += 1
            rule_id = f"{rule_id}_{idx}"
        seen_ids.add(rule_id)

        raw_type = str(r.get("type") or "pattern").lower()
        rule_type = "pattern" if raw_type in ("pattern", "regex") else "llm"
        pattern = r.get("pattern")
        if rule_type == "pattern" and pattern:
            pattern = _adapt_pattern_for_local(str(pattern))
        elif rule_type == "pattern":
            rule_type = "llm"

        category = r.get("category") if r.get("category") in ("security", "quality", "compliance", "custom") else "custom"
        severity = r.get("severity") if r.get("severity") in ("critical", "warning", "info") else "warning"
        rule_name = r.get("name") or rule_id
        description = r.get("description") or r.get("llm_prompt") or ""

        lines.append(f"  - id: {rule_id}")
        lines.append(f"    name: {_yaml_single_quote(rule_name)}")
        lines.append(f"    category: {category}")
        lines.append(f"    type: {rule_type}")
        if rule_type == "pattern" and pattern:
            lines.append(f"    pattern: {_yaml_single_quote(pattern)}")
        lines.append(f"    severity: {severity}")
        lines.append(f"    description: {_yaml_single_quote(description)}")

    return "\n".join(lines) + "\n"
