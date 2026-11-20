import type { ClientRequest } from "node:http";

/**
 * Connect timeout: give up if the TCP connection is not established within `ms`.
 *
 * This is separate from the idle timeout on purpose. Connecting to a machine that is down or
 * unreachable should fail in seconds, so a retry can go to another upstream, while a healthy
 * upstream may legitimately take much longer to produce a response.
 *
 * A socket reused from the keep-alive pool is already connected, so there is nothing to wait for.
 */
export function watchConnect(req: ClientRequest, ms: number, onTimeout: () => void): void {
  req.once("socket", (socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(onTimeout, ms);
    const clear = (): void => clearTimeout(timer);
    socket.once("connect", clear);
    socket.once("close", clear);
  });
}
