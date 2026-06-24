import * as fs from 'fs';
import * as path from 'path';

const GAP_HEADER = '## 불확실하거나 추가 확인이 필요한 부분';

/** Extract list-item topics (bullet or numbered) under the gap heading. */
export function parseGaps(answerMd: string): string[] {
  const idx = answerMd.indexOf(GAP_HEADER);
  if (idx === -1) return [];
  let section = answerMd.slice(idx + GAP_HEADER.length);
  const nextHeading = section.indexOf('\n## ');
  if (nextHeading !== -1) section = section.slice(0, nextHeading);
  return section
    .split('\n')
    .map((l) => l.trim())
    .map((l) => {
      // Accept bullet (-, *, +) and numbered (1. / 1)) list markers; strip bold.
      const m = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l);
      return m ? m[1].replace(/\*\*/g, '').trim() : '';
    })
    .filter((l) => l !== '');
}

/** Harvest gaps from every *.md file in a directory. */
export function harvestGaps(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    out.push(...parseGaps(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  return out;
}
