"""Built-in guardrail rules and evaluation logic."""

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
            rules.append({**base, "enabled": True, "builtin_id": rid})
    return {
        "name": template["name"],
        "description": template["description"],
        "rules": rules,
    }
