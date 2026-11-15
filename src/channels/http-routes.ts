/**
 * Typed route registry for channels that share the single HTTP server the
 * webhook channel owns (port 3003). A channel that needs an HTTP path
 * registers its handler here at connect time; the webhook server consults
 * the registry when routing. Replaces the untyped
 * `(globalThis as any).__webChatHandler` hand-off.
 */
import type { IncomingMessage, ServerResponse } from 'http';

export type HttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

const routes = new Map<string, HttpRouteHandler>();

export function registerHttpRoute(
  pathname: string,
  handler: HttpRouteHandler,
): void {
  routes.set(pathname, handler);
}

export function getHttpRoute(pathname: string): HttpRouteHandler | undefined {
  return routes.get(pathname);
}
