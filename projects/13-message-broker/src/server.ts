/**
 * The broker: TCP server, one Client per connection, one shared SubjectTrie of subscriptions.
 *
 * Delivery model (core NATS): AT MOST ONCE. A PUB is matched against the subscriptions that exist at that moment,
 * written to each matching connection, and forgotten. Nothing is stored; a subscriber that is not connected misses it.
 *
 * Stage 1 limits (stage 2 fixes them, see PLAN.md): no queue groups, no headers, and no slow-consumer protection --
 * a subscriber that does not read lets its socket's write buffer grow without a bound.
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { Parser, ParseError, type Op } from "./parser.js";
import { SubjectTrie, isValidPublishSubject, isValidSubscribeSubject } from "./subjects.js";

export const VERSION = "0.1.0";

export interface BrokerOptions {
  host?: string;
  port?: number;
  serverName?: string;
  maxPayload?: number;
  maxControlLine?: number;
  /** How often the server PINGs each client. */
  pingIntervalMs?: number;
  /** Unanswered server PINGs allowed; one more interval without a PONG closes the connection as stale. */
  maxPingsOut?: number;
}

export interface BrokerStats {
  connections: number;
  subscriptions: number;
  inMsgs: number;
  inBytes: number;
  outMsgs: number;
  outBytes: number;
}

interface Subscription {
  client: Client;
  sid: string;
  subject: string;
  /** Auto-unsubscribe after this many deliveries (UNSUB <sid> <max>). */
  max: number | undefined;
  delivered: number;
}

const CRLF = Buffer.from("\r\n");

class Client {
  readonly subs = new Map<string, Subscription>();
  verbose = false;
  echo = true;
  pingsOut = 0;
  closed = false;
  readonly parser: Parser;
  pingTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: number,
    readonly socket: net.Socket,
    readonly broker: Broker,
  ) {
    this.parser = new Parser(
      { maxControlLine: broker.opts.maxControlLine, maxPayload: broker.opts.maxPayload },
      (op) => broker.handle(this, op),
    );
  }

  write(data: string | Buffer): void {
    if (!this.closed) this.socket.write(data);
  }

  ok(): void {
    if (this.verbose) this.write("+OK\r\n");
  }

  /** A non-fatal error: reported, the connection stays open. */
  err(message: string): void {
    this.write(`-ERR '${message}'\r\n`);
  }
}

export class Broker {
  readonly opts: Required<BrokerOptions>;
  readonly serverId = randomBytes(11).toString("hex").toUpperCase();
  private readonly server: net.Server;
  private readonly clients = new Set<Client>();
  private readonly trie = new SubjectTrie<Subscription>();
  private nextClientId = 1;
  private counters = { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0 };

