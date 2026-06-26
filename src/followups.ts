// Comment-driven follow-ups: persistent state + pure detection helper.
//
// Symphony polls Linear for comments created since `lastCheck` (cheap — scales
// with comment volume, not ticket count). A comment is a follow-up to answer when
// it is by a human (not the bot), not already responded to, and the bot has
// previously commented on that issue (i.e. it answered it). State persists so a
// restart does not re-answer old comments.

import * as fs from 'fs';
import * as path from 'path';

export interface FollowupState {
  lastCheck: string; // ISO; only comments created after this are considered
  responded: string[]; // comment ids already answered
}

export class FollowupStore {
  private state: FollowupState;

  constructor(private readonly filePath: string, nowIso: string) {
    this.state = this.load(nowIso);
  }

  private load(nowIso: string): FollowupState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<FollowupState>;
      return {
        lastCheck: typeof raw.lastCheck === 'string' ? raw.lastCheck : nowIso,
        responded: Array.isArray(raw.responded) ? raw.responded.map(String) : [],
      };
    } catch {
      // First run: start from "now" so we don't reply to all historical comments.
      return { lastCheck: nowIso, responded: [] };
    }
  }

  get lastCheck(): string {
    return this.state.lastCheck;
  }

  hasResponded(commentId: string): boolean {
    return this.state.responded.includes(commentId);
  }

  markResponded(commentId: string): void {
    if (!this.state.responded.includes(commentId)) this.state.responded.push(commentId);
    if (this.state.responded.length > 1000) this.state.responded = this.state.responded.slice(-1000);
    this.save();
  }

  setLastCheck(iso: string): void {
    this.state.lastCheck = iso;
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }
}

/**
 * A comment is a follow-up to answer iff: not authored by the bot, not already
 * responded to, and the bot has previously commented on that issue (proving it
 * answered the issue — so this is a reply to the bot, not unrelated chatter).
 */
export function isFollowupComment(
  comment: { id: string; authorId: string },
  botId: string,
  issueCommentAuthorIds: string[],
  responded: (id: string) => boolean,
): boolean {
  if (comment.authorId === botId) return false;
  if (responded(comment.id)) return false;
  return issueCommentAuthorIds.includes(botId);
}
