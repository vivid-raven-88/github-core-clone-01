// app.ts — the HTTP server: auth, routing, REST v3, GraphQL v4, MCP and git smart HTTP.
// Everything is in-memory; every hot path is a Map lookup plus one JSON.stringify.

import { createFastServer, reqQuery, type FastRequest, type FastResponse, type Server } from './http.ts';
import { Store, VIEWER_ID, VIEWER_LOGIN, type Repo } from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseReceivePack,
  advertiseUploadPack,
  handleReceivePack,
  handleUploadPack,
  isObjectId,
  parseCommit,
  type HttpResult,
} from './git.ts';
import { commentJson, issueJson, issueResponseBody, pullJson, repoJson } from './shapes.ts';

const TOKEN = process.env['MAKEFUN_SHOP_TOKEN'] ?? '';
const store = new Store();
function baseUrlOf(host: string | undefined): string {
  if (typeof host === 'string' && host !== '') return `http://${host}`;
  return 'http://127.0.0.1';
}

/** An empty body, shared by the 204 and empty-202 replies. */
const EMPTY_BODY = Buffer.alloc(0);

/**
 * A reply is a value, not a write: handlers return a FastResponse and the
 * transport in http.ts serialises it in one write. Nothing here touches a
 * socket, which is what keeps the timed paths allocation-light.
 */
function send(status: number, body: Buffer, contentType: string, extra?: Record<string, string>): FastResponse {
  return { status, body, contentType, extra };
}

function sendJson(status: number, value: unknown, extra?: Record<string, string>): FastResponse {
  return send(status, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), 'application/json', extra);
}

function sendError(status: number, message: string): FastResponse {
  return sendJson(status, { message });
}

function sendGitResult(result: HttpResult): FastResponse {
  return send(result.status, result.body, result.contentType);
}

interface ParsedBody {
  ok: boolean;
  value: unknown;
}

