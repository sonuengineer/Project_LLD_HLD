// Runs the API and a worker in one process, and shuts both down cleanly.
//
// close(): stop accepting connections, let requests in progress finish, then stop the worker (which waits for the
// jobs it is sending: stage 2's Worker.stop). Jobs still queued stay queued -- with a real queue another process
// picks them up; in memory they are lost with the process (documented).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import type { Worker } from "../worker.js";

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(app: express.Express, worker: Worker, options: { port: number; host: string }): Promise<RunningServer> {
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(options.port, options.host, () => resolve(s));
    s.once("error", reject);
  });
  worker.start();
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${options.host}:${port}`,
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
        server.closeIdleConnections(); // keep-alive sockets with no request would otherwise hold close() open
        await closed;
        await worker.stop();
      })();
      return closing;
    },
  };
}
