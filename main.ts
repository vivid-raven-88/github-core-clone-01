// Entry point for the github-core-clone-01 forge.
//
// This file owns exactly two things: starting the forge server on a
// kernel-assigned port, and the harness lifecycle around it — register
// that port with the environment, then wait until the environment says
// the run is over. Everything the forge actually does (git smart HTTP,
// REST v3, GraphQL v4, MCP) lives in app.ts and its helpers.
//
// v2: the forge speaks HTTP/1.1 on raw TCP (http.ts) instead of node:http —
// one less allocation-heavy layer on the timed paths — while this lifecycle
// is unchanged.
//
// Node 22, standard library only.

import { createApp } from "./app.ts";

// How long to sleep between "are we done yet?" checks, in milliseconds.
const POLL_DELAY_MS = 500;

// The harness hands us its base URL through the environment.
const envBase = process.env.MAKEFUN_ENV_URL;

/** Join a base URL and a path without producing a double slash. */
function joinUrl(base: string, path: string): string {
  return base.endsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/** Wait roughly `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tell the harness which port the forge is listening on.
 * Returns true when the harness accepted the registration.
 */
async function registerPort(base: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(joinUrl(base, "register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    });
    if (!response.ok) {
      console.error(`register failed: HTTP ${response.status}`);
      return false;
    }
    // Drain the body so the connection can close cleanly.
    await response.text();
    return true;
  } catch (error) {
    console.error(`register failed: ${String(error)}`);
    return false;
  }
}

/**
 * Ask the harness whether the run is finished.
 * Any transport hiccup or unparsable answer counts as "not yet"
 * — the loop simply asks again on the next round.
 */
async function isDone(base: string): Promise<boolean> {
  try {
    const response = await fetch(joinUrl(base, "done"));
    if (!response.ok) return false;
    const payload = (await response.json()) as unknown;
    return (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { done?: unknown }).done === true
    );
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  if (!envBase) {
    console.error("MAKEFUN_ENV_URL is not set");
    return 1;
  }

  const server = createApp();

  // Bind to port 0: the kernel picks a free port, so we never collide
  // with the harness or anything else already on the box.
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

  console.log(`forge listening on port ${port}`);

  if (!(await registerPort(envBase, port))) {
    server.close();
    return 1;
  }

  // Long-poll until the harness reports the run is done. The first
  // check happens immediately (no sleep up front), so a run that is
  // already finished ends promptly instead of waiting out a delay.
  while (!(await isDone(envBase))) {
    await sleep(POLL_DELAY_MS);
  }

  console.log("harness reported done; shutting down");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

process.exitCode = await main();
