/**
 * Stage 10: redact secrets out of bash output before it reaches the transcript.
 *
 * Scope, stated plainly because the plan pins it as "一期字符串级，非边界":
 * this is a **string-level** filter, not a security boundary. It cannot stop a
 * command from printing a secret in a shape nobody anticipated, and it is not
 * meant to. What it does is keep the common leaks — an `env` dump, a token in a
 * URL, a key pasted into a curl command, a private key file printed by accident —
 * out of `session.jsonl`, out of the model's context, and out of anything the
 * transcript is later shared into.
 *
 * Deliberately separate from `memory/extractor.ts#redactContent`: that one is
 * tuned for prose extraction and carries a high-entropy heuristic that would
 * mangle base64 blobs and hashes in normal build output. Shell output needs
 * patterns specific to shells (`export KEY=`, `--password=`, `https://user:pass@`)
 * and needs to leave checksums alone.
 */

/** Keeps the first and last few characters so a person can still identify which secret it was. */
function partial(value: string): string {
  if (value.length <= 8) return '[REDACTED]';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

const ENV_ASSIGN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/gm;
const SECRET_NAME =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH)(?:_|$)/i;

const PATTERNS: Array<{ pattern: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  // PEM private key blocks — the whole block, not just the header.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED PRIVATE KEY]',
  },
  // Credentials inside URLs: scheme://user:pass@host
  {
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    replace: (_m, scheme: string, user: string) => `${scheme}${user}:[REDACTED]@`,
  },
  // Credential flags: --password=hunter2 / --token abc
  {
    pattern: /(\B--?(?:password|passwd|token|api-?key|secret|auth-token)\s*[= ]\s*)(\S+)/gi,
    replace: (_m, prefix: string, value: string) => `${prefix}${partial(value)}`,
  },
  // Known credential prefixes (vendor-shaped tokens).
  {
    pattern: /\b(?:sk-|ghp_|gho_|ghu_|xoxb-|xoxp-|AKIA|AIza)[A-Za-z0-9_-]{10,}\b/g,
    replace: (match: string) => partial(match),
  },
  // Authorization headers echoed by curl -v / httpie.
  {
    pattern: /(\b(?:Authorization|X-Api-Key|Cookie)\s*:\s*)([^\r\n]+)/gi,
    replace: (_m, prefix: string, value: string) => `${prefix}${partial(value.trim())}`,
  },
];

/**
 * Redact secrets from a chunk of shell output.
 *
 * Line-oriented for the env case: `export FOO_TOKEN=abc` is only a secret when
 * the *name* says so, and a regex over the whole text cannot tell a multi-line
 * value from the next line's command.
 */
export function redactBashOutput(text: string): string {
  if (!text) return text;

  let output = text;

  // 1) Environment assignments whose NAME looks like a credential.
  output = output.replace(ENV_ASSIGN, (match, prefix: string, name: string, value: string) => {
    if (!SECRET_NAME.test(name)) return match;
    // `KEY=` (empty) stays as-is: it is a hint, not a leak.
    if (!value.trim()) return match;
    return `${prefix}${name}=${partial(value.trim())}`;
  });

  // 2) Structured patterns.
  for (const { pattern, replace } of PATTERNS) {
    output = output.replace(pattern, replace as never);
  }

  return output;
}

/**
 * Redact a command line before it is written to a log or a transcript.
 *
 * Separate from output redaction because a command is one line and commonly
 * carries the secret in an argument (`curl -H "Authorization: Bearer …"`).
 */
export function redactCommand(command: string): string {
  return redactBashOutput(command);
}
