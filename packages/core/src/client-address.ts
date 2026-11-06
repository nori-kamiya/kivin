// Client (peer) address of requests received by `app.listen()`.
import type { Server } from 'bun';

// Servers started by `app.listen()`. `requestIP` answers null for requests it did not receive, so
// several listening apps can coexist.
const listeningServers = new Set<Server<unknown>>();

/** @internal Called by `app.listen()` / `app.close()`. */
export function trackServer(server: Server<unknown>, listening: boolean) {
  if (listening) {
    listeningServers.add(server);
  } else {
    listeningServers.delete(server);
  }
}

/**
 * The peer address of a request received by `app.listen()` (Bun's `server.requestIP`), or
 * `undefined` (e.g. for `app.fetch` in tests). Behind a reverse proxy this is the proxy: read a
 * trusted forwarding header yourself in that case.
 */
export function getClientAddress(request: Request): string | undefined {
  for (const server of listeningServers) {
    const address = server.requestIP(request);
    if (address) {
      return address.address;
    }
  }
  return undefined;
}
