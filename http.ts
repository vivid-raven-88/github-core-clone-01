// http.ts — a minimal HTTP/1.1 server on raw TCP, written for the forge's workload:
// thousands of small requests on one keep-alive connection, and 50 concurrent
// clone connections. node:http allocates an IncomingMessage, a ServerResponse, a
// Headers object and a URL per request; this parser allocates almost nothing:
// one small header object, one body view (usually the socket chunk itself), and
// the response goes out as a single write of head + body.
//
// The wire contract is deliberately narrow: HTTP/1.1 origin-form requests with
// Content-Length (or chunked) bodies, keep-alive by default. A request outside
// it gets a 400 JSON reply and a closed socket, the way node:http would refuse it.
//
// The handlers never touch sockets: they take a FastRequest and return a
// FastResponse, so the whole forge stays synchronous end to end.

import { createServer as createNetServer, type Server, type Socket } from 'node:net';

/** One parsed request: method, path, query string, headers, body. */
export interface FastRequest {
  method: string;
  /** Pathname with one trailing slash stripped (the v1 behaviour), still %-encoded. */
  path: string;
  /** Raw query string without the '?', or ''. */
  queryString: string;
  /** Lower-cased header names to values (first occurrence wins). */
  headers: Record<string, string>;
  /** The request body (a view into the socket buffer; consumed synchronously). */
  body: Buffer;
  /** Memoised query params, built on first use. */
  _q?: URLSearchParams | null;
}

/** One complete response: the handler's whole answer, written in one go. */
export interface FastResponse {
  status: number;
  body: Buffer;
  /** '' omits the header (the 204 case, which carries neither type nor length). */
  contentType: string;
  extra?: Record<string, string>;
}

export type FastHandler = (req: FastRequest) => FastResponse;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

function reasonOf(status: number): string {
  return REASONS[status] ?? 'OK';
}

/** The per-response id, same shape as v1's: a hex counter padded to 12. */
let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(12, '0');
}

/** The request's query params, parsed lazily (hot paths never ask). */
export function reqQuery(req: FastRequest): URLSearchParams {
  if (req._q === undefined) req._q = new URLSearchParams(req.queryString);
  return req._q;
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

type ParseOut =
  | { kind: 'ok'; req: FastRequest; consumed: number; keepAlive: boolean }
  | { kind: 'incomplete'; sendContinue: boolean }
  | { kind: 'error' };

/**
 * Parse one request out of `buf`. Returns 'incomplete' when more bytes are
 * needed (with `sendContinue` set when the headers are in and the client asked
 * for `100-continue`), 'error' when the bytes are not HTTP at all.
 */
function tryParseRequest(buf: Buffer): ParseOut {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > MAX_HEADER_BYTES) return { kind: 'error' };
    return { kind: 'incomplete', sendContinue: false };
  }
  const head = buf.subarray(0, headEnd).toString('latin1');
  const firstNl = head.indexOf('\r\n');
  const requestLine = firstNl < 0 ? head : head.slice(0, firstNl);
  const sp1 = requestLine.indexOf(' ');
  const sp2 = sp1 < 0 ? -1 : requestLine.indexOf(' ', sp1 + 1);
  if (sp1 <= 0 || sp2 <= sp1 + 1) return { kind: 'error' };
  const method = requestLine.slice(0, sp1);
  let target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') return { kind: 'error' };
  // Absolute-form target: strip scheme://authority, keep the path.
  if (target.startsWith('http://') || target.startsWith('https://')) {
    const slash = target.indexOf('/', target.indexOf('://') + 3);
    target = slash < 0 ? '/' : target.slice(slash);
  }
  if (!target.startsWith('/')) return { kind: 'error' };
  const hash = target.indexOf('#');
  if (hash >= 0) target = target.slice(0, hash);

  const headers: Record<string, string> = Object.create(null);
  let contentLength = 0;
  let chunked = false;
  let connection = '';
  let expectContinue = false;
  if (firstNl >= 0) {
    const lines = head.slice(firstNl + 2).split('\r\n');
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon <= 0) return { kind: 'error' };
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name in headers) {
        if (name === 'content-length' && headers[name] !== value) return { kind: 'error' };
        continue;
      }
      headers[name] = value;
      if (name === 'content-length') {
        if (!/^\d+$/.test(value)) return { kind: 'error' };
        contentLength = Number(value);
        if (!Number.isSafeInteger(contentLength)) return { kind: 'error' };
      } else if (name === 'transfer-encoding') {
        chunked = value.toLowerCase().includes('chunked');
      } else if (name === 'connection') {
        connection = value.toLowerCase();
      } else if (name === 'expect') {
        expectContinue = value.toLowerCase() === '100-continue';
      }
    }
  }

  const bodyStart = headEnd + 4;
  const finish = (body: Buffer, consumed: number): ParseOut => {
    const q = target.indexOf('?');
    let path = q < 0 ? target : target.slice(0, q);
    const queryString = q < 0 ? '' : target.slice(q + 1);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const keepAlive = version === 'HTTP/1.0' ? connection === 'keep-alive' : connection !== 'close';
    return { kind: 'ok', req: { method, path, queryString, headers, body }, consumed, keepAlive };
  };

  if (chunked) {
    // Chunked body: `size CRLF data CRLF ... 0 CRLF [trailers] CRLF`.
    let pos = bodyStart;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd < 0) return { kind: 'incomplete', sendContinue: expectContinue };
      const sizeLine = buf.subarray(pos, lineEnd).toString('ascii').trim();
      const semi = sizeLine.indexOf(';');
      const sizeText = semi < 0 ? sizeLine : sizeLine.slice(0, semi);
      if (!/^[0-9a-fA-F]+$/.test(sizeText)) return { kind: 'error' };
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isSafeInteger(size)) return { kind: 'error' };
      const dataStart = lineEnd + 2;
      if (size === 0) {
        if (buf.subarray(dataStart, dataStart + 2).toString('ascii') === '\r\n') {
          return finish(Buffer.concat(chunks, total), dataStart + 2);
        }
        const trailerEnd = buf.indexOf('\r\n\r\n', dataStart);
        if (trailerEnd < 0) return { kind: 'incomplete', sendContinue: false };
        return finish(Buffer.concat(chunks, total), trailerEnd + 4);
      }
      if (buf.length < dataStart + size + 2) return { kind: 'incomplete', sendContinue: expectContinue };
      if (buf[dataStart + size] !== 0x0d || buf[dataStart + size + 1] !== 0x0a) return { kind: 'error' };
      total += size;
      if (total > MAX_BODY_BYTES) return { kind: 'error' };
      chunks.push(buf.subarray(dataStart, dataStart + size));
      pos = dataStart + size + 2;
    }
  }

  if (contentLength > MAX_BODY_BYTES) return { kind: 'error' };
  if (buf.length < bodyStart + contentLength) return { kind: 'incomplete', sendContinue: expectContinue };
  return finish(buf.subarray(bodyStart, bodyStart + contentLength), bodyStart + contentLength);
}

