// Strip AI-attribution from commit messages and PR bodies.
//
// The agent may add "Co-Authored-By: Claude", "Generated with Claude Code", a 🤖
// line, etc. We remove these deterministically (regardless of what the model did)
// so commits/PRs read as ordinary human-authored changes. Config can extend the
// default patterns via DEV.md `pr.strip_patterns`.

// Always-on defaults (case-insensitive). These cover the common Claude/AI trailers.
const DEFAULT_PATTERNS = [
  'Co-Authored-By:.*(Claude|Anthropic|AI)',
  'Generated with.*Claude',
  'Generated with.*Code',
  '\\bClaude Code\\b',
  '🤖',
];

/**
 * Remove any LINE matching a default or configured pattern, then collapse the
 * blank-line runs the removals leave behind. Returns a trimmed string.
 */
export function sanitizeMessage(text: string, extraPatterns: string[] = []): string {
  const res = [...DEFAULT_PATTERNS, ...extraPatterns]
    .map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        return null; // ignore an invalid user-supplied pattern rather than crash
      }
    })
    .filter((r): r is RegExp => r !== null);

  const kept = text
    .split('\n')
    .filter((line) => !res.some((re) => re.test(line)));

  // Collapse 3+ consecutive blank lines down to one, trim leading/trailing blanks.
  const out: string[] = [];
  for (const line of kept) {
    const blank = line.trim() === '';
    if (blank && out.length > 0 && out[out.length - 1].trim() === '') continue;
    out.push(line);
  }
  return out.join('\n').trim();
}
