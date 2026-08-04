const REDACTION_PLACEHOLDER = "****";

const SECRET_PATTERNS: Array<{ regex: RegExp; replace: string }> = [
  {
    regex: /\bsk-[A-Za-z0-9]{8,}\b/g,
    replace: `sk-${REDACTION_PLACEHOLDER}`,
  },
  {
    regex: /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
    replace: `Bearer ${REDACTION_PLACEHOLDER}`,
  },
  {
    regex: /\b(authorization)\s*:\s*([^\n\r]+)/gi,
    replace: `$1: ${REDACTION_PLACEHOLDER}`,
  },
  {
    regex:
      /\b(api[_-]?key|openai[_-]?api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*=\s*([^\s"'`\\]+)/gi,
    replace: `$1=${REDACTION_PLACEHOLDER}`,
  },
  {
    regex:
      /\b(api[_-]?key|openai[_-]?api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*:\s*([^\n\r]+)/gi,
    replace: `$1: ${REDACTION_PLACEHOLDER}`,
  },
];

export function redactEvidenceText(input: string): string {
  let value = input;

  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern.regex, pattern.replace);
  }

  return value;
}
