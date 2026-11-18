// mcp.ts — MCP over streamable HTTP (JSON-RPC 2.0): the legacy handshake path the suite's
// client accepts (server/discover -> -32601, then initialize), tools/list and tools/call for
// the six forge tools. Every tool effect lands in the same store the REST API reads, so it
// is visible over REST immediately.

import { issueJson, pullJson, repoJson } from './shapes.ts';
import type { Store } from './store.ts';

export interface McpResult {
  status: number;
  body: string;
}

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function toolResult(value: Record<string, unknown>, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function callTool(store: Store, baseUrl: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = pick(args, 'name');
      if (typeof repoName !== 'string' || repoName === '') return toolError('Missing required argument: name');
      const description = typeof pick(args, 'description') === 'string' ? (pick(args, 'description') as string) : '';
      const privateFlag = pick(args, 'private') === true;
      const existing = store.getRepo('adaiversen', repoName);
      if (existing !== undefined) return toolResult(repoJson(existing, baseUrl));
      const repo = store.createRepo(repoName, description, privateFlag);
      if (repo === null) return toolError(`Repository "${repoName}" already exists`);
      return toolResult(repoJson(repo, baseUrl));
    }
    case 'get_repo': {
      const owner = pick(args, 'owner');
      const repoName = pick(args, 'repo', 'repository');
      if (typeof owner !== 'string' || typeof repoName !== 'string') return toolError('Missing required arguments: owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      return toolResult(repoJson(repo, baseUrl));
    }
    case 'create_issue': {
      const owner = pick(args, 'owner');
      const repoName = pick(args, 'repo', 'repository');
      const title = pick(args, 'title');
      if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof title !== 'string') return toolError('Missing required arguments: owner, repo and title');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      const body = typeof pick(args, 'body') === 'string' ? (pick(args, 'body') as string) : '';
      const issue = repo.createIssue(title, body, []);
      return toolResult(issueJson(repo, issue, baseUrl));
    }
    case 'list_issues': {
      const owner = pick(args, 'owner');
      const repoName = pick(args, 'repo', 'repository');
      if (typeof owner !== 'string' || typeof repoName !== 'string') return toolError('Missing required arguments: owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      const state = typeof pick(args, 'state') === 'string' ? (pick(args, 'state') as string).toLowerCase() : 'all';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(repo, issue, baseUrl));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      const owner = pick(args, 'owner');
      const repoName = pick(args, 'repo', 'repository');
      const title = pick(args, 'title');
      const head = pick(args, 'head', 'head_ref');
      const base = pick(args, 'base', 'base_ref');
      if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
        return toolError('Missing required arguments: owner, repo, title, head and base');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      const body = typeof pick(args, 'body') === 'string' ? (pick(args, 'body') as string) : '';
      const pull = repo.createPull(title, body, head, base);
      if (pull === null) return toolError('Could not create pull request: check head and base branches');
      return toolResult(pullJson(repo, pull, baseUrl));
    }
    case 'merge_pull_request': {
      const owner = pick(args, 'owner');
      const repoName = pick(args, 'repo', 'repository');
      const numberRaw = pick(args, 'pull_number', 'pullNumber', 'number');
      if (typeof owner !== 'string' || typeof repoName !== 'string' || typeof numberRaw !== 'number') return toolError('Missing required arguments: owner, repo and pull_number');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolError('Repository not found');
      const pull = repo.pulls.find((p) => p.number === numberRaw);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.state !== 'open') return toolError('Pull request is not open');
      const result = repo.mergePull(pull);
      if ('conflict' in result) return toolError('Pull request has merge conflicts');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = result.sha;
      return toolResult({ merged: true, sha: result.sha, number: pull.number, state: 'closed' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function negotiate(params: Record<string, unknown> | undefined): string {
  if (params === undefined) return PROTOCOL_VERSIONS[0]!;
  const offered = params['protocolVersions'] ?? params['protocolVersion'];
  if (Array.isArray(offered)) {
    for (const version of offered) {
      if (typeof version === 'string' && PROTOCOL_VERSIONS.includes(version)) return version;
    }
  }
  if (typeof offered === 'string' && PROTOCOL_VERSIONS.includes(offered)) return offered;
  return PROTOCOL_VERSIONS[0]!;
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function rpcResult(id: unknown, result: Record<string, unknown>): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function handleOne(store: Store, baseUrl: string, request: unknown): McpResult | null {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
  }
  const req = request as Record<string, unknown>;
  const id = req['id'];
  const isNotification = id === undefined;
  const method = req['method'];
  if (typeof method !== 'string') {
    if (isNotification) return { status: 202, body: '' };
    return rpcError(id, -32600, 'Invalid Request: missing method');
  }
  // Notifications get an empty 202.
  if (isNotification) return { status: 202, body: '' };
  switch (method) {
    case 'server/discover':
      // Not supported: the client falls back to initialize (the legacy handshake).
      return rpcError(id, -32601, 'Method not found: server/discover');
    case 'initialize': {
      const params = req['params'];
      const version = negotiate(params !== null && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : undefined);
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone-01', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = req['params'];
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        return rpcError(id, -32602, 'Invalid params: tools/call requires an object');
      }
      const toolName = (params as Record<string, unknown>)['name'];
      if (typeof toolName !== 'string') return rpcError(id, -32602, 'Invalid params: missing tool name');
      if (!TOOLS.some((tool) => tool['name'] === toolName)) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      const args = (params as Record<string, unknown>)['arguments'];
      const argsObject = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      return rpcResult(id, callTool(store, baseUrl, toolName, argsObject));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle a POST /mcp request body (raw text — a non-JSON body is a -32700 parse error). */
export function handleMcp(store: Store, baseUrl: string, bodyText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } }),
    };
  }
  if (Array.isArray(parsed)) {
    const responses: McpResult[] = [];
    for (const item of parsed) {
      const result = handleOne(store, baseUrl, item);
      if (result !== null && result.status !== 202) responses.push(result);
    }
    return { status: 200, body: JSON.stringify(responses.map((r) => JSON.parse(r.body))) };
  }
  const result = handleOne(store, baseUrl, parsed);
  return result ?? { status: 202, body: '' };
}
