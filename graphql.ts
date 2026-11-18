// graphql.ts — a minimal GraphQL executor for the documents the suite (and the gh CLI /
// github-mcp-server) actually send: viewer, repository, node, __type, issue/pull-request
// connections and the five mutations. It is a parser plus a typed resolver, not a general
// GraphQL engine; unknown fields produce an `errors` entry (HTTP 200) the way GitHub does.

import { VIEWER_ID, VIEWER_LOGIN, decodeGlobalId, globalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i += 1; continue; }
    if (c === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const value = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    i += 1;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface DirectiveNode {
  name: string;
  args: Map<string, ValueNode>;
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  directives: DirectiveNode[];
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Map<string, ValueNode | undefined>;
  selections: SelectionNode[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinition>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", got ${JSON.stringify(token)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(token)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const document: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        document.operations.push({ kind: 'query', name: null, variableDefinitions: new Map(), selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        document.operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        document.fragments.set(name, { name, typeCondition, selections });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)}`);
      }
    }
    return document;
  }

  private parseOperation(): OperationNode {
    const kindToken = this.next();
    const kind = (kindToken.kind === 'name' ? kindToken.value : '') as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') {
      const nameToken = this.next();
      if (nameToken.kind === 'name') name = nameToken.value;
    }
    const variableDefinitions = new Map<string, ValueNode | undefined>();
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.isPunct('=')) {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.set(varName, defaultValue);
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variableDefinitions, selections };
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const head = this.peek();
    if (head.kind === 'punct' && head.value === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value !== 'on') {
        const nameToken = this.next();
        const name = nameToken.kind === 'name' ? nameToken.value : '';
        return { kind: 'spread', name, directives: this.parseDirectives() };
      }
      let typeCondition: string | null = null;
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      return { kind: 'inlineFragment', typeCondition, directives, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    const directives = this.parseDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, directives, selections };
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.isPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = new Map<string, ValueNode>();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
        this.expectPunct(')');
      }
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime values
// ---------------------------------------------------------------------------

/** A resolved object: its GraphQL type plus the underlying store value. */
class GqlValue {
  readonly type: string;
  readonly data: unknown;
  constructor(type: string, data: unknown) {
    this.type = type;
    this.data = data;
  }
}

interface ExecutionContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
  errors: Array<{ message: string }>;
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const node = field.args.get(name);
  if (node === undefined) return undefined;
  return resolveValue(node, variables);
}

function directivesSkip(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const ifNode = directive.args.get('if');
    if (ifNode === undefined) continue;
    const value = resolveValue(ifNode, variables);
    if (directive.name === 'skip' && value === true) return true;
    if (directive.name === 'include' && value === false) return true;
  }
  return false;
}

function cursorFor(key: string): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function keyFromCursor(cursor: string): string | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    return text.slice('cursor:'.length);
  } catch {
    return null;
  }
}

/** Slice a list into a Relay-style connection page. */
function paginate<T>(items: T[], keyOf: (item: T) => string, first: unknown, after: unknown): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (typeof after === 'string') {
    const key = keyFromCursor(after);
    if (key !== null) {
      const index = items.findIndex((item) => keyOf(item) === key);
      if (index >= 0) start = index + 1;
    }
  }
  const count = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : items.length;
  const page = items.slice(start, start + count);
  return {
    nodes: page,
    hasNextPage: start + page.length < items.length,
    endCursor: page.length > 0 ? cursorFor(keyOf(page[page.length - 1]!)) : null,
  };
}

// ---------------------------------------------------------------------------
// Type metadata (for __type introspection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'],
};

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function resolveSelections(ctx: ExecutionContext, node: GqlValue | null, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      if (directivesSkip(selection.directives, ctx.variables)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== null && node !== null && fragment.typeCondition !== node.type) continue;
      Object.assign(out, resolveSelections(ctx, node, fragment.selections));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (directivesSkip(selection.directives, ctx.variables)) continue;
      if (selection.typeCondition !== null && node !== null && selection.typeCondition !== node.type) continue;
      Object.assign(out, resolveSelections(ctx, node, selection.selections));
      continue;
    }
    // Field
    if (directivesSkip(selection.directives, ctx.variables)) continue;
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(ctx, node, selection);
  }
  return out;
}

function errorField(ctx: ExecutionContext, node: GqlValue | null, field: FieldNode): null {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${node === null ? 'Query' : node.type}".` });
  return null;
}

