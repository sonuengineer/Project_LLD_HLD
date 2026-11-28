/**
 * The UDP listener clients talk to. It binds loopback only, unless allowNonLoopback is set -- same reasoning as
 * 15-dns-resolver's stub server: an open resolver with no access control is useful for DNS amplification attacks.
 *
 * Deliberately UDP only (see PLAN.md "Not in scope"): a downstream client falling back to TCP after a truncated
 * UDP reply from US is not implemented. TCP IS used, as required, on the upstream side (see transport.ts) when
 * the UPSTREAM's reply is truncated.
 */
import dgram from "node:dgram";
import type { SinkholeProxy } from "./proxy.js";

export const isLoopback = (h: string): boolean => h === "127.0.0.1" || h === "::1" || h === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(h);

export interface SinkholeServerOptions {
  proxy: SinkholeProxy;
  host?: string;
  /** 0 = any free port (tests); default 15353 (a high port -- binding 53 needs root). */
  port?: number;
  allowNonLoopback?: boolean;
}

export class SinkholeServer {
  private udp?: dgram.Socket;

  constructor(private readonly opts: SinkholeServerOptions) {}

  async listen(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    if (!isLoopback(host) && !this.opts.allowNonLoopback) {
      throw new Error(`refusing to bind ${host}: this proxy has no access control. Set allowNonLoopback only on a private network.`);
    }
    const udp = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(this.opts.port ?? 15353, host, () => {
        udp.off("error", reject);
        resolve();
      });
    });
    udp.on("message", (buf, rinfo) => {
      this.opts.proxy.handle(buf).then(
        (out) => {
          if (out) udp.send(out, rinfo.port, rinfo.address);
        },
        () => {}, // a bug in handle() drops one reply, not the whole process
      );
    });
    this.udp = udp;
    const addr = udp.address();
    return { host, port: addr.port };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.udp ? this.udp.close(() => resolve()) : resolve()));
  }
}
