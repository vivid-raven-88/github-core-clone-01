// git.ts — git objects, packfiles, pkt-lines and the smart-HTTP protocol (v2 upload-pack,
// v0 receive-pack), implemented from scratch on node:zlib and node:crypto. No git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** The minimal repository surface the protocol handlers need (satisfied by the store's Repo). */
export interface GitRepo {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  defaultBranch: string;
  /** Generation counter, bumped on every refs/objects mutation (store.ts, app.ts, below). */
  version: number;
}

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonResult(status: number, body: unknown): HttpResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

export function notFoundResult(): HttpResult {
  return jsonResult(404, { message: 'Not Found' });
}

export function badRequestResult(message: string): HttpResult {
  return jsonResult(400, { message });
}

// ---------------------------------------------------------------- object hashing

function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

export function putObject(repo: GitRepo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  count: number;
}

/** Read one delta varint (7 bits per byte, low group first, high bit = continue). */
function readDeltaVarint(data: Buffer, pos: { i: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (pos.i >= data.length) throw new Error('truncated delta varint');
    const byte = data[pos.i++]!;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return value;
}

/** Apply a git delta to a base object, yielding the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const pos = { i: 0 };
  const sourceSize = readDeltaVarint(delta, pos);
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} does not match base length ${base.length}`);
  const targetSize = readDeltaVarint(delta, pos);
  const out: Buffer[] = [];
  let written = 0;
  while (pos.i < delta.length) {
    const opcode = delta[pos.i++]!;
    if (opcode & 0x80) {
      // Copy from the base: up to 4 offset bytes, then up to 3 size bytes.
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          if (pos.i >= delta.length) throw new Error('truncated delta copy instruction');
          offset |= delta[pos.i++]! << (8 * bit);
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          if (pos.i >= delta.length) throw new Error('truncated delta copy instruction');
          size |= delta[pos.i++]! << (8 * bit);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy escapes its base object');
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (opcode !== 0) {
      // Insert literal bytes.
      if (pos.i + opcode > delta.length) throw new Error('truncated delta insert instruction');
      out.push(delta.subarray(pos.i, pos.i + opcode));
      pos.i += opcode;
      written += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== targetSize) throw new Error(`delta produces ${written} bytes, expected ${targetSize}`);
  return Buffer.concat(out);
}

export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 32) throw new Error('packfile too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('packfile has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`packfile version ${version} is not 2 or 3`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer SHA-1 over the preceding bytes.
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (actual !== expected) throw new Error('packfile trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  interface Entry {
    offset: number;
    type?: GitObjectType;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
  }
  const entries: Entry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= pack.length - 20) throw new Error('packfile ends before its declared entries');
    const entryOffset = offset;
    // Varint header: first byte holds type (bits 4..6) and size low 4 bits.
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    // One inflate pass: inflateSync with { info: true } reports how many input
    // bytes the stream consumed (engine.bytesWritten), so the next object's
    // offset is known without a second search. (The old code binary-searched
    // the deflated length with ~11 inflateSync calls per object — the push
    // workload's biggest single cost, ~33 wasted inflations per pack.)
    const inflateEntry = (): Buffer => {
      const tail = pack.subarray(offset, pack.length - 20);
      const { buffer, engine } = inflateSync(tail, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      if (buffer.length !== size) throw new Error(`packfile object inflates to ${buffer.length} bytes, expected ${size}`);
      offset += engine.bytesWritten;
      return buffer;
    };
    if (typeCode === 6) {
      // OFS_DELTA: the base is at entryOffset minus an offset varint.
      if (offset >= pack.length - 20) throw new Error('truncated OFS_DELTA offset');
      let next = pack[offset++]!;
      let baseOffset = next & 0x7f;
      while (next & 0x80) {
        if (offset >= pack.length - 20) throw new Error('truncated OFS_DELTA offset');
        next = pack[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (next & 0x7f);
      }
      const deltaData = inflateEntry();
      entries.push({ offset: entryOffset, data: deltaData, baseOffset: entryOffset - baseOffset });
    } else if (typeCode === 7) {
      // REF_DELTA: the base is named by a 20-byte object id.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const deltaData = inflateEntry();
      entries.push({ offset: entryOffset, data: deltaData, baseOid });
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`packfile object type ${typeCode} is unknown`);
      const data = inflateEntry();
      const oid = hashObject(type, data);
      objects.set(oid, { type, data });
      entries.push({ offset: entryOffset, type, data });
    }
  }
  // Resolve deltas. A delta's base may be another delta in the same pack (resolved in
  // a later pass), or an object the store already holds (REF_DELTA via `lookup`).
  const resolved = new Map<number, GitObject>();
  for (const entry of entries) {
    if (entry.type !== undefined) resolved.set(entry.offset, { type: entry.type, data: entry.data });
  }
  let remaining = entries.filter((entry) => entry.type === undefined);
  for (let guard = 0; remaining.length > 0 && guard <= entries.length + 1; guard += 1) {
    let progressed = false;
    const still: Entry[] = [];
    for (const entry of remaining) {
      let base: GitObject | undefined;
      if (entry.baseOid !== undefined) base = objects.get(entry.baseOid) ?? lookup?.(entry.baseOid);
      else if (entry.baseOffset !== undefined) base = resolved.get(entry.baseOffset);
      if (base === undefined) {
        still.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.data);
      const object: GitObject = { type: base.type, data };
      const oid = hashObject(object.type, object.data);
      objects.set(oid, object);
      resolved.set(entry.offset, object);
      progressed = true;
    }
    remaining = still;
    if (!progressed) throw new Error('delta base not found in the pack or the store');
  }
  if (remaining.length > 0) throw new Error('delta base not found in the pack or the store');
  return { objects, count };
}

// ---------------------------------------------------------------- pkt-lines

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.allocUnsafe(4);
  header.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

export const pktFlush: Buffer = Buffer.from('0000', 'ascii');
export const pktDelim: Buffer = Buffer.from('0001', 'ascii');

export function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush);
    else if (item === 'delim') parts.push(pktDelim);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from `buf`. Returns the packets and the offset just past the last complete
 * packet; `rest` is everything after that offset (the raw pack in a receive-pack body).
 * Throws on a malformed or truncated header.
 */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) break; // raw trailing bytes (a pack) follow
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error(`pkt-line length ${length} is invalid`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset + 4 > buf.length && offset < buf.length) throw new Error('truncated pkt-line header');
  return { packets, consumed: offset };
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target, tree -> entries). */
export function collectReachable(repo: GitRepo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `oid` following parents (tags are peeled first). */
export function isAncestor(repo: GitRepo, oid: string, ancestor: string): boolean {
  if (oid === ancestor) return true;
  const seen = new Set<string>();
  const queue: string[] = [oid];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** Peel a tag (or tag chain) to its ultimate target object id. */
export function peelToTarget(repo: GitRepo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Objects the client already holds: the closure of its haves, except that
 * parent traversal stops at the client's own shallow boundaries (a shallow
 * client holds a boundary commit's tree and blobs, but not its parents). */
export function collectHeld(repo: GitRepo, haves: readonly string[], clientShallow: readonly string[]): Set<string> {
  const shallowSet = new Set(clientShallow);
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of haves) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------- fetch computation

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

export function computeFetch(repo: GitRepo, wants: readonly string[], haves: readonly string[], clientShallow: readonly string[], depth: number | null): FetchPlan {
  const haveSet = new Set(haves);
  // Resolve tag wants to their targets (the tag object itself is also sent).
  const tagObjects: string[] = [];
  const commitWants: string[] = [];
  const otherWants: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push(want);
      const target = peelToTarget(repo, want);
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') commitWants.push(target);
      else if (targetObject !== undefined) otherWants.push(target);
    } else if (object.type === 'commit') {
      commitWants.push(want);
    } else {
      otherWants.push(want);
    }
  }
  // BFS over commits from the wants, honouring haves and the depth limit.
  // Held commits are traversed through (their parents may be wanted when the
  // depth extends past them, e.g. deepen) but never sent.
  const sentCommits = new Set<string>();
  const dist = new Map<string, number>();
  const visited = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = commitWants.map((oid) => ({ oid, d: 0 }));
  let head = 0;
  while (head < queue.length) {
    const { oid, d } = queue[head++]!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (!haveSet.has(oid)) {
      sentCommits.add(oid);
      dist.set(oid, d);
    }
    if (depth === null || d + 1 < depth) {
      for (const parent of parseCommit(object.data).parents) {
        if (!visited.has(parent)) queue.push({ oid: parent, d: d + 1 });
      }
    }
  }
  // Shallow boundaries: included commits at the depth cutoff whose parents exist.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of sentCommits) {
      if (dist.get(oid) !== depth - 1) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (sentCommits.has(boundary)) unshallow.push(boundary);
  }
  // Object set: tags, sent commits, their trees and blobs.
  const oids = new Set<string>();
  for (const tag of tagObjects) oids.add(tag);
  for (const oid of otherWants) oids.add(oid);
  for (const oid of sentCommits) oids.add(oid);
  const treeQueue: string[] = [];
  for (const oid of sentCommits) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') treeQueue.push(parseCommit(object.data).tree);
  }
  for (const oid of otherWants) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tree') treeQueue.push(oid);
  }
  while (treeQueue.length) {
    const oid = treeQueue.pop()!;
    if (oids.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    oids.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') treeQueue.push(entry.oid);
        else oids.add(entry.oid);
      }
    }
  }
  // Never re-send what the client already holds (its haves' closure, cut at
  // its own shallow boundaries): an incremental fetch sends only new objects.
  const held = haves.length === 0 ? null : collectHeld(repo, haves, clientShallow);
  const objects: GitObject[] = [];
  for (const oid of oids) {
    if (held !== null && held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------- advertisements

/** Per-repo memo of the responses that only depend on the repo's git state.
 * A cached HttpResult's body Buffer is shared across replies; the transport
 * only ever reads it, so sharing is safe. The whole cache is dropped whenever
 * the repo's version generation moves (a push, a contents write, a merge, a
 * ref create) — content-addressed objects make a same-version answer exact. */
interface RepoGitCache {
  version: number;
  adV0Upload: HttpResult | null;
  adReceive: HttpResult | null;
  lsRefs: { key: string; result: HttpResult } | null;
  fetch: Map<string, HttpResult>;
}

const gitCaches = new WeakMap<GitRepo, RepoGitCache>();

function gitCache(repo: GitRepo): RepoGitCache {
  let cache = gitCaches.get(repo);
  if (cache === undefined || cache.version !== repo.version) {
    cache = { version: repo.version, adV0Upload: null, adReceive: null, lsRefs: null, fetch: new Map() };
    gitCaches.set(repo, cache);
  }
  return cache;
}

const AGENT = 'github-core-clone-01/1.0.0';
const UPLOAD_V2_CAPS = [
  'agent=' + AGENT,
  'ls-refs=unborn',
  'fetch=shallow thin-pack ofs-delta filter',
  'object-format=sha1',
];
const RECEIVE_CAPS = `report-status side-band-64k delete-refs agent=${AGENT}`;

/** The v2 advertisement, built once: capability list only, no refs. */
const V2_AD_BODY: Buffer = encodePktLines(['version 2\n', ...UPLOAD_V2_CAPS.map((cap) => `${cap}\n`), 'flush']);

function sortedRefs(repo: GitRepo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function refLines(repo: GitRepo): string[] {
  const lines: string[] = [];
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (main !== undefined) {
    lines.push(`${main} HEAD\0symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`);
  }
  for (const ref of sortedRefs(repo)) {
    lines.push(`${ref.oid} ${ref.name}`);
    if (ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        lines.push(`${peelToTarget(repo, ref.oid)} ${ref.name}^{}`);
      }
    }
  }
  return lines;
}

export function advertiseUploadPack(repo: GitRepo, gitProtocolVersion2: boolean): HttpResult {
  const contentType = 'application/x-git-upload-pack-advertisement';
  if (gitProtocolVersion2) {
    // The v2 advertisement never changes: capability list only, no refs.
    return { status: 200, contentType, body: V2_AD_BODY };
  }
  const cache = gitCache(repo);
  if (cache.adV0Upload !== null) return cache.adV0Upload;
  const lines = refLines(repo);
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush];
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not filter agent=${AGENT}\n`));
  } else {
    const first = lines[0]!;
    const rest = lines.slice(1);
    const caps = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not filter agent=${AGENT}`;
    // The first line carries the capabilities after a NUL; HEAD (with its symref) is first.
    const headIndex = lines.findIndex((line) => line.includes(' HEAD\0'));
    if (headIndex >= 0) {
      const headLine = lines[headIndex]!;
      const nul = headLine.indexOf('\0');
      const before = headLine.slice(0, nul + 1);
      const afterCaps = headLine.slice(nul + 1);
      parts.push(pktLine(`${before}${afterCaps} ${caps}\n`));
      for (const line of [...lines.slice(0, headIndex), ...lines.slice(headIndex + 1)]) {
        parts.push(pktLine(`${line}\n`));
      }
    } else {
      parts.push(pktLine(`${first}\0${caps}\n`));
      for (const line of rest) parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush);
  const uploadResult: HttpResult = { status: 200, contentType, body: Buffer.concat(parts) };
  cache.adV0Upload = uploadResult;
  return uploadResult;
}

export function advertiseReceivePack(repo: GitRepo): HttpResult {
  const contentType = 'application/x-git-receive-pack-advertisement';
  const cache = gitCache(repo);
  if (cache.adReceive !== null) return cache.adReceive;
  const lines = refLines(repo);
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush];
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    const headIndex = lines.findIndex((line) => line.includes(' HEAD\0'));
    if (headIndex >= 0) {
      const headLine = lines[headIndex]!;
      const nul = headLine.indexOf('\0');
      parts.push(pktLine(`${headLine.slice(0, nul + 1)}${headLine.slice(nul + 1)} ${RECEIVE_CAPS}\n`));
      for (const line of [...lines.slice(0, headIndex), ...lines.slice(headIndex + 1)]) {
        parts.push(pktLine(`${line}\n`));
      }
    } else {
      parts.push(pktLine(`${lines[0]!}\0${RECEIVE_CAPS}\n`));
      for (const line of lines.slice(1)) parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush);
  const receiveResult: HttpResult = { status: 200, contentType, body: Buffer.concat(parts) };
  cache.adReceive = receiveResult;
  return receiveResult;
}