function resolveField(ctx: ExecutionContext, node: GqlValue | null, field: FieldNode): unknown {
  if (node === null) return resolveRootField(ctx, field);
  switch (node.type) {
    case 'User': return resolveUserField(ctx, node, field);
    case 'Repository': return resolveRepositoryField(ctx, node, field);
    case 'Issue': return resolveIssueField(ctx, node, field);
    case 'PullRequest': return resolvePullRequestField(ctx, node, field);
    case 'Ref': {
      const ref = node.data as { name: string };
      if (field.name === 'name') return ref.name;
      return errorField(ctx, node, field);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'FileConnection': return resolveConnectionField(ctx, node, field);
    case 'PageInfo': {
      const pageInfo = node.data as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return pageInfo.hasNextPage;
      if (field.name === 'endCursor') return pageInfo.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return errorField(ctx, node, field);
    }
    case '__Type': return resolveTypeField(ctx, node, field);
    case 'IssueComment': {
      const comment = node.data as { id: string; body: string };
      if (field.name === 'id') return comment.id;
      if (field.name === 'body') return comment.body;
      return errorField(ctx, node, field);
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') {
        const comment = node.data as { id: string; body: string };
        return resolveSelections(ctx, new GqlValue('IssueComment', comment), field.selections ?? []);
      }
      return errorField(ctx, node, field);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') {
        const issue = node.data as Issue;
        return resolveSelections(ctx, new GqlValue('Issue', issue), field.selections ?? []);
      }
      return errorField(ctx, node, field);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') {
        const pull = node.data as Pull;
        return resolveSelections(ctx, new GqlValue('PullRequest', pull), field.selections ?? []);
      }
      return errorField(ctx, node, field);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        const comment = node.data as { id: string; body: string };
        return resolveSelections(ctx, new GqlValue('IssueCommentEdge', comment), field.selections ?? []);
      }
      return errorField(ctx, node, field);
    }
    default:
      return errorField(ctx, node, field);
  }
}

function resolveRootField(ctx: ExecutionContext, field: FieldNode): unknown {
  switch (field.name) {
    case 'viewer': {
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('User', { login: VIEWER_LOGIN, id: VIEWER_ID }), field.selections);
    }
    case 'repository': {
      const owner = argValue(field, 'owner', ctx.variables);
      const name = argValue(field, 'name', ctx.variables);
      const repo = typeof owner === 'string' && typeof name === 'string' ? ctx.store.getRepo(owner, name) : undefined;
      if (repo === undefined) return null;
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('Repository', repo), field.selections);
    }
    case 'node': {
      const id = argValue(field, 'id', ctx.variables);
      if (typeof id !== 'string') return null;
      const found = ctx.store.findByGlobalId(id);
      if (found === null) return null;
      if (field.selections === null) return null;
      if (found.kind === 'Repository' && found.repo !== undefined) return resolveSelections(ctx, new GqlValue('Repository', found.repo), field.selections);
      if (found.kind === 'Issue' && found.issue !== undefined) return resolveSelections(ctx, new GqlValue('Issue', found.issue), field.selections);
      if (found.kind === 'PullRequest' && found.pull !== undefined) return resolveSelections(ctx, new GqlValue('PullRequest', found.pull), field.selections);
      return null;
    }
    case '__type': {
      const name = argValue(field, 'name', ctx.variables);
      if (typeof name !== 'string') return null;
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('__Type', { name }), field.selections);
    }
    case 'createIssue': return resolveCreateIssue(ctx, field);
    case 'closeIssue': return resolveCloseIssue(ctx, field);
    case 'createPullRequest': return resolveCreatePullRequest(ctx, field);
    case 'mergePullRequest': return resolveMergePullRequest(ctx, field);
    case 'addComment': return resolveAddComment(ctx, field);
    case '__typename': return 'Query';
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
      return null;
  }
}

