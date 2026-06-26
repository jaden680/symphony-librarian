// Minimal Linear GraphQL client.
//
// Uses the global fetch (Node 22+). The personal API key is sent verbatim in the
// Authorization header per Linear's convention. The key is never logged.

import { CommentInfo, Issue, TrackerState } from './types';

export class LinearError extends Error {
  constructor(public readonly category: string, message: string) {
    super(message);
    this.name = 'LinearError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class LinearClient {
  constructor(private readonly endpoint: string, private readonly apiKey: string) {}

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new LinearError('linear_api_request', `request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new LinearError('linear_api_status', `unexpected HTTP status ${res.status}`);
    }
    let payload: GraphQLResponse<T>;
    try {
      payload = (await res.json()) as GraphQLResponse<T>;
    } catch (err) {
      throw new LinearError('linear_unknown_payload', `invalid JSON payload: ${(err as Error).message}`);
    }
    if (payload.errors && payload.errors.length > 0) {
      throw new LinearError('linear_graphql_errors', payload.errors.map((e) => e.message).join('; '));
    }
    if (payload.data === undefined) {
      throw new LinearError('linear_unknown_payload', 'response contained no data');
    }
    return payload.data;
  }

  /** Resolve a team by its key (e.g. "ZZ"), returning its id and workflow states. */
  async getTeam(teamKey: string): Promise<{ id: string; key: string; name: string; states: TrackerState[] }> {
    const data = await this.query<{
      teams: { nodes: Array<{ id: string; key: string; name: string; states: { nodes: TrackerState[] } }> };
    }>(
      `query SymphonyTeam($key: String!) {
         teams(filter: { key: { eq: $key } }, first: 1) {
           nodes { id key name states { nodes { id name type } } }
         }
       }`,
      { key: teamKey },
    );
    const node = data.teams.nodes[0];
    if (!node) throw new LinearError('linear_unknown_payload', `no team found with key "${teamKey}"`);
    return { id: node.id, key: node.key, name: node.name, states: node.states.nodes };
  }

  /**
   * Fetch all issues for the team whose state name is in activeStates, paging
   * through every result (no silent truncation) ordered oldest-first.
   */
  async fetchCandidateIssues(teamId: string, activeStates: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    let after: string | null = null;
    // Bound the loop defensively in case a tracker misreports pageInfo.
    for (let page = 0; page < 200; page++) {
      const data: {
        issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await this.query(
        `query SymphonyIssues($teamId: ID!, $states: [String!], $after: String) {
           issues(
             filter: { team: { id: { eq: $teamId } }, state: { name: { in: $states } } }
             orderBy: createdAt
             first: 100
             after: $after
           ) {
             nodes {
               id identifier title description priority url branchName createdAt updatedAt
               state { id name type }
               labels { nodes { name } }
               inverseRelations { nodes { type issue { id state { type } } } }
             }
             pageInfo { hasNextPage endCursor }
           }
         }`,
        { teamId, states: activeStates, after },
      );
      for (const n of data.issues.nodes) out.push(normalizeIssue(n));
      if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) break;
      after = data.issues.pageInfo.endCursor;
    }
    return out;
  }

  /** Re-fetch states of running issues (reconciliation), chunked to avoid truncation. */
  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const data = await this.query<{ issues: { nodes: Array<{ id: string; state: { name: string } }> } }>(
        `query SymphonyIssueStates($ids: [ID!]!) {
           issues(filter: { id: { in: $ids } }, first: 100) {
             nodes { id state { name } }
           }
         }`,
        { ids: chunk },
      );
      for (const n of data.issues.nodes) out.set(n.id, n.state.name);
    }
    return out;
  }

  /** Move an issue to the workflow state with the given id. */
  async moveIssueToState(issueId: string, stateId: string): Promise<void> {
    const data = await this.query<{ issueUpdate: { success: boolean } }>(
      `mutation SymphonyMove($id: String!, $stateId: String!) {
         issueUpdate(id: $id, input: { stateId: $stateId }) { success }
       }`,
      { id: issueId, stateId },
    );
    if (!data.issueUpdate.success) {
      throw new LinearError('linear_graphql_errors', `issueUpdate returned success=false for ${issueId}`);
    }
  }

  /** Post a comment on an issue (used to publish the answer back to Linear). */
  async createComment(issueId: string, body: string): Promise<void> {
    const data = await this.query<{ commentCreate: { success: boolean } }>(
      `mutation SymphonyComment($issueId: String!, $body: String!) {
         commentCreate(input: { issueId: $issueId, body: $body }) { success }
       }`,
      { issueId, body },
    );
    if (!data.commentCreate.success) {
      throw new LinearError('linear_graphql_errors', `commentCreate returned success=false for ${issueId}`);
    }
  }

  /** The authenticated bot user's id — used to tell bot vs human comments apart. */
  async getViewerId(): Promise<string> {
    const data = await this.query<{ viewer: { id: string } }>(`query SymphonyViewer { viewer { id } }`, {});
    return data.viewer.id;
  }

  /**
   * Comments created after `sinceIso` (best-effort: filtered server-side by
   * createdAt; the caller re-checks). NOTE: the `createdAt` filter scalar is
   * verified only against the offline test fake — confirm against live Linear.
   */
  async fetchCommentsSince(sinceIso: string): Promise<CommentInfo[]> {
    const data = await this.query<{ comments: { nodes: RawComment[] } }>(
      `query SymphonyComments($since: DateTimeOrDuration!) {
         comments(filter: { createdAt: { gt: $since } }, first: 50) {
           nodes {
             id body createdAt
             user { id }
             issue { id identifier title description state { name } team { key } }
           }
         }
       }`,
      { since: sinceIso },
    );
    return (data.comments.nodes ?? []).filter((c) => c.issue).map(normalizeComment);
  }

  /** Full comment thread of an issue (oldest first), for follow-up context. */
  async fetchIssueComments(issueId: string): Promise<Array<{ id: string; authorId: string | null; body: string; createdAt: string }>> {
    const data = await this.query<{
      issue: { comments: { nodes: Array<{ id: string; body: string; createdAt: string; user: { id: string } | null }> } } | null;
    }>(
      `query SymphonyIssueComments($id: String!) {
         issue(id: $id) { comments(first: 100) { nodes { id body createdAt user { id } } } }
       }`,
      { id: issueId },
    );
    const nodes = data.issue?.comments.nodes ?? [];
    return nodes
      .map((n) => ({ id: n.id, authorId: n.user?.id ?? null, body: n.body, createdAt: n.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string } | null;
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    state: { name: string };
    team: { key: string };
  } | null;
}

function normalizeComment(raw: RawComment): CommentInfo {
  const i = raw.issue!;
  return {
    id: raw.id,
    body: raw.body ?? '',
    createdAt: raw.createdAt,
    authorId: raw.user?.id ?? '',
    issue: {
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      description: i.description ?? null,
      state: i.state.name,
      teamKey: i.team.key,
    },
  };
}

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  url: string | null;
  branchName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  state: { id: string; name: string; type: string };
  labels: { nodes: Array<{ name: string }> };
  // inverseRelations: relations pointing AT this issue. For a node of type
  // "blocks", the relation's source `issue` is the one that blocks us.
  inverseRelations?: { nodes: Array<{ type: string; issue: { id: string; state: { type: string } } }> };
}

const TERMINAL_TYPES = new Set(['completed', 'canceled', 'cancelled']);

function normalizeIssue(raw: RawIssue): Issue {
  // blocked_by: an inverseRelation of type "blocks" means `issue` blocks THIS
  // issue. Treat such blockers as active only while their own state is
  // non-terminal. (Linear's `relations` is the opposite direction — the issues
  // THIS one blocks — which is why we query inverseRelations here.)
  const blockedBy: string[] = [];
  for (const rel of raw.inverseRelations?.nodes ?? []) {
    if (rel.type === 'blocks' && !TERMINAL_TYPES.has((rel.issue.state.type || '').toLowerCase())) {
      blockedBy.push(rel.issue.id);
    }
  }
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? null,
    priority: raw.priority ?? null,
    state: raw.state.name,
    branch_name: raw.branchName ?? null,
    url: raw.url ?? null,
    labels: (raw.labels?.nodes ?? []).map((l) => l.name.trim().toLowerCase()),
    blocked_by: blockedBy,
    created_at: raw.createdAt ?? null,
    updated_at: raw.updatedAt ?? null,
  };
}