function errorResponse(err: unknown): FastResponse {
  return {
    status: 500,
    body: Buffer.from(`${JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' })}\n`, 'utf8'),
    contentType: 'application/json',
  };
}

/**
 * Serialise one response: status line, Content-Type (unless ''), Content-Length
 * (never on 204), X-GitHub-Request-Id on every reply, then the body. Extra
 * header values are rejected if they carry a CRLF, the way node:http's
 * writeHead would refuse them — the caller then falls back to a plain 500.
 */
function buildPacket(res: FastResponse, keepAlive: boolean): Buffer {
  if (res.extra !== undefined) {
    for (const value of Object.values(res.extra)) {
      if (value.includes('\r') || value.includes('\n')) throw new Error('invalid header value');
    }
  }
  let head = `HTTP/1.1 ${res.status} ${reasonOf(res.status)}\r\n`;
  if (res.contentType !== '') head += `Content-Type: ${res.contentType}\r\n`;
  if (res.status !== 204) head += `Content-Length: ${res.body.length}\r\n`;
  head += `X-GitHub-Request-Id: ${nextRequestId()}\r\n`;
  if (res.extra !== undefined) {
    for (const [name, value] of Object.entries(res.extra)) head += `${name}: ${value}\r\n`;
  }
  head += `Connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, 'ascii'), res.body]);
}

const BAD_REQUEST_BODY = Buffer.from('{"message":"Bad Request"}\n', 'utf8');

function badRequestPacket(): Buffer {
  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${BAD_REQUEST_BODY.length}\r\nX-GitHub-Request-Id: ${nextRequestId()}\r\nConnection: close\r\n\r\n`,
      'ascii',
    ),
    BAD_REQUEST_BODY,
  ]);
}

/**
 * Create the listening server. The returned net.Server speaks the same
 * lifecycle as node:http's Server (listen / close / address / once('error')),
 * so the entry point does not change.
 */
export function createFastServer(handler: FastHandler): Server {
  const server = createNetServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buf: Buffer = EMPTY;
    let continueSent = false;

    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      buf = EMPTY;
    });

    const pump = (): void => {
      for (;;) {
        const parsed = tryParseRequest(buf);
        if (parsed.kind === 'incomplete') {
          if (parsed.sendContinue && !continueSent) {
            continueSent = true;
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          }
          return;
        }
        if (parsed.kind === 'error') {
          // Not HTTP at all: answer 400 the way the stack would, then close.
          socket.end(badRequestPacket());
          return;
        }
        buf = buf.subarray(parsed.consumed);
        continueSent = false;

        let res: FastResponse;
        try {
          res = handler(parsed.req);
        } catch (err) {
          res = errorResponse(err);
        }
        let packet: Buffer;
        try {
          packet = buildPacket(res, parsed.keepAlive);
        } catch {
          packet = buildPacket(errorResponse(new Error('invalid header value')), parsed.keepAlive);
        }
        if (!parsed.keepAlive) {
          socket.end(packet);
          return;
        }
        // Node calls the write callback with null (not undefined) on success.
        const flushed = socket.write(packet, (err?: Error | null) => {
          if (err) socket.destroy();
        });
        if (!flushed) {
          socket.pause();
          socket.once('drain', () => socket.resume());
        }
        // Loop: a pipelined request may already be buffered.
      }
    };
  });
  return server;
}