// ---------------------------------------------------------------- upload-pack (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

export function handleLsRefs(repo: GitRepo, args: LsRefsArgs): HttpResult {
  const cache = gitCache(repo);
  const key = `${args.peel ? 1 : 0}${args.symrefs ? 1 : 0}${args.unborn ? 1 : 0}|${args.prefixes.join(',')}`;
  const hit = cache.lsRefs;
  if (hit !== null && hit.key === key) return hit.result;
  const out: string[] = [];
  const hasRefs = repo.refs.size > 0;
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const include = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (!hasRefs) {
    if (args.unborn) out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  } else {
    if (include('HEAD') && main !== undefined) out.push(`${main} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    for (const ref of sortedRefs(repo)) {
      if (!include(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object !== undefined && object.type === 'tag') line += ` peeled:${peelToTarget(repo, ref.oid)}`;
      }
      out.push(line);
    }
  }
  const parts: Buffer[] = out.map((line) => pktLine(`${line}\n`));
  parts.push(pktFlush);
  const lsResult: HttpResult = { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  cache.lsRefs = { key, result: lsResult };
  return lsResult;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8));
    else if (line === 'done') args.done = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

const SIDEBAND_CHUNK = 65515; // 1 band byte + 65515 data bytes = a 65520-byte pkt-line

function storeFetch(cache: RepoGitCache, key: string, result: HttpResult): HttpResult {
  if (cache.fetch.size >= 64) {
    const oldest = cache.fetch.keys().next().value;
    if (oldest !== undefined) cache.fetch.delete(oldest);
  }
  cache.fetch.set(key, result);
  return result;
}

export function handleFetch(repo: GitRepo, args: FetchArgs): HttpResult {
  // One cache entry per (wants, haves, shallow, depth, done): the bench's 50
  // concurrent clones all ask for the same tip at depth 1, so one build
  // serves all of them. Same-version + same-args is exact — the closure of a
  // content-addressed object set cannot change without the version moving.
  const cache = gitCache(repo);
  const key = `${args.done ? 1 : 0}|${args.depth ?? ''}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}`;
  const hit = cache.fetch.get(key);
  if (hit !== undefined) return hit;
  const plan = computeFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects);
  // Protocol v2 negotiation (fetch-pack.c do_fetch_pack_v2):
  //  - a request WITHOUT "done" is a negotiation round: answer with ONLY the
  //    acknowledgments section, flush-terminated; the client then sends another
  //    request (more haves, or "done"). No packfile is sent in this round.
  //  - a request WITH "done" is finished negotiating: answer with no
  //    acknowledgments section at all — shallow-info (only when non-empty),
  //    then the packfile section, then flush.
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of args.haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    parts.push(pktFlush);
    return storeFetch(cache, key, { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) });
  }
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim);
  }
  // packfile (sideband)
  parts.push(pktLine('packfile\n'));
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    const frame = Buffer.allocUnsafe(chunk.length + 1);
    frame[0] = 1;
    chunk.copy(frame, 1);
    parts.push(pktLine(frame));
  }
  parts.push(pktFlush);
  return storeFetch(cache, key, { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) });
}

/** POST /{owner}/{repo}.git/git-upload-pack — a v2 command request (ls-refs or fetch). */
export function handleUploadPack(repo: GitRepo, body: Buffer): HttpResult {
  let parsed;
  try {
    parsed = decodePktLines(body);
  } catch (err) {
    return badRequestResult(err instanceof Error ? err.message : 'malformed pkt-line stream');
  }
  const lines: string[] = [];
  let command = '';
  let seenDelim = false;
  for (const packet of parsed.packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!seenDelim && command === '' && text.startsWith('command=')) {
      command = text.slice('command='.length).trim();
      continue;
    }
    if (seenDelim) lines.push(text.replace(/\n$/, ''));
    else if (text.startsWith('agent=') || text.startsWith('object-format=')) continue;
    else lines.push(text.replace(/\n$/, ''));
  }
  if (command === 'ls-refs') return handleLsRefs(repo, parseLsRefsArgs(lines));
  if (command === 'fetch') return handleFetch(repo, parseFetchArgs(lines));
  return badRequestResult(`unknown upload-pack command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------- receive-pack (v0)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack — a v0 command list followed by a raw pack. */
export function handleReceivePack(repo: GitRepo, body: Buffer): HttpResult {
  let parsed;
  try {
    parsed = decodePktLines(body);
  } catch (err) {
    return badRequestResult(err instanceof Error ? err.message : 'malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let flushIndex = -1;
  for (let i = 0; i < parsed.packets.length; i += 1) {
    const packet = parsed.packets[i]!;
    if (packet.kind === 'flush') {
      flushIndex = i;
      break;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    let line = text;
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      line = text.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) return badRequestResult('malformed push command line');
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) return badRequestResult('push with no commands');
  // The pack follows the command list's flush packet.
  let packBytes: Buffer = Buffer.alloc(0);
  if (flushIndex >= 0) {
    // consumed covers everything up to the flush packet's end.
    let consumed = 0;
    for (let i = 0; i <= flushIndex; i += 1) {
      const packet = parsed.packets[i]!;
      consumed += packet.kind === 'flush' ? 4 : packet.kind === 'delim' ? 4 : packet.payload.length + 4;
    }
    packBytes = body.subarray(consumed);
  }
  const wantsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      // A thin pack may delta against objects the server already holds.
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (wantsPack) {
    // An update with no pack at all cannot carry its objects; refuse the unpack.
    unpackOk = false;
    unpackDetail = 'no packfile received';
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    let ok = true;
    let reason = '';
    if (!cmd.ref.startsWith('refs/')) {
      ok = false;
      reason = 'invalid ref name';
    } else if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        ok = false;
        reason = 'ref does not exist';
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        ok = false;
        reason = 'old value does not match';
      }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        ok = false;
        reason = 'already exists';
      } else if (!repo.objects.has(cmd.newOid)) {
        ok = false;
        reason = 'object not found';
      }
    } else {
      // Update.
      if (current === undefined) {
        ok = false;
        reason = 'ref does not exist';
      } else if (current !== cmd.oldOid) {
        ok = false;
        reason = 'old value does not match';
      } else if (!repo.objects.has(cmd.newOid)) {
        ok = false;
        reason = 'object not found';
      } else if (cmd.ref.startsWith('refs/tags/')) {
        if (cmd.newOid !== cmd.oldOid) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (!isAncestor(repo, cmd.newOid, current)) {
        ok = false;
        reason = 'non-fast-forward';
      }
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
    }
    results.push({ ref: cmd.ref, ok, reason });
  }
  // Anything a successful unpack stored, or any ref a command moved, changes
  // the git state the advertisement/fetch caches are keyed on.
  if (unpackOk) repo.version += 1;
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = encodePktLines([...reportLines, 'flush']);
  const parts: Buffer[] = [];
  if (sideband) {
    // The report stream is itself pkt-lined inside band-1 sideband frames.
    let offset = 0;
    while (offset < inner.length) {
      const chunk = inner.subarray(offset, Math.min(inner.length, offset + SIDEBAND_CHUNK));
      const frame = Buffer.allocUnsafe(chunk.length + 1);
      frame[0] = 1;
      chunk.copy(frame, 1);
      parts.push(pktLine(frame));
      offset += chunk.length;
    }
  } else {
    parts.push(inner);
  }
  parts.push(pktFlush);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}
