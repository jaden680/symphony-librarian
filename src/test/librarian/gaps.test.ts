import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseGaps, harvestGaps } from '../../librarian/gaps';

const ANSWER = `## 결론
something

## 불확실하거나 추가 확인이 필요한 부분
- Airbridge 링크 → home 매핑 규칙
- page_type 전체 값 목록

## 다른 섹션
- not a gap
`;

test('parseGaps extracts only the bullets under the gap heading', () => {
  const gaps = parseGaps(ANSWER);
  assert.deepEqual(gaps, ['Airbridge 링크 → home 매핑 규칙', 'page_type 전체 값 목록']);
});

test('parseGaps returns [] when the section is absent', () => {
  assert.deepEqual(parseGaps('## 결론\nno gaps here'), []);
});

test('parseGaps handles numbered lists and strips bold markers', () => {
  const md = `## 불확실하거나 추가 확인이 필요한 부분
1. **Notion 문서 미확인**: 접근 권한 필요
2. 담당 팀 확인
3) 딥링크 경로 추가 여부
`;
  assert.deepEqual(parseGaps(md), [
    'Notion 문서 미확인: 접근 권한 필요',
    '담당 팀 확인',
    '딥링크 경로 추가 여부',
  ]);
});

test('harvestGaps reads all .md files in a directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-'));
  fs.writeFileSync(path.join(dir, 'A.md'), ANSWER);
  fs.writeFileSync(path.join(dir, 'B.md'), '## 불확실하거나 추가 확인이 필요한 부분\n- extra topic\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  const gaps = harvestGaps(dir).sort();
  assert.deepEqual(gaps.sort(), ['Airbridge 링크 → home 매핑 규칙', 'extra topic', 'page_type 전체 값 목록'].sort());
});
