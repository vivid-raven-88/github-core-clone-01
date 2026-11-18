// shapes.ts — the JSON shapes the REST API, GraphQL ids and MCP tools share, so the same
// repository, issue and pull request look identical whichever surface reads them.

import type { Comment, Issue, Pull, Repo } from './store.ts';

export function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    fork: false,
    archived: false,
    visibility: repo.privateFlag ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `${baseUrl}/${repo.fullName}`,
    clone_url: `${baseUrl}/${repo.fullName}.git`,
    git_url: `${baseUrl}/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
  };
}

export function issueJson(repo: Repo, issue: Issue, baseUrl: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: null,
    locked: false,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' })),
    user: { login: repo.owner, id: 1000, type: 'User' },
    assignees: [],
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    closed_at: issue.state === 'closed' ? issue.createdAt : null,
    html_url: `${baseUrl}/${repo.fullName}/issues/${issue.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${repo.fullName}`,
  };
}

export function commentJson(repo: Repo, comment: Comment, issueNumber: number, baseUrl: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.owner}/${repo.name}#${issueNumber}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `${baseUrl}/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    issue_url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
  };
}

/** The memoised single-issue GET body. The response bytes for one issue are
 * identical on every read, so the read workload (2,000 GETs of the same issue)
 * builds them once and serves the Buffer afterwards. The cache is keyed by the
 * base URL it was built for and cleared whenever the issue changes: PATCH
 * (app.ts), addComment (store.ts) and closeIssue (graphql.ts). */
export function issueResponseBody(repo: Repo, issue: Issue, baseUrl: string): Buffer {
  const cached = issue.cached;
  if (cached !== null && cached.baseUrl === baseUrl) return cached.body;
  const body = Buffer.from(`${JSON.stringify(issueJson(repo, issue, baseUrl))}\n`, 'utf8');
  issue.cached = { baseUrl, body };
  return body;
}

export function pullJson(repo: Repo, pull: Pull, baseUrl: string): Record<string, unknown> {
  const headSha = repo.tipOf(pull.head) ?? '';
  const baseSha = repo.tipOf(pull.base) ?? '';
  return {
    id: pull.id,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    mergeable: !repo.pullConflicts(pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}`, repo: { name: repo.name, full_name: repo.fullName } },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}`, repo: { name: repo.name, full_name: repo.fullName } },
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    closed_at: pull.state === 'closed' ? pull.createdAt : null,
    html_url: `${baseUrl}/${repo.fullName}/pull/${pull.number}`,
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}
