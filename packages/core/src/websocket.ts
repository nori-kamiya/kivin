// WebSocket routes on Bun's native WebSocket server.
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';

export interface WebSocketData<TData = undefined> {
  /** The route template the socket was opened on, e.g. `/rooms/:id`. */
  route: string;
  params: Record<string, string>;
  /** Whatever `upgrade` returned. */
  data: TData;
}

export type KivinWebSocket<TData = undefined> = ServerWebSocket<WebSocketData<TData>>;

export interface WebSocketRoute<TData = undefined> {
  /**
   * Runs before the upgrade, e.g. to authenticate. Return the per-socket data, or a `Response`
   * (such as a 401) to refuse the upgrade.
   */
  upgrade?(request: Request & { params: Record<string, string> }): TData | Response | Promise<TData | Response>;
  open?(socket: KivinWebSocket<TData>): void | Promise<void>;
  message?(socket: KivinWebSocket<TData>, message: string | Buffer): void | Promise<void>;
  close?(socket: KivinWebSocket<TData>, code: number, reason: string): void | Promise<void>;
  drain?(socket: KivinWebSocket<TData>): void | Promise<void>;
  /**
   * Called when `open` / `message` / `close` / `drain` throws or rejects. Without it the error is
   * logged with `console.error`. The socket stays open, except after a failed `open`, which closes
   * it with 1011 (internal error).
   */
  error?(socket: KivinWebSocket<TData>, error: unknown, phase: WebSocketPhase): void;
}

export type WebSocketPhase = 'open' | 'message' | 'close' | 'drain';

/** Identity helper that infers `TData` from `upgrade`. */
export function defineWebSocket<TData = undefined>(route: WebSocketRoute<TData>): WebSocketRoute<TData> {
  return route;
}

type AnyRoute = WebSocketRoute<unknown>;

/** Bun route handlers that upgrade the request, plus the shared handler that dispatches by route. */
export function compileWebSocketRoutes(routes: Record<string, WebSocketRoute<any>>) {
  const handlers: Record<string, (request: Request & { params?: Record<string, string> }, server: Server<WebSocketData<unknown>>) => Promise<Response | undefined>> = {};

  for (const [route, definition] of Object.entries(routes) as Array<[string, AnyRoute]>) {
    handlers[route] = async (request, server) => {
      const params = request.params ?? {};
      let data: unknown;
      if (definition.upgrade) {
        // Bun's route handlers already carry `params` (read-only); only plain requests need it added.
        const routed = request.params ? (request as Request & { params: Record<string, string> }) : Object.assign(request, { params });
        let result: unknown;
        try {
          result = await definition.upgrade(routed);
        } catch (error) {
          // Never let it reach Bun's default error page (which shows the stack in development).
          console.error(`[kivin] WebSocket upgrade failed for ${route}`, error);
          return Response.json({ message: 'Internal Server Error' }, { status: 500 });
        }
        if (result instanceof Response) {
          return result;
        }
        data = result;
      }
      if (server.upgrade(request, { data: { route, params, data } })) {
        return undefined;
      }
      return Response.json({ message: 'Expected a WebSocket upgrade request' }, { status: 426, headers: { upgrade: 'websocket' } });
    };
  }

  const routeOf = (socket: ServerWebSocket<WebSocketData<unknown>>) => routes[socket.data.route] as AnyRoute | undefined;
  // A throwing or rejecting handler would otherwise become an unhandled rejection (Bun reports it
  // and the process exits non-zero). Errors go to the route's `error` hook or the console.
  const guarded = (phase: WebSocketPhase, socket: ServerWebSocket<WebSocketData<unknown>>, run: (route: AnyRoute) => void | Promise<void>) => {
    const route = routeOf(socket);
    if (!route) {
      return;
    }
    const report = (error: unknown) => {
      try {
        if (route.error) {
          route.error(socket, error, phase);
        } else {
          console.error(`[kivin] WebSocket ${phase} handler failed for ${socket.data.route}`, error);
        }
      } catch (hookError) {
        console.error(`[kivin] WebSocket error hook failed for ${socket.data.route}`, hookError);
      }
      if (phase === 'open') {
        socket.close(1011, 'Internal Error');
      }
    };
    try {
      const result = run(route);
      if (result && typeof (result as Promise<void>).then === 'function') {
        return (result as Promise<void>).then(undefined, report);
      }
      return result;
    } catch (error) {
      report(error);
    }
  };
  const websocket: WebSocketHandler<WebSocketData<unknown>> = {
    open(socket) {
      return guarded('open', socket, (route) => route.open?.(socket));
    },
    message(socket, message) {
      return guarded('message', socket, (route) => route.message?.(socket, message));
    },
    close(socket, code, reason) {
      return guarded('close', socket, (route) => route.close?.(socket, code, reason));
    },
    drain(socket) {
      return guarded('drain', socket, (route) => route.drain?.(socket));
    },
  };

  return { handlers, websocket };
}
