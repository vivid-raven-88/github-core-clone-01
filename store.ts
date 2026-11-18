// store.ts — the forge's in-memory model: repositories, git objects and refs, issues, pull
// requests, labels and comments. Everything lives in memory; the trial is one process.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTree,
  peelToTarget,
  putObject,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The identity REST-created commits carry (fixed epoch base, one second per commit). */
const COMMIT_EPOCH_BASE = 1_735_689_600;

function identityAt(epoch: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join('/')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at < 0) return null;
    return { kind: text.slice(0, at), parts: text.slice(at + 1).split('/') };
  } catch {
    return null;
  }
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  id: string;
  /** Memoised GET-single-issue response body (see shapes.issueResponseBody). */
  cached: { baseUrl: string; body: Buffer } | null;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
  createdAt: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  id: string;
}

export class Repo {
  owner = VIEWER_LOGIN;
  name: string;
  description: string;
  privateFlag: boolean;
  defaultBranch = 'main';
  databaseId: number;
  id: string;
  createdSeq: number;
  createdAt: string;

  objects: Map<string, GitObject> = new Map();
  refs: Map<string, string> = new Map();
  issues: Issue[] = [];
  /** O(1) issue lookup by number; the array above keeps creation order for lists. */
  issueByNumber: Map<number, Issue> = new Map();
  /**
   * Monotonic generation: bumped on every mutation of refs or objects, so the
   * git advertisement / fetch caches in git.ts can tell a stale answer from a
   * fresh one. (Refs change only via commitFile, mergePull, receive-pack and
   * the two direct refs.set sites in app.ts — all bump it.)
   */
  version = 0;
  pulls: Pull[] = [];
  labels: Map<string, Label> = new Map();
  comments: Map<number, Comment[]> = new Map();
  private nextIssue = 1;
  private nextPull = 1;
  private nextComment = 1;
  private commitSeq = 0;