function resolveUserField(ctx: ExecutionContext, node: GqlValue, field: FieldNode): unknown {
  const user = node.data as { login: string; id: number };
  if (field.name === 'login') return user.login;
  if (field.name === 'id') return globalId('User', user.login);
  if (field.name === 'name') return user.login;
  if (field.name === '__typename') return 'User';
  return errorField(ctx, node, field);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveRepositoryField(ctx: ExecutionContext, node: GqlValue, field: FieldNode): unknown {
  const repo = node.data as Repo;
  switch (field.name) {
    case 'id': return repo.id;
    case 'databaseId': return repo.databaseId;
    case 'name': return repo.name;
    case 'nameWithOwner': return repo.fullName;
    case 'description': return repo.description;
    case 'url': return `https://github.com/${repo.fullName}`;
    case 'owner': {
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('User', { login: repo.owner, id: VIEWER_ID }), field.selections);
    }
    case 'defaultBranchRef': {
      const tip = repo.tipOf(repo.defaultBranch);
      if (tip === undefined) return null;
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('Ref', { name: repo.defaultBranch }), field.selections);
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'issue': {
      const number = argValue(field, 'number', ctx.variables);
      const issue = typeof number === 'number' ? repo.issueByNumber.get(number) : undefined;
      if (issue === undefined) return null;
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('Issue', issue), field.selections);
    }
    case 'issues': {
      const first = argValue(field, 'first', ctx.variables);
      const after = argValue(field, 'after', ctx.variables);
      const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
      const orderBy = argValue(field, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
      let items = [...repo.issues];
      if (Array.isArray(states) && states.length > 0) {
        const want = new Set(states.map((s) => String(s).toUpperCase()));
        items = items.filter((i) => want.has(issueState(i)));
      }
      const direction = orderBy?.direction === 'ASC' ? 1 : -1;
      items.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
      const page = paginate(items, (i) => String(i.number), first, after);
      const connection = { nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor };
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('IssueConnection', connection), field.selections);
    }
    case 'pullRequest': {
      const number = argValue(field, 'number', ctx.variables);
      const pull = typeof number === 'number' ? repo.pulls.find((p) => p.number === number) : undefined;
      if (pull === undefined) return null;
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('PullRequest', pull), field.selections);
    }
    case 'pullRequests': {
      const first = argValue(field, 'first', ctx.variables);
      const after = argValue(field, 'after', ctx.variables);
      const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
      let items = [...repo.pulls];
      if (Array.isArray(states) && states.length > 0) {
        const want = new Set(states.map((s) => String(s).toUpperCase()));
        items = items.filter((p) => want.has(pullState(p)));
      }
      items.sort((a, b) => b.createdSeq - a.createdSeq);
      const page = paginate(items, (p) => String(p.number), first, after);
      const connection = { nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor };
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('PullRequestConnection', connection), field.selections);
    }
    case '__typename': return 'Repository';
    default:
      return errorField(ctx, node, field);
  }
}

function resolveIssueField(ctx: ExecutionContext, node: GqlValue, field: FieldNode): unknown {
  const issue = node.data as Issue;
  switch (field.name) {
    case 'id': return issue.id;
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'state': return issueState(issue);
    case 'body': return issue.body;
    case 'url': return '';
    case '__typename': return 'Issue';
    default:
      return errorField(ctx, node, field);
  }
}