  constructor(options: BrokerOptions = {}) {
    this.opts = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4222,
      serverName: options.serverName ?? "h12-broker",
      maxPayload: options.maxPayload ?? 1024 * 1024,
      maxControlLine: options.maxControlLine ?? 4096,
      pingIntervalMs: options.pingIntervalMs ?? 120_000,
      maxPingsOut: options.maxPingsOut ?? 2,
    };
    this.server = net.createServer((socket) => this.accept(socket));
  }

  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.server.off("error", reject);
        const a = this.server.address() as net.AddressInfo;
        resolve({ host: a.address, port: a.port });
      });
    });
  }

  /** Stops accepting and drops every connection. (Graceful drain is stage 2.) */
  close(): Promise<void> {
    for (const c of [...this.clients]) this.drop(c);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  stats(): BrokerStats {
    return { connections: this.clients.size, subscriptions: this.trie.size, ...this.counters };
  }

  private accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    const client = new Client(this.nextClientId++, socket, this);
    this.clients.add(client);

    const info = {
      server_id: this.serverId,
      server_name: this.opts.serverName,
      version: VERSION,
      proto: 1,
      host: this.opts.host,
      port: this.opts.port,
      headers: false,
      max_payload: this.opts.maxPayload,
      client_id: client.id,
      client_ip: socket.remoteAddress,
    };
    client.write(`INFO ${JSON.stringify(info)}\r\n`);

    socket.on("data", (chunk: Buffer) => {
      try {
        client.parser.feed(chunk);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.fatal(client, e.message);
      }
    });
    socket.on("error", () => this.drop(client)); // ECONNRESET and friends: just clean up
    socket.on("close", () => this.drop(client));

    client.pingTimer = setInterval(() => this.pingTick(client), this.opts.pingIntervalMs);
    client.pingTimer.unref();
  }

  private pingTick(c: Client): void {
    if (c.pingsOut >= this.opts.maxPingsOut) {
      this.fatal(c, "Stale Connection");
      return;
    }
    c.pingsOut++;
    c.write("PING\r\n");
  }

  /** Sends -ERR, lets it flush, closes. Subscriptions are removed immediately, not when the socket finally closes. */
  private fatal(c: Client, message: string): void {
    if (c.closed) return;
    c.err(message);
    c.socket.end();
    this.drop(c, false);
    // If the peer never reads, end() alone would leave the socket half-open forever.
    setTimeout(() => c.socket.destroy(), 2000).unref();
  }

  private drop(c: Client, destroy = true): void {
    if (!c.closed) {
      c.closed = true;
      clearInterval(c.pingTimer);
      for (const s of c.subs.values()) this.trie.remove(s.subject, s);
      c.subs.clear();
      this.clients.delete(c);
    }
    if (destroy) c.socket.destroy();
  }

  /** Called by the client's parser for every complete operation. */
  handle(c: Client, op: Op): void {
    if (c.closed) return;
    switch (op.op) {
      case "PING":
        c.write("PONG\r\n");
        return;
      case "PONG":
        c.pingsOut = 0;
        return;
      case "CONNECT":
        c.verbose = op.options.verbose === true;
        c.echo = op.options.echo !== false;
        c.ok();
        return;
      case "SUB":
        this.subscribe(c, op.subject, op.queue, op.sid);
        return;
      case "UNSUB":
        this.unsubscribe(c, op.sid, op.max);
        return;
      case "PUB":
        this.publish(c, op.subject, op.reply, op.payload);
        return;
    }
  }

  private subscribe(c: Client, subject: string, queue: string | undefined, sid: string): void {
    if (queue !== undefined) {
      c.err("Queue Groups Not Supported Yet");
      return;
    }
    if (!isValidSubscribeSubject(subject)) {
      c.err("Invalid Subject");
      return;
    }
    if (!c.subs.has(sid)) {
      // A repeated sid is ignored (the first subscription stays), as nats-server does.
      const sub: Subscription = { client: c, sid, subject, max: undefined, delivered: 0 };
      c.subs.set(sid, sub);
      this.trie.insert(subject, sub);
    }
    c.ok();
  }

  private unsubscribe(c: Client, sid: string, max: number | undefined): void {
    const sub = c.subs.get(sid);
    if (sub) {
      if (max !== undefined && sub.delivered < max) sub.max = max;
      else this.removeSub(sub);
    }
    // UNSUB for an unknown sid is not an error: it may already have been auto-removed.
    c.ok();
  }

  private removeSub(sub: Subscription): void {
    this.trie.remove(sub.subject, sub);
    sub.client.subs.delete(sub.sid);
  }

  private publish(c: Client, subject: string, reply: string | undefined, payload: Buffer): void {
    if (!isValidPublishSubject(subject) || (reply !== undefined && !isValidPublishSubject(reply))) {
      c.err("Invalid Publish Subject");
      return;
    }
    this.counters.inMsgs++;
    this.counters.inBytes += payload.length;

    const tail = ` ${payload.length}\r\n`;
    const replyPart = reply === undefined ? "" : ` ${reply}`;
    for (const sub of this.trie.match(subject)) {
      if (sub.client === c && !c.echo) continue;
      // One write per delivery: header, payload and CRLF together, so the frame is never interleaved with another.
      const frame = Buffer.concat([Buffer.from(`MSG ${subject} ${sub.sid}${replyPart}${tail}`), payload, CRLF]);
      sub.client.write(frame);
      this.counters.outMsgs++;
      this.counters.outBytes += payload.length;
      sub.delivered++;
      if (sub.max !== undefined && sub.delivered >= sub.max) this.removeSub(sub);
    }
    c.ok();
  }
}