  constructor(name: string, description: string, privateFlag: boolean, databaseId: number, createdSeq: number) {
    this.name = name;
    this.description = description;
    this.privateFlag = privateFlag;
    this.databaseId = databaseId;
    this.createdSeq = createdSeq;
    this.createdAt = new Date().toISOString();
    this.id = globalId('Repository', VIEWER_LOGIN, name);
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  tipOf(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** The commit object at a ref name or a 40-hex sha (null when it does not resolve). */
  resolveCommit(ref: string): { oid: string; commit: ReturnType<typeof parseCommit> } | null {
    let oid: string | undefined;
    if (isObjectId(ref)) oid = ref;
    else oid = this.refs.get(`refs/heads/${ref}`);
    if (oid === undefined) return null;
    const object = this.objects.get(oid);
    if (object === undefined) return null;
    if (object.type === 'tag') {
      const target = peelToTarget(this, oid);
      const targetObject = this.objects.get(target);
      if (targetObject === undefined || targetObject.type !== 'commit') return null;
      oid = target;
      return { oid, commit: parseCommit(targetObject.data) };
    }
    if (object.type !== 'commit') return null;
    return { oid, commit: parseCommit(object.data) };
  }

  /** The tree oid at a commit (or null). */
  treeOfCommit(oid: string): string | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Walk a tree path to a blob oid (null when absent); `wantTree` returns a tree oid instead. */
  lookupPath(treeOid: string, segments: string[], wantTree = false): string | null {
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (entry === undefined) return null;
      const last = i === segments.length - 1;
      if (last) {
        if (wantTree) return entry.mode === '40000' ? entry.oid : null;
        return entry.mode === '40000' ? null : entry.oid;
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The tree entries at a path (a directory), or null when it is not a directory. */
  listDir(treeOid: string, segments: string[]): TreeEntry[] | null {
    let current = treeOid;
    for (const segment of segments) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const object = this.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /** Build a new tree by setting (or deleting) `path` in `baseTreeOid`; stores every new tree. */
  setPath(baseTreeOid: string | null, segments: string[], blobOid: string | null): string {
    if (segments.length === 0) return baseTreeOid ?? putObject(this, 'tree', buildTree([]));
    const head = segments[0]!;
    const rest = segments.slice(1);
    const baseEntries: TreeEntry[] = baseTreeOid === null ? [] : parseTree(this.objects.get(baseTreeOid)?.data ?? buildTree([]));
    const without = baseEntries.filter((e) => e.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) without.push({ mode: '100644', name: head, oid: blobOid });
      return putObject(this, 'tree', buildTree(without));
    }
    const existing = baseEntries.find((e) => e.name === head && e.mode === '40000');
    const childOid = this.setPath(existing === undefined ? null : existing.oid, rest, blobOid);
    // Prune an emptied directory.
    const childObject = this.objects.get(childOid);
    const childEntries = childObject === undefined ? [] : parseTree(childObject.data);
    if (childEntries.length === 0) return putObject(this, 'tree', buildTree(without));
    without.push({ mode: '40000', name: head, oid: childOid });
    return putObject(this, 'tree', buildTree(without));
  }

  /** Create a commit on `branch` that sets `path` to `content` (or deletes it). */
  commitFile(branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; contentSha: string | null } {
    const segments = path.split('/').filter((s) => s !== '');
    const tip = this.tipOf(branch);
    const parentTree = tip === undefined ? null : this.treeOfCommit(tip);
    let contentSha: string | null = null;
    let newTree: string;
    if (content === null) {
      newTree = this.setPath(parentTree, segments, null);
    } else {
      contentSha = putObject(this, 'blob', content);
      newTree = this.setPath(parentTree, segments, contentSha);
    }
    this.commitSeq += 1;
    const epoch = COMMIT_EPOCH_BASE + this.commitSeq;
    const who = identityAt(epoch);
    const commitData = buildCommit({
      tree: newTree,
      parents: tip === undefined ? [] : [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
    });
    const commitSha = putObject(this, 'commit', commitData);
    this.noteCommit(commitSha);
    this.refs.set(`refs/heads/${branch}`, commitSha);
    this.version += 1;
    return { commitSha, contentSha };
  }

  /** Commits reachable from `ref`, newest (creation order) first. */
  commitsOf(ref: string): Array<{ sha: string; commit: ReturnType<typeof parseCommit>; seq: number }> {
    const resolved = this.resolveCommit(ref);
    if (resolved === null) return [];
    // Creation order: commits are stored in insertion order in a side index.
    const reachable = collectReachable(this, [resolved.oid]);
    const out: Array<{ sha: string; commit: ReturnType<typeof parseCommit>; seq: number }> = [];
    for (const oid of reachable) {
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push({ sha: oid, commit: parseCommit(object.data), seq: this.commitOrder.get(oid) ?? 0 });
    }
    out.sort((a, b) => b.seq - a.seq);
    return out;
  }

  /** Insertion order of commits (for newest-first listing). */
  commitOrder: Map<string, number> = new Map();
  private commitCounter = 0;

  noteCommit(oid: string): void {
    if (!this.commitOrder.has(oid)) {
      this.commitCounter += 1;
      this.commitOrder.set(oid, this.commitCounter);
    }
  }

  /** The merge-base of two commits (the newest common ancestor), or null. */
  mergeBase(a: string, b: string): string | null {
    const fromA = collectReachable(this, [a]);
    // Walk b's ancestry newest-first; the first commit also reachable from a wins.
    const seen = new Set<string>();
    const queue: string[] = [b];
    const bySeq: Array<{ oid: string; seq: number }> = [];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      bySeq.push({ oid, seq: this.commitOrder.get(oid) ?? 0 });
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    bySeq.sort((x, y) => y.seq - x.seq);
    for (const entry of bySeq) if (fromA.has(entry.oid)) return entry.oid;
    return null;
  }

  /** The three-way diff between the merge-base tree and the head tree. */
  diffBaseToHead(baseOid: string, headOid: string): Array<{ path: string; baseBlob: string | null; headBlob: string | null }> {
    const base = this.mergeBase(baseOid, headOid);
    const baseTree = base === null ? null : this.treeOfCommit(base);
    const headTree = this.treeOfCommit(headOid);
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    const walk = (treeOid: string | null, prefix: string, into: Map<string, string>): void => {
      if (treeOid === null) return;
      const object = this.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path, into);
        else into.set(path, entry.oid);
      }
    };
    walk(baseTree, '', baseFiles);
    walk(headTree, '', headFiles);
    const out: Array<{ path: string; baseBlob: string | null; headBlob: string | null }> = [];
    const all = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...all].sort()) {
      const b = baseFiles.get(path) ?? null;
      const h = headFiles.get(path) ?? null;
      if (b !== h) out.push({ path, baseBlob: b, headBlob: h });
    }
    return out;
  }

  /** Line-count diff between two blobs (null = absent). */
  static lineDiff(baseBlob: string | null, headBlob: string | null, repo: Repo): { additions: number; deletions: number } {
    const read = (oid: string | null): string[] => {
      if (oid === null) return [];
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'blob') return [];
      const text = object.data.toString('utf8');
      if (text === '') return [];
      const lines = text.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const baseLines = read(baseBlob);
    const headLines = read(headBlob);
    const baseCount = new Map<string, number>();
    for (const line of baseLines) baseCount.set(line, (baseCount.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of headLines) {
      const left = baseCount.get(line) ?? 0;
      if (left > 0) baseCount.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of baseCount.values()) deletions += left;
    return { additions, deletions };
  }

  /** The files of a pull request (diff merge-base -> head), with line counts. */
  pullFiles(pull: Pull): PullFile[] {
    const headTip = this.tipOf(pull.head);
    const baseTip = this.tipOf(pull.base);
    if (headTip === undefined || baseTip === undefined) return [];
    const diffs = this.diffBaseToHead(baseTip, headTip);
    return diffs.map((d) => {
      const { additions, deletions } = Repo.lineDiff(d.baseBlob, d.headBlob, this);
      const status = d.baseBlob === null ? 'added' : d.headBlob === null ? 'removed' : 'modified';
      return { filename: d.path, status, additions, deletions, changes: additions + deletions };
    });
  }

  /** Whether merging `pull` would conflict (a file changed on both sides, differently). */
  pullConflicts(pull: Pull): boolean {
    const headTip = this.tipOf(pull.head);
    const baseTip = this.tipOf(pull.base);
    if (headTip === undefined || baseTip === undefined) return true;
    const base = this.mergeBase(baseTip, headTip);
    if (base === null) return headTip !== baseTip;
    const baseTree = this.treeOfCommit(base);
    const headTree = this.treeOfCommit(headTip);
    const baseTipTree = this.treeOfCommit(baseTip);
    const read = (treeOid: string | null): Map<string, string> => {
      const out = new Map<string, string>();
      const walk = (oid: string | null, prefix: string): void => {
        if (oid === null) return;
        const object = this.objects.get(oid);
        if (object === undefined || object.type !== 'tree') return;
        for (const entry of parseTree(object.data)) {
          const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          if (entry.mode === '40000') walk(entry.oid, path);
          else out.set(path, entry.oid);
        }
      };
      walk(treeOid, '');
      return out;
    };
    const mergedBase = read(baseTree);
    const headFiles = read(headTree);
    const baseTipFiles = read(baseTipTree);
    const all = new Set([...headFiles.keys(), ...baseTipFiles.keys()]);
    for (const path of all) {
      const b = mergedBase.get(path) ?? null;
      const h = headFiles.get(path) ?? null;
      const t = baseTipFiles.get(path) ?? null;
      const headChanged = h !== b;
      const baseChanged = t !== b;
      if (headChanged && baseChanged && h !== t) return true;
    }
    return false;
  }

  /** Squash-merge `pull`: a 3-way merge of head into base, on the base branch. */
  mergePull(pull: Pull): { sha: string } | { conflict: true } {
    const headTip = this.tipOf(pull.head);
    const baseTip = this.tipOf(pull.base);
    if (headTip === undefined || baseTip === undefined) return { conflict: true };
    if (this.pullConflicts(pull)) return { conflict: true };
    const base = this.mergeBase(baseTip, headTip);
    const baseTree = base === null ? null : this.treeOfCommit(base);
    const headTree = this.treeOfCommit(headTip);
    const baseTipTree = this.treeOfCommit(baseTip);
    const read = (treeOid: string | null): Map<string, string> => {
      const out = new Map<string, string>();
      const walk = (oid: string | null, prefix: string): void => {
        if (oid === null) return;
        const object = this.objects.get(oid);
        if (object === undefined || object.type !== 'tree') return;
        for (const entry of parseTree(object.data)) {
          const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
          if (entry.mode === '40000') walk(entry.oid, path);
          else out.set(path, entry.oid);
        }
      };
      walk(treeOid, '');
      return out;
    };
    const mergedBase = read(baseTree);
    const headFiles = read(headTree);
    const baseTipFiles = read(baseTipTree);
    // Merged tree: start from the base tip's files, apply the PR's changes.
    const merged = new Map(baseTipFiles);
    const all = new Set([...headFiles.keys(), ...mergedBase.keys()]);
    for (const path of all) {
      const b = mergedBase.get(path) ?? null;
      const h = headFiles.get(path) ?? null;
      if (h === b) continue; // the PR did not touch it
      if (h === null) merged.delete(path);
      else merged.set(path, h);
    }
    // Rebuild the tree from the flat file map.
    const buildFromFlat = (files: Map<string, string>): string => {
      const byDir = new Map<string, Array<{ name: string; oid: string }>>();
      const dirs = new Set<string>();
      for (const [path, oid] of files) {
        const slash = path.lastIndexOf('/');
        const dir = slash < 0 ? '' : path.slice(0, slash);
        const name = slash < 0 ? path : path.slice(slash + 1);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir)!.push({ name, oid });
        let d = dir;
        while (d !== '') {
          dirs.add(d);
          const s = d.lastIndexOf('/');
          d = s < 0 ? '' : d.slice(0, s);
        }
      }
      const buildDir = (dir: string): string => {
        const entries: TreeEntry[] = [];
        for (const file of byDir.get(dir) ?? []) entries.push({ mode: '100644', name: file.name, oid: file.oid });
        const subdirs = new Set<string>();
        for (const d of dirs) {
          const slash = d.lastIndexOf('/');
          const parent = slash < 0 ? '' : d.slice(0, slash);
          if (parent === dir) subdirs.add(d.slice(slash + 1));
        }
        for (const sub of subdirs) {
          const subPath = dir === '' ? sub : `${dir}/${sub}`;
          entries.push({ mode: '40000', name: sub, oid: buildDir(subPath) });
        }
        return putObject(this, 'tree', buildTree(entries));
      };
      return buildDir('');
    };
    const mergedTree = buildFromFlat(merged);
    this.commitSeq += 1;
    const epoch = COMMIT_EPOCH_BASE + this.commitSeq;
    const who = identityAt(epoch);
    const message = `Merge pull request #${pull.number} from ${pull.head}\n`;
    const commitData = buildCommit({
      tree: mergedTree,
      parents: [baseTip],
      message,
      author: who,
      committer: who,
    });
    const sha = putObject(this, 'commit', commitData);
    this.noteCommit(sha);
    this.refs.set(`refs/heads/${pull.base}`, sha);
    this.version += 1;
    return { sha };
  }

  createIssue(title: string, body: string, labels: string[]): Issue {
    const number = this.nextIssue++;
    const issue: Issue = {
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: number,
      createdAt: new Date().toISOString(),
      id: globalId('Issue', this.owner, this.name, number),
      cached: null,
    };
    this.issues.push(issue);
    this.issueByNumber.set(number, issue);
    return issue;
  }

  createPull(title: string, body: string, head: string, base: string): Pull | null {
    if (this.tipOf(head) === undefined || this.tipOf(base) === undefined) return null;
    if (this.pulls.some((p) => p.state === 'open' && p.head === head && p.base === base)) return null;
    const number = this.nextPull++;
    const pull: Pull = {
      number,
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: number,
      createdAt: new Date().toISOString(),
      id: globalId('PullRequest', this.owner, this.name, number),
    };
    this.pulls.push(pull);
    return pull;
  }

  addComment(issueNumber: number, body: string): Comment | null {
    const issue = this.issueByNumber.get(issueNumber);
    if (issue === undefined) return null;
    const comment: Comment = { id: this.nextComment++, body, createdSeq: Date.now(), createdAt: new Date().toISOString() };
    const list = this.comments.get(issueNumber) ?? [];
    list.push(comment);
    this.comments.set(issueNumber, list);
    issue.cached = null;
    return comment;
  }
}

export class Store {
  repos: Map<string, Repo> = new Map();
  private nextDatabaseId = 1;
  private createdCounter = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, privateFlag: boolean): Repo | null {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return null;
    this.createdCounter += 1;
    const repo = new Repo(name, description, privateFlag, this.nextDatabaseId++, this.createdCounter);
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  findByGlobalId(id: string): { kind: string; repo?: Repo; issue?: Issue; pull?: Pull; comment?: Comment } | null {
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository' && decoded.parts.length >= 2) {
      const repo = this.getRepo(decoded.parts[0]!, decoded.parts[1]!);
      return repo === undefined ? null : { kind: 'Repository', repo };
    }
    if (decoded.kind === 'Issue' && decoded.parts.length >= 3) {
      const repo = this.getRepo(decoded.parts[0]!, decoded.parts[1]!);
      if (repo === undefined) return null;
      const issue = repo.issueByNumber.get(Number(decoded.parts[2]));
      return issue === undefined ? null : { kind: 'Issue', repo, issue };
    }
    if (decoded.kind === 'PullRequest' && decoded.parts.length >= 3) {
      const repo = this.getRepo(decoded.parts[0]!, decoded.parts[1]!);
      if (repo === undefined) return null;
      const pull = repo.pulls.find((p) => p.number === Number(decoded.parts[2]));
      return pull === undefined ? null : { kind: 'PullRequest', repo, pull };
    }
    return null;
  }

  /** Every commit object stored anywhere, for noteCommit bookkeeping on receive-pack. */
  noteNewCommits(repo: Repo, oids: Iterable<string>): void {
    for (const oid of oids) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') repo.noteCommit(oid);
    }
  }
}

export { hashObject, isAncestor };
