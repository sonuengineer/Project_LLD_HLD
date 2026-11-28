// Starts the API and shuts it down cleanly: stop accepting new connections, let requests already in progress
// finish, then resolve. Everything this project holds (conversations, messages, presence) lives only in
// process memory, so there is nothing else to flush on the way out.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(app: express.Express, options: { port: number; host: string }): Promise<RunningServer> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(options.port, options.host, () => resolve(s));
    s.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${options.host}:${port}`,
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
        server.closeIdleConnections(); // keep-alive sockets with no request would otherwise hold close() open
        await closed;
      })();
      return closing;
    },
  };
}