function resolvePullRequestField(ctx: ExecutionContext, node: GqlValue, field: FieldNode): unknown {
  const pull = node.data as Pull;
  switch (field.name) {
    case 'id': return pull.id;
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'headRefName': return pull.head;
    case 'baseRefName': return pull.base;
    case 'mergeable': {
      // The repo is needed for the conflict check; recover it from the pull's global id.
      const found = ctx.store.findByGlobalId(pull.id);
      if (found === null || found.repo === undefined) return 'UNKNOWN';
      return found.repo.pullConflicts(pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'state': return pullState(pull);
    case 'merged': return pull.merged;
    case 'files': {
      const first = argValue(field, 'first', ctx.variables);
      const after = argValue(field, 'after', ctx.variables);
      const found = ctx.store.findByGlobalId(pull.id);
      const files = found !== null && found.repo !== undefined ? found.repo.pullFiles(pull) : [];
      const page = paginate(files, (f) => f.filename, first, after);
      const connection = {
        nodes: page.nodes.map((f) => ({ path: f.filename })),
        hasNextPage: page.hasNextPage,
        endCursor: page.endCursor,
      };
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('FileConnection', connection), field.selections);
    }
    case '__typename': return 'PullRequest';
    default:
      return errorField(ctx, node, field);
  }
}

function resolveConnectionField(ctx: ExecutionContext, node: GqlValue, field: FieldNode): unknown {
  const connection = node.data as { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null };
  switch (field.name) {
    case 'nodes': {
      if (field.selections === null) return connection.nodes;
      return connection.nodes.map((item) => {
        if (node.type === 'IssueConnection') return resolveSelections(ctx, new GqlValue('Issue', item as Issue), field.selections!);
        if (node.type === 'PullRequestConnection') return resolveSelections(ctx, new GqlValue('PullRequest', item as Pull), field.selections!);
        // FileConnection nodes are plain {path} objects.
        const file = item as { path: string };
        const out: Record<string, unknown> = {};
        for (const selection of field.selections!) {
          if (selection.kind === 'field' && selection.name === 'path') out[selection.alias ?? 'path'] = file.path;
          else if (selection.kind === 'field') out[selection.alias ?? selection.name] = null;
        }
        return out;
      });
    }
    case 'edges': {
      // Not requested by the suite, but cheap to support alongside nodes.
      if (field.selections === null) return [];
      return connection.nodes.map((item) => {
        const out: Record<string, unknown> = {};
        for (const selection of field.selections!) {
          if (selection.kind !== 'field') continue;
          if (selection.name === 'node') {
            if (node.type === 'IssueConnection') out[selection.alias ?? 'node'] = resolveSelections(ctx, new GqlValue('Issue', item as Issue), selection.selections ?? []);
            else if (node.type === 'PullRequestConnection') out[selection.alias ?? 'node'] = resolveSelections(ctx, new GqlValue('PullRequest', item as Pull), selection.selections ?? []);
            else out[selection.alias ?? 'node'] = item;
          } else if (selection.name === 'cursor') out[selection.alias ?? 'cursor'] = null;
        }
        return out;
      });
    }
    case 'pageInfo': {
      if (field.selections === null) return null;
      return resolveSelections(ctx, new GqlValue('PageInfo', { hasNextPage: connection.hasNextPage, endCursor: connection.endCursor }), field.selections);
    }
    case 'totalCount': return connection.nodes.length;
    case '__typename': return 'IssueConnection';
    default:
      return errorField(ctx, node, field);
  }
}

function resolveTypeField(ctx: ExecutionContext, node: GqlValue, field: FieldNode): unknown {
  const { name } = node.data as { name: string };
  switch (field.name) {
    case 'name': return name;
    case 'kind': return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
    case 'fields': {
      const names = TYPE_FIELDS[name] ?? [];
      if (field.selections === null) return null;
      return names.map((fieldName) => {
        const out: Record<string, unknown> = {};
        for (const selection of field.selections!) {
          if (selection.kind === 'field' && selection.name === 'name') out[selection.alias ?? 'name'] = fieldName;
          else if (selection.kind === 'field') out[selection.alias ?? selection.name] = null;
        }
        return out;
      });
    }
    case 'enumValues': {
      const values = ENUM_VALUES[name] ?? [];
      if (field.selections === null) return null;
      return values.map((value) => {
        const out: Record<string, unknown> = {};
        for (const selection of field.selections!) {
          if (selection.kind === 'field' && selection.name === 'name') out[selection.alias ?? 'name'] = value;
          else if (selection.kind === 'field') out[selection.alias ?? selection.name] = null;
        }
        return out;
      });
    }
    case 'description': return null;
    case '__typename': return '__Type';
    default:
      return errorField(ctx, node, field);
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function inputObject(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> | null {
  const input = argValue(field, 'input', variables);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function mutationPayload(ctx: ExecutionContext, field: FieldNode, payloadType: string, data: unknown, errorMessage: string | null): unknown {
  if (errorMessage !== null) {
    ctx.errors.push({ message: errorMessage });
    return null;
  }
  if (field.selections === null) return null;
  return resolveSelections(ctx, new GqlValue(payloadType, data), field.selections);
}

function resolveCreateIssue(ctx: ExecutionContext, field: FieldNode): unknown {
  const input = inputObject(field, ctx.variables);
  if (input === null) return mutationPayload(ctx, field, 'CreateIssuePayload', null, 'createIssue requires an input object.');
  const repositoryId = input['repositoryId'];
  const found = typeof repositoryId === 'string' ? ctx.store.findByGlobalId(repositoryId) : null;
  if (found === null || found.repo === undefined) return mutationPayload(ctx, field, 'CreateIssuePayload', null, 'Repository not found.');
  const title = typeof input['title'] === 'string' ? input['title'] : '';
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  const issue = found.repo.createIssue(title, body, []);
  return mutationPayload(ctx, field, 'CreateIssuePayload', issue, null);
}

function resolveCloseIssue(ctx: ExecutionContext, field: FieldNode): unknown {
  const input = inputObject(field, ctx.variables);
  if (input === null) return mutationPayload(ctx, field, 'CloseIssuePayload', null, 'closeIssue requires an input object.');
  const issueId = input['issueId'];
  const found = typeof issueId === 'string' ? ctx.store.findByGlobalId(issueId) : null;
  if (found === null || found.issue === undefined) return mutationPayload(ctx, field, 'CloseIssuePayload', null, 'Issue not found.');
  found.issue.state = 'closed';
  found.issue.cached = null;
  return mutationPayload(ctx, field, 'CloseIssuePayload', found.issue, null);
}

function resolveCreatePullRequest(ctx: ExecutionContext, field: FieldNode): unknown {
  const input = inputObject(field, ctx.variables);
  if (input === null) return mutationPayload(ctx, field, 'CreatePullRequestPayload', null, 'createPullRequest requires an input object.');
  const repositoryId = input['repositoryId'];
  const found = typeof repositoryId === 'string' ? ctx.store.findByGlobalId(repositoryId) : null;
  if (found === null || found.repo === undefined) return mutationPayload(ctx, field, 'CreatePullRequestPayload', null, 'Repository not found.');
  const base = typeof input['baseRefName'] === 'string' ? input['baseRefName'] : '';
  const head = typeof input['headRefName'] === 'string' ? input['headRefName'] : '';
  const title = typeof input['title'] === 'string' ? input['title'] : '';
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  const pull = found.repo.createPull(title, body, head, base);
  if (pull === null) return mutationPayload(ctx, field, 'CreatePullRequestPayload', null, 'Could not create pull request: check head and base branches.');
  return mutationPayload(ctx, field, 'CreatePullRequestPayload', pull, null);
}

function resolveMergePullRequest(ctx: ExecutionContext, field: FieldNode): unknown {
  const input = inputObject(field, ctx.variables);
  if (input === null) return mutationPayload(ctx, field, 'MergePullRequestPayload', null, 'mergePullRequest requires an input object.');
  const pullRequestId = input['pullRequestId'];
  const found = typeof pullRequestId === 'string' ? ctx.store.findByGlobalId(pullRequestId) : null;
  if (found === null || found.pull === undefined || found.repo === undefined) return mutationPayload(ctx, field, 'MergePullRequestPayload', null, 'Pull request not found.');
  const pull = found.pull;
  const result = found.repo.mergePull(pull);
  if ('conflict' in result) return mutationPayload(ctx, field, 'MergePullRequestPayload', pull, null);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = result.sha;
  return mutationPayload(ctx, field, 'MergePullRequestPayload', pull, null);
}

function resolveAddComment(ctx: ExecutionContext, field: FieldNode): unknown {
  const input = inputObject(field, ctx.variables);
  if (input === null) return mutationPayload(ctx, field, 'AddCommentPayload', null, 'addComment requires an input object.');
  const subjectId = input['subjectId'];
  const found = typeof subjectId === 'string' ? ctx.store.findByGlobalId(subjectId) : null;
  if (found === null || found.issue === undefined || found.repo === undefined) return mutationPayload(ctx, field, 'AddCommentPayload', null, 'Subject not found.');
  const body = typeof input['body'] === 'string' ? input['body'] : '';
  const comment = found.repo.addComment(found.issue.number, body);
  if (comment === null) return mutationPayload(ctx, field, 'AddCommentPayload', null, 'Could not add comment.');
  const nodeId = globalId('IssueComment', found.repo.owner, found.repo.name, found.issue.number, comment.id);
  return mutationPayload(ctx, field, 'AddCommentPayload', { id: nodeId, body: comment.body }, null);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOne(store: Store, request: GraphQLRequest): Record<string, unknown> {
  const errors: Array<{ message: string }> = [];
  if (typeof request.query !== 'string' || request.query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request must include a query string.' }] };
  }
  let variables: Record<string, unknown> = {};
  if (request.variables !== undefined && request.variables !== null) {
    if (typeof request.variables === 'object' && !Array.isArray(request.variables)) variables = request.variables as Record<string, unknown>;
    else if (typeof request.variables === 'string') {
      try {
        variables = JSON.parse(request.variables) as Record<string, unknown>;
      } catch {
        return { data: null, errors: [{ message: 'Variables are invalid JSON.' }] };
      }
    }
  }
  let document: DocumentNode;
  try {
    document = new Parser(lex(request.query)).parseDocument();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GraphQL syntax error';
    return { data: null, errors: [{ message }] };
  }
  let operation: OperationNode | undefined;
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  if (operationName !== null) operation = document.operations.find((op) => op.name === operationName);
  else operation = document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: operationName !== null ? `Unknown operation named "${operationName}".` : 'No operation provided.' }] };
  }
  // Apply variable defaults.
  for (const [name, defaultValue] of operation.variableDefinitions) {
    if (variables[name] === undefined && defaultValue !== undefined) variables[name] = resolveValue(defaultValue, variables);
  }
  const ctx: ExecutionContext = { store, variables, fragments: document.fragments, errors };
  const data = resolveSelections(ctx, null, operation.selections);
  const response: Record<string, unknown> = { data };
  if (errors.length > 0) response['errors'] = errors;
  return response;
}

/** Execute one GraphQL request body (single operation or a batched array). */
export function executeGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((item) => executeOne(store, item as GraphQLRequest));
  return executeOne(store, body as GraphQLRequest);
}