/** Parse a JSON body; an empty body is `undefined`, malformed JSON is an error. */
function parseJsonBody(raw: Buffer): ParsedBody {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

function parseIdent(text: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', date: new Date().toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]!) * 1000).toISOString() };
}

function commitListItem(repo: Repo, sha: string, baseUrl: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const author = parseIdent(parsed.author);
  const committer = parseIdent(parsed.committer);
  const authorUser = author.email === 'adaiversen@example.invalid' ? { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' } : null;
  const committerUser = committer.email === 'adaiversen@example.invalid' ? { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' } : null;
  return {
    sha,
    node_id: sha,
    commit: {
      message: parsed.message.replace(/\n$/, ''),
      author,
      committer,
      tree: { sha: parsed.tree },
      url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
      comment_count: 0,
    },
    author: authorUser,
    committer: committerUser,
    parents: parsed.parents.map((parent) => ({ sha: parent, url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${parent}` })),
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
    html_url: `${baseUrl}/${repo.fullName}/commit/${sha}`,
  };
}

function pagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  return { perPage, page };
}

function pageOf<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(base: string, path: string, query: URLSearchParams, perPage: number, page: number, totalPages: number): Record<string, string> {
  if (page >= totalPages) return {};
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(page + 1));
  const last = new URLSearchParams(query);
  last.set('per_page', String(perPage));
  last.set('page', String(totalPages));
  return {
    Link: `<${base}${path}?${next.toString()}>; rel="next", <${base}${path}?${last.toString()}>; rel="last"`,
  };
}

// ---------------------------------------------------------------- REST v3

function handleRest(method: string, segments: string[], query: URLSearchParams, body: ParsedBody, base: string): FastResponse {
  const bodyObj = body.value !== null && typeof body.value === 'object' && !Array.isArray(body.value) ? (body.value as Record<string, unknown>) : {};

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return sendError(404, 'Not Found');
    return sendJson(200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_authorizations_html_url: `${base}/settings/applications`,
      authorizations_url: `${base}/api/v3/authorizations`,
      code_search_url: `${base}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      emails_url: `${base}/api/v3/user/emails`,
      emojis_url: `${base}/api/v3/emojis`,
      events_url: `${base}/api/v3/events`,
      feeds_url: `${base}/api/v3/feeds`,
      followers_url: `${base}/api/v3/user/followers`,
      following_url: `${base}/api/v3/user/following{/target}`,
      gists_url: `${base}/api/v3/gists{/gist_id}`,
      hub_url: `${base}/api/v3/hub`,
      issue_search_url: `${base}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${base}/api/v3/issues`,
      keys_url: `${base}/api/v3/user/keys`,
      notifications_url: `${base}/api/v3/notifications{?since,all,participating}`,
      organization_repositories_url: `${base}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_url: `${base}/api/v3/orgs/{org}`,
      public_gists_url: `${base}/api/v3/gists/public`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${base}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${base}/api/v3/gists/starred`,
      user_url: `${base}/api/v3/users/{user}`,
      user_organizations_url: `${base}/api/v3/user/orgs`,
      user_repositories_url: `${base}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${base}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  if (segments[0] === 'meta') {
    if (method !== 'GET') return sendError(404, 'Not Found');
    return sendJson(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return sendError(404, 'Not Found');
    return sendJson(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: Buffer.from(`User:${VIEWER_LOGIN}`, 'utf8').toString('base64'),
      type: 'User',
      site_admin: false,
      name: 'ada iversen',
      email: 'adaiversen@example.invalid',
      avatar_url: `${base}/avatars/${VIEWER_LOGIN}`,
      html_url: `${base}/${VIEWER_LOGIN}`,
      url: `${base}/api/v3/users/${VIEWER_LOGIN}`,
      repos_url: `${base}/api/v3/users/${VIEWER_LOGIN}/repos`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { perPage, page } = pagination(query);
      const repos = store.listRepos();
      const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
      const extra = linkHeader(base, '/api/v3/user/repos', query, perPage, page, totalPages);
      return sendJson(200, pageOf(repos, perPage, page).map((repo) => repoJson(repo, base)), extra);
    }
    if (method === 'POST') {
      const name = bodyObj['name'];
      if (typeof name !== 'string' || name === '' || name.includes('/')) {
        return sendError(422, 'Repository name is required and must not contain a slash');
      }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return sendError(422, `Repository "${name}" already exists`);
      }
      const description = typeof bodyObj['description'] === 'string' ? (bodyObj['description'] as string) : '';
      const privateFlag = bodyObj['private'] === true;
      const repo = store.createRepo(name, description, privateFlag);
      if (repo === null) return sendError(422, `Repository "${name}" already exists`);
      return sendJson(201, repoJson(repo, base));
    }
    return sendError(404, 'Not Found');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]!);
    const repoName = decodeURIComponent(segments[2]!);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return sendError(404, 'Not Found');
    return handleRepo(method, repo, segments.slice(3), query, bodyObj, base);
  }

  return sendError(404, 'Not Found');
}

function handleRepo(method: string, repo: Repo, rest: string[], query: URLSearchParams, bodyObj: Record<string, unknown>, base: string): FastResponse {
  // GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') return sendJson(200, repoJson(repo, base));
    if (method === 'PATCH') {
      if (typeof bodyObj['description'] === 'string') repo.description = bodyObj['description'] as string;
      const defaultBranch = bodyObj['default_branch'];
      if (typeof defaultBranch === 'string' && repo.tipOf(defaultBranch) !== undefined) repo.defaultBranch = defaultBranch;
      return sendJson(200, repoJson(repo, base));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: EMPTY_BODY, contentType: '' };
    }
    return sendError(404, 'Not Found');
  }

  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return sendError(404, 'Not Found');
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
          protected: false,
        });
      }
      return sendJson(200, branches);
    }
    if (rest.length === 2) {
      if (method !== 'GET') return sendError(404, 'Not Found');
      const branch = decodeURIComponent(rest[1]!);
      const sha = repo.tipOf(branch);
      if (sha === undefined) return sendError(404, 'Branch not found');
      return sendJson(200, {
        name: branch,
        commit: { sha, url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
        protected: false,
      });
    }
    return sendError(404, 'Not Found');
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'GET' && rest.length > 2) {
      const refName = `refs/${rest.slice(2).map((segment) => decodeURIComponent(segment)).join('/')}`;
      const sha = repo.refs.get(refName);
      if (sha === undefined) return sendError(404, 'Not Found');
      const object = repo.objects.get(sha);
      return sendJson(200, {
        ref: refName,
        node_id: repo.id,
        object: { sha, type: object?.type ?? 'commit', url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
        url: `${base}/api/v3/repos/${repo.fullName}/git/${refName}`,
      });
    }
    if (method === 'POST' && rest.length === 2) {
      const ref = bodyObj['ref'];
      const sha = bodyObj['sha'];
      if (typeof ref !== 'string' || !ref.startsWith('refs/')) return sendError(422, 'ref must start with "refs/"');
      if (typeof sha !== 'string' || !isObjectId(sha)) return sendError(422, 'sha must be a 40-character hex object id');
      const object = repo.objects.get(sha);
      if (object === undefined) return sendError(422, 'Object does not exist');
      const existing = repo.refs.get(ref);
      if (existing !== undefined) {
        if (existing === sha) {
          return sendJson(201, { ref, object: { sha, type: object.type, url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
        }
        return sendError(422, 'Reference already exists');
      }
      repo.refs.set(ref, sha);
      repo.version += 1;
      return sendJson(201, { ref, object: { sha, type: object.type, url: `${base}/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
    }
    return sendError(404, 'Not Found');
  }

  if (head === 'commits' && rest.length === 1) {
    if (method !== 'GET') return sendError(404, 'Not Found');
    const shaParam = query.get('sha');
    const ref = shaParam !== null && shaParam !== '' ? shaParam : repo.defaultBranch;
    const { perPage, page } = pagination(query);
    const commits = repo.commitsOf(ref);
    const totalPages = Math.max(1, Math.ceil(commits.length / perPage));
    const extra = linkHeader(base, `/api/v3/repos/${repo.fullName}/commits`, query, perPage, page, totalPages);
    const items: Array<Record<string, unknown>> = [];
    for (const entry of pageOf(commits, perPage, page)) {
      const item = commitListItem(repo, entry.sha, base);
      if (item !== null) items.push(item);
    }
    return sendJson(200, items, extra);
  }

  if (head === 'contents') {
    const segments = rest.slice(1).map((segment) => decodeURIComponent(segment)).filter((segment) => segment !== '');
    const path = segments.join('/');
    if (method === 'GET') return handleGetContents(repo, segments, path, query, base);
    if (method === 'PUT') return handlePutContents(repo, segments, path, bodyObj, base);
    if (method === 'DELETE') return handleDeleteContents(repo, segments, path, bodyObj, base);
    return sendError(404, 'Not Found');
  }

  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return sendJson(200, [...repo.labels.values()].map((label) => ({
        name: label.name,
        color: label.color,
        description: label.description,
        url: `${base}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
      })));
    }
    if (method === 'POST' && rest.length === 1) {
      const name = bodyObj['name'];
      if (typeof name !== 'string' || name === '') return sendError(422, 'Label name is required');
      if (repo.labels.has(name)) return sendError(422, `Label "${name}" already exists`);
      const color = typeof bodyObj['color'] === 'string' ? (bodyObj['color'] as string) : 'ededed';
      const description = typeof bodyObj['description'] === 'string' ? (bodyObj['description'] as string) : '';
      repo.labels.set(name, { name, color, description });
      return sendJson(201, { name, color, description, url: `${base}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}` });
    }
    return sendError(404, 'Not Found');
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = (query.get('state') ?? 'open').toLowerCase();
        const direction = (query.get('direction') ?? 'desc').toLowerCase();
        const labelFilter = query.get('labels');
        const { perPage, page } = pagination(query);
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (labelFilter !== null && labelFilter !== '') issues = issues.filter((issue) => issue.labels.includes(labelFilter));
        issues.sort((a, b) => direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
        const totalPages = Math.max(1, Math.ceil(issues.length / perPage));
        const extra = linkHeader(base, `/api/v3/repos/${repo.fullName}/issues`, query, perPage, page, totalPages);
        return sendJson(200, pageOf(issues, perPage, page).map((issue) => issueJson(repo, issue, base)), extra);
      }
      if (method === 'POST') {
        const title = bodyObj['title'];
        if (typeof title !== 'string' || title === '') return sendError(422, 'title is required');
        const body = typeof bodyObj['body'] === 'string' ? (bodyObj['body'] as string) : '';
        const rawLabels = bodyObj['labels'];
        const labels: string[] = [];
        if (Array.isArray(rawLabels)) {
          for (const label of rawLabels) {
            const name = typeof label === 'string' ? label : (label !== null && typeof label === 'object' ? (label as Record<string, unknown>)['name'] : undefined);
            if (typeof name !== 'string') continue;
            if (!repo.labels.has(name)) return sendError(422, `Label "${name}" does not exist`);
            labels.push(name);
          }
        }
        const issue = repo.createIssue(title, body, labels);
        return sendJson(201, issueJson(repo, issue, base));
      }
      return sendError(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return sendError(404, 'Not Found');
    const issue = repo.issueByNumber.get(number);
    if (rest.length === 2) {
      if (issue === undefined) return sendError(404, 'Not Found');
      if (method === 'GET') return send(200, issueResponseBody(repo, issue, base), 'application/json');
      if (method === 'PATCH') {
        if (typeof bodyObj['title'] === 'string') issue.title = bodyObj['title'] as string;
        if (typeof bodyObj['body'] === 'string') issue.body = bodyObj['body'] as string;
        const state = bodyObj['state'];
        if (state === 'open' || state === 'closed') issue.state = state;
        else if (state !== undefined) return sendError(422, 'state must be "open" or "closed"');
        issue.cached = null;
        return sendJson(200, issueJson(repo, issue, base));
      }
      return sendError(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return sendError(404, 'Not Found');
      if (method === 'GET') {
        const comments = repo.comments.get(number) ?? [];
        return sendJson(200, comments.map((comment) => commentJson(repo, comment, number, base)));
      }
      if (method === 'POST') {
        const commentBody = bodyObj['body'];
        if (typeof commentBody !== 'string') return sendError(422, 'body is required');
        const comment = repo.addComment(number, commentBody);
        if (comment === null) return sendError(404, 'Not Found');
        return sendJson(201, commentJson(repo, comment, number, base));
      }
      return sendError(404, 'Not Found');
    }
    return sendError(404, 'Not Found');
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = (query.get('state') ?? 'open').toLowerCase();
        const { perPage, page } = pagination(query);
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const totalPages = Math.max(1, Math.ceil(pulls.length / perPage));
        const extra = linkHeader(base, `/api/v3/repos/${repo.fullName}/pulls`, query, perPage, page, totalPages);
        return sendJson(200, pageOf(pulls, perPage, page).map((pull) => pullJson(repo, pull, base)), extra);
      }
      if (method === 'POST') {
        const title = bodyObj['title'];
        const headBranch = bodyObj['head'];
        const baseBranch = bodyObj['base'];
        if (typeof title !== 'string' || title === '') return sendError(422, 'title is required');
        if (typeof headBranch !== 'string' || typeof baseBranch !== 'string') return sendError(422, 'head and base are required');
        if (repo.tipOf(headBranch) === undefined) return sendError(422, `Head branch "${headBranch}" does not exist`);
        if (repo.tipOf(baseBranch) === undefined) return sendError(422, `Base branch "${baseBranch}" does not exist`);
        if (repo.pulls.some((pull) => pull.state === 'open' && pull.head === headBranch && pull.base === baseBranch)) {
          return sendError(422, 'A pull request already exists for these branches');
        }
        const body = typeof bodyObj['body'] === 'string' ? (bodyObj['body'] as string) : '';
        const pull = repo.createPull(title, body, headBranch, baseBranch);
        if (pull === null) return sendError(422, 'Could not create pull request');
        return sendJson(201, pullJson(repo, pull, base));
      }
      return sendError(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return sendError(404, 'Not Found');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (pull === undefined) return sendError(404, 'Not Found');
      if (method === 'GET') return sendJson(200, pullJson(repo, pull, base));
      return sendError(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) return sendError(404, 'Not Found');
      if (method !== 'GET') return sendError(404, 'Not Found');
      return sendJson(200, repo.pullFiles(pull));
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === undefined) return sendError(404, 'Not Found');
      if (method !== 'PUT') return sendError(404, 'Not Found');
      if (pull.state !== 'open') return sendError(405, 'Pull request is not open');
      const result = repo.mergePull(pull);
      if ('conflict' in result) return sendError(405, 'Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = result.sha;
      return sendJson(200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
    }
    return sendError(404, 'Not Found');
  }

  return sendError(404, 'Not Found');
}

function handleGetContents(repo: Repo, segments: string[], path: string, query: URLSearchParams, base: string): FastResponse {
  const refParam = query.get('ref');
  let resolved: { oid: string; commit: ReturnType<typeof parseCommit> } | null = null;
  if (refParam !== null && refParam !== '') resolved = repo.resolveCommit(refParam);
  else if (repo.tipOf(repo.defaultBranch) !== undefined) resolved = repo.resolveCommit(repo.defaultBranch);
  if (resolved === null) return sendError(404, 'Not Found');
  const treeOid = resolved.commit.tree;
  const entryUrl = (entryPath: string): string => `${base}/api/v3/repos/${repo.fullName}/contents/${entryPath.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
  if (segments.length === 0) {
    const entries = repo.listDir(treeOid, []);
    if (entries === null) return sendError(404, 'Not Found');
    return sendJson(200, entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      url: entryUrl(entry.name),
      html_url: `${base}/${repo.fullName}/blob/${repo.defaultBranch}/${entry.name}`,
      git_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
      download_url: `${base}/${repo.fullName}/raw/${repo.defaultBranch}/${entry.name}`,
    })));
  }
  const blobOid = repo.lookupPath(treeOid, segments);
  if (blobOid !== null) {
    const object = repo.objects.get(blobOid);
    const data = object?.data ?? Buffer.alloc(0);
    return sendJson(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: segments[segments.length - 1]!,
      path,
      content: data.toString('base64'),
      sha: blobOid,
      url: entryUrl(path),
      html_url: `${base}/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
      git_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
      download_url: `${base}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
    });
  }
  const entries = repo.listDir(treeOid, segments);
  if (entries !== null) {
    return sendJson(200, entries.map((entry) => {
      const entryPath = `${path}/${entry.name}`;
      return {
        type: entry.mode === '40000' ? 'dir' : 'file',
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        name: entry.name,
        path: entryPath,
        sha: entry.oid,
        url: entryUrl(entryPath),
        html_url: `${base}/${repo.fullName}/blob/${repo.defaultBranch}/${entryPath}`,
        git_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
        download_url: `${base}/${repo.fullName}/raw/${repo.defaultBranch}/${entryPath}`,
      };
    }));
  }
  return sendError(404, 'Not Found');
}

function handlePutContents(repo: Repo, segments: string[], path: string, bodyObj: Record<string, unknown>, base: string): FastResponse {
  const contentB64 = bodyObj['content'];
  if (typeof contentB64 !== 'string') return sendError(400, 'content is required and must be base64');
  const content = Buffer.from(contentB64, 'base64');
  const message = typeof bodyObj['message'] === 'string' ? (bodyObj['message'] as string) : `Update ${path}`;
  const branch = typeof bodyObj['branch'] === 'string' && bodyObj['branch'] !== '' ? (bodyObj['branch'] as string) : repo.defaultBranch;
  let tip = repo.tipOf(branch);
  if (tip === undefined) {
    if (repo.refs.size === 0) {
      // Unborn repository: this write creates the branch.
    } else {
      const defaultTip = repo.tipOf(repo.defaultBranch);
      if (defaultTip === undefined) return sendError(422, `Branch "${branch}" does not exist`);
      repo.refs.set(`refs/heads/${branch}`, defaultTip);
      repo.version += 1;
      tip = defaultTip;
    }
  }
  const treeOid = tip === undefined ? null : repo.treeOfCommit(tip);
  const currentBlob = treeOid === null ? null : repo.lookupPath(treeOid, segments);
  const sha = bodyObj['sha'];
  if (sha !== undefined) {
    if (typeof sha !== 'string' || sha !== currentBlob) {
      return sendError(409, 'sha does not match the current file');
    }
  }
  const isCreate = currentBlob === null;
  const { commitSha, contentSha } = repo.commitFile(branch, path, content, message);
  const commit = commitListItem(repo, commitSha, base) ?? { sha: commitSha, message };
  return sendJson(isCreate ? 201 : 200, {
    content: {
      name: segments[segments.length - 1] ?? '',
      path,
      sha: contentSha,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: contentB64,
      url: `${base}/api/v3/repos/${repo.fullName}/contents/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`,
      html_url: `${base}/${repo.fullName}/blob/${branch}/${path}`,
      git_url: `${base}/api/v3/repos/${repo.fullName}/git/blobs/${contentSha}`,
      download_url: `${base}/${repo.fullName}/raw/${branch}/${path}`,
    },
    commit,
  });
}

function handleDeleteContents(repo: Repo, segments: string[], path: string, bodyObj: Record<string, unknown>, base: string): FastResponse {
  const message = typeof bodyObj['message'] === 'string' ? (bodyObj['message'] as string) : `Delete ${path}`;
  const branch = typeof bodyObj['branch'] === 'string' && bodyObj['branch'] !== '' ? (bodyObj['branch'] as string) : repo.defaultBranch;
  const tip = repo.tipOf(branch);
  if (tip === undefined) return sendError(404, 'Not Found');
  const treeOid = repo.treeOfCommit(tip);
  if (treeOid === null) return sendError(404, 'Not Found');
  const currentBlob = repo.lookupPath(treeOid, segments);
  if (currentBlob === null) return sendError(404, 'Not Found');
  const sha = bodyObj['sha'];
  if (sha !== undefined && sha !== currentBlob) return sendError(409, 'sha does not match the current file');
  const { commitSha } = repo.commitFile(branch, path, null, message);
  const commit = commitListItem(repo, commitSha, base) ?? { sha: commitSha, message };
  return sendJson(200, { commit });
}

// ---------------------------------------------------------------- git smart HTTP

function handleGit(method: string, pathname: string, query: URLSearchParams, gitProtocol: string | undefined, body: Buffer): FastResponse {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (match === null) return sendError(404, 'Not Found');
  const owner = decodeURIComponent(match[1]!);
  const repoName = decodeURIComponent(match[2]!);
  const suffix = match[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return sendError(404, 'Not Found');
  if (method === 'GET' && suffix === '/info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = gitProtocol === 'version=2';
      return sendGitResult(advertiseUploadPack(repo, v2));
    }
    if (service === 'git-receive-pack') {
      return sendGitResult(advertiseReceivePack(repo));
    }
    return sendError(400, 'service parameter is required');
  }
  if (method === 'POST' && suffix === '/git-upload-pack') {
    return sendGitResult(handleUploadPack(repo, body));
  }
  if (method === 'POST' && suffix === '/git-receive-pack') {
    const before = new Set(repo.objects.keys());
    const result = handleReceivePack(repo, body);
    const added: string[] = [];
    for (const oid of repo.objects.keys()) if (!before.has(oid)) added.push(oid);
    store.noteNewCommits(repo, added);
    return sendGitResult(result);
  }
  return sendError(404, 'Not Found');
}

// ---------------------------------------------------------------- server

/** Build the forge server. main.ts binds it to an ephemeral port and owns the lifecycle. */
export function createApp(): Server {
  return createFastServer((req: FastRequest): FastResponse => {
    try {
      const pathname = req.path;
      const method = req.method;

      if (method === 'GET' && pathname === '/healthz') {
        return sendJson(200, { ok: true });
      }

      // Auth: every API call carries the token, except /healthz.
      if (TOKEN !== '') {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${TOKEN}`) return sendError(401, 'Bad credentials');
      }

      const body = req.body;

      if (pathname === '/api/graphql' && method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(400, 'GraphQL request body is not valid JSON');
        return sendJson(200, executeGraphQL(store, parsed.value));
      }

      if (pathname === '/mcp' && method === 'POST') {
        const result = handleMcp(store, baseUrlOf(req.headers['host']), body.toString('utf8'));
        return send(result.status, Buffer.from(result.body, 'utf8'), 'application/json');
      }

      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const segments = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').map((segment) => decodeURIComponent(segment));
        const base = baseUrlOf(req.headers['host']);
        const query = reqQuery(req);
        if (method === 'GET' || method === 'DELETE') {
          return handleRest(method, segments, query, { ok: true, value: undefined }, base);
        }
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendError(400, 'Request body is not valid JSON');
        return handleRest(method, segments, query, parsed, base);
      }

      if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(pathname)) {
        return handleGit(method, pathname, reqQuery(req), req.headers['git-protocol'], body);
      }

      return sendError(404, 'Not Found');
    } catch (error) {
      // Never let one request kill the process: answer 500 JSON and keep serving.
      return sendError(500, error instanceof Error ? error.message : 'Internal Server Error');
    }
  });
}
