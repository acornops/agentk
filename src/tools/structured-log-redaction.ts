// Keep this bounded text scanner equivalent in AgentK and control-plane.
// Each caller retains its own existing plain-text and structured-object policy.
const SENSITIVE_KEY = /^(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|secret|credential|authorization|private[_-]?key|cookie|session)$/i;
const WITHHELD = '<redacted-unparseable-log-segment>';
// Match legacy assignments before splitting on quotes inside their values.
const ASSIGNMENT_PREFIX = /\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|credential)\b\s*[=:]\s*/i;

/** Find a JSON string boundary without interpreting escaped quotes as delimiters. */
function stringEnd(text: string, start: number, quote = '"'): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === quote) return index + 1;
  }
  return -1;
}

/** Bound an entire sensitive JSON value, including arrays/objects, or withhold it. */
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== '{' && text[start] !== '[') {
    const scalar = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)/.exec(text.slice(start));
    return scalar ? start + scalar[0].length : -1;
  }
  const stack: string[] = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = stringEnd(text, index);
      if (end < 0) return -1;
      index = end - 1;
    } else if (char === '{' || char === '[') {
      stack.push(char);
      if (stack.length > 32) return -1;
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Redact quoted log credentials without reformatting JSON/JSONL or prefixed logs.
 * Callers bound input bytes; scanning is linear with at most two embedded decodes.
 * Ambiguous quoted segments are withheld; original input is never an error fallback.
 */
export function redactStructuredLogText(value: string, redactPlainText: (text: string) => string): string {
  /** Process quoted tokens and their decoded contents without changing other bytes. */
  function scan(input: string, depth: number): string {
    if (depth > 2) return WITHHELD;
    const text = input.replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '<redacted-private-key>'
    );
    const output: string[] = [];
    let cursor = 0;
    let nextQuote = text.indexOf('"');
    while (cursor < text.length) {
      // Retain the next boundary while consuming assignments before it; repeatedly
      // searching the remaining plain-text suffix would make that case quadratic.
      if (nextQuote >= 0 && nextQuote < cursor) nextQuote = text.indexOf('"', cursor);
      const start = nextQuote;
      const plain = text.slice(cursor, start < 0 ? text.length : start);
      const assignment = ASSIGNMENT_PREFIX.exec(plain);
      if (assignment) {
        const startValue = cursor + assignment.index + assignment[0].length;
        const quote = text[startValue];
        let endValue = startValue;
        if (quote === '"' || quote === "'") endValue = stringEnd(text, startValue, quote);
        else while (endValue < text.length && !/[\s,;]/.test(text[endValue]!)) endValue += 1;
        const replacement = endValue < 0 || text.slice(startValue, endValue) === WITHHELD
          ? WITHHELD : '<redacted>';
        output.push(redactPlainText(plain.slice(0, assignment.index)), assignment[0], replacement);
        if (endValue < 0) break;
        cursor = endValue;
        continue;
      }
      output.push(redactPlainText(plain));
      if (start < 0) break;
      const end = stringEnd(text, start);
      if (end < 0) {
        output.push(WITHHELD);
        break;
      }
      const token = text.slice(start, end);
      let decoded: string;
      try {
        decoded = JSON.parse(token) as string;
      } catch {
        // A guessed closing quote can belong to a later JSONL record. Do not
        // resume there and expose its value after misclassifying the next key.
        output.push(JSON.stringify(WITHHELD));
        break;
      }
      let after = end;
      while (/\s/.test(text[after] ?? '') && after < text.length) after += 1;
      if (text[after] === ':' && SENSITIVE_KEY.test(decoded)) {
        let startValue = after + 1;
        while (/\s/.test(text[startValue] ?? '') && startValue < text.length) startValue += 1;
        const endValue = valueEnd(text, startValue);
        const replacement = endValue < 0 || text.slice(startValue, endValue) === JSON.stringify(WITHHELD)
          ? WITHHELD : '<redacted>';
        output.push(text.slice(start, startValue), JSON.stringify(replacement));
        if (endValue < 0) break;
        cursor = endValue;
      } else {
        if (text[after] === ':') {
          const sanitized = redactPlainText(decoded);
          output.push(sanitized === decoded ? token : JSON.stringify(sanitized));
        } else {
          const sanitized = decoded.includes('"') ? scan(decoded, depth + 1) : scan(decoded, depth);
          output.push(sanitized === decoded ? token : JSON.stringify(sanitized));
        }
        cursor = end;
      }
    }
    return output.join('');
  }

  try {
    return scan(value, 0);
  } catch {
    return WITHHELD;
  }
}
