// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Secret Redactor
// Strips secrets from code/text before it reaches the local model.
// ─────────────────────────────────────────────────────────────────────────────

export interface RedactionResult {
  redacted: string;
  count: number;
  types: string[];
}

interface SecretPattern {
  type: string;
  regex: RegExp;
  /** Replacement string (may reference capture groups). */
  replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: "API_KEY",
    // Matches: api_key = 'ABC...', secret-key: "XYZ...", access_token="...", etc.
    regex:
      /(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*(['"])[^'"]{8,}\2/gi,
    replacement: "$1=[REDACTED:API_KEY]",
  },
  {
    type: "PASSWORD",
    // Matches: password = 'secret', passwd: "...", pwd="..."
    regex: /(password|passwd|pwd)\s*[=:]\s*(['"])[^'"]{4,}\2/gi,
    replacement: "$1=[REDACTED:PASSWORD]",
  },
  {
    type: "PRIVATE_KEY",
    // Matches PEM private key blocks
    regex:
      /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----[\s\S]+?-----END/g,
    replacement: "[REDACTED:PRIVATE_KEY]",
  },
  {
    type: "AWS_KEY",
    // Matches AWS access key IDs
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED:AWS_KEY]",
  },
  {
    type: "GENERIC_SECRET",
    // Matches: secret = "...", secret: '...'
    regex: /(secret)\s*[=:]\s*(['"])[^'"]{8,}\2/gi,
    replacement: "$1=[REDACTED:GENERIC_SECRET]",
  },
];

/**
 * Scan `text` for known secret patterns and replace them with
 * `[REDACTED:<TYPE>]` placeholders.
 *
 * Returns the sanitised text, the number of redactions applied,
 * and the unique secret types found.
 */
export function redactSecrets(text: string): RedactionResult {
  let redacted = text;
  let count = 0;
  const typesFound = new Set<string>();

  for (const { type, regex, replacement } of SECRET_PATTERNS) {
    // Count matches before replacing
    const matches = redacted.match(regex);
    if (matches && matches.length > 0) {
      count += matches.length;
      typesFound.add(type);
      redacted = redacted.replace(regex, replacement);
    }
    // Reset lastIndex for global regexes (they are recreated per call anyway,
    // but be safe in case patterns are reused across calls)
    regex.lastIndex = 0;
  }

  return {
    redacted,
    count,
    types: Array.from(typesFound),
  };
}

/**
 * Returns a list of glob patterns that the file scanner should skip entirely.
 * These files are likely to contain raw secrets and should never be read.
 */
export function buildSkipList(): string[] {
  return [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_rsa.*",
    "id_ed25519",
    "*.ppk",
    ".git/**",
    "node_modules/**",
    "venv/**",
    "__pycache__/**",
    "dist/**",
    "build/**",
    "*.min.js",
    "*.lock",
  ];
}
