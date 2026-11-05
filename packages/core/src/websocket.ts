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
}

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
        const result = await definition.upgrade(routed);
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
  const websocket: WebSocketHandler<WebSocketData<unknown>> = {
    open(socket) {
      return routeOf(socket)?.open?.(socket);
    },
    message(socket, message) {
      return routeOf(socket)?.message?.(socket, message);
    },
    close(socket, code, reason) {
      return routeOf(socket)?.close?.(socket, code, reason);
    },
    drain(socket) {
      return routeOf(socket)?.drain?.(socket);
    },
  };

  return { handlers, websocket };
}
