/**
 * The broker: TCP server, one Client per connection, one shared SubjectTrie of subscriptions.
 *
 * Delivery model (core NATS): AT MOST ONCE. A PUB is matched against the subscriptions that exist at that moment,
 * written to each matching connection, and forgotten. Nothing is stored; a subscriber that is not connected misses it.
 *
 * Stage 2 adds:
 *  - queue groups: subscriptions with the same queue name share the work; each message goes to ONE member per group
 *  - headers: HPUB in, HMSG out (stripped to a plain MSG for a client that did not ask for headers)
 *  - "no responders": a request (PUB with a reply subject) that reaches nobody gets an immediate 503 status message
 *  - slow-consumer protection: a per-client cap on bytes waiting in the socket's write buffer
 *  - graceful close: queued bytes are flushed before connections are closed
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { Parser, ParseError, type Op } from "./parser.js";
import { SubjectTrie, isValidPublishSubject, isValidSubscribeSubject } from "./subjects.js";

export const VERSION = "0.2.0";

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
  /** Max bytes queued for ONE client that it has not read yet. Over it: -ERR 'Slow Consumer' and disconnect. */
  maxPending?: number;
}

export interface BrokerStats {
  connections: number;
  subscriptions: number;
  inMsgs: number;
  inBytes: number;
  outMsgs: number;
  outBytes: number;
  slowConsumers: number;
}

interface Subscription {
  client: Client;
  sid: string;
  subject: string;
  queue: string | undefined;
  /** Auto-unsubscribe after this many deliveries (UNSUB <sid> <max>). */
  max: number | undefined;
  delivered: number;
}

const CRLF = Buffer.from("\r\n");
/** The status-only header block nats-server sends for "no responders". */
const NO_RESPONDERS = Buffer.from("NATS/1.0 503\r\n\r\n");

class Client {
  readonly subs = new Map<string, Subscription>();
  verbose = false;
  echo = true;
  headers = false;
  noResponders = false;
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
  private counters = { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, slowConsumers: 0 };

  constructor(options: BrokerOptions = {}) {
    this.opts = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4222,
      serverName: options.serverName ?? "h12-broker",
      maxPayload: options.maxPayload ?? 1024 * 1024,
      maxControlLine: options.maxControlLine ?? 4096,
      pingIntervalMs: options.pingIntervalMs ?? 120_000,
      maxPingsOut: options.maxPingsOut ?? 2,
      maxPending: options.maxPending ?? 64 * 1024 * 1024,
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

  /**
   * Graceful close: stop accepting, stop routing, then end() every connection. end() sends what is already queued
   * for that client and THEN the FIN, so messages accepted before close() are still delivered. A peer that does not
   * read (or never closes its side) is destroyed after forceMs.
   */
  async close(forceMs = 5000): Promise<"closed" | "forced"> {
    const serverClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    const sockets = [...this.clients].map((c) => c.socket);
    for (const c of [...this.clients]) this.drop(c, false);
    const allClosed = Promise.all(
      sockets.map((s) => (s.destroyed ? Promise.resolve() : new Promise<void>((r) => s.once("close", () => r())))),
    );
    for (const s of sockets) s.end();
    let timer: NodeJS.Timeout | undefined;
    const forced = new Promise<"forced">((resolve) => {
      timer = setTimeout(() => resolve("forced"), forceMs);
    });
    const result = await Promise.race([allClosed.then(() => "closed" as const), forced]);
    clearTimeout(timer);
    if (result === "forced") for (const s of sockets) s.destroy();
    await serverClosed;
    return result;
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
      headers: true,
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

  /**
   * A client that does not keep up. Unlike fatal(), the socket is destroyed AT ONCE: its write buffer is already at the
   * limit, waiting for it to flush is exactly the memory we are trying to give back. The -ERR is written first, but
   * the client will usually not see it (it is queued behind everything it did not read).
   */
  private slowConsumer(c: Client): void {
    if (c.closed) return;
    this.counters.slowConsumers++;
    c.err("Slow Consumer");
    this.drop(c, true);
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
        c.headers = op.options.headers === true;
        c.noResponders = op.options.no_responders === true;
        c.ok();
        return;
      case "SUB":
        this.subscribe(c, op.subject, op.queue, op.sid);
        return;
      case "UNSUB":
        this.unsubscribe(c, op.sid, op.max);
        return;
      case "PUB":
        this.publish(c, op.subject, op.reply, op.headerLen, op.payload);
        return;
    }
  }

  private subscribe(c: Client, subject: string, queue: string | undefined, sid: string): void {
    if (!isValidSubscribeSubject(subject)) {
      c.err("Invalid Subject");
      return;
    }
    if (queue !== undefined && !/^[^\s.*>]+$/.test(queue)) {
      c.err("Invalid Queue Name");
      return;
    }
    if (!c.subs.has(sid)) {
      // A repeated sid is ignored (the first subscription stays), as nats-server does.
      const sub: Subscription = { client: c, sid, subject, queue, max: undefined, delivered: 0 };
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

  private publish(c: Client, subject: string, reply: string | undefined, headerLen: number | undefined, payload: Buffer): void {
    if (!isValidPublishSubject(subject) || (reply !== undefined && !isValidPublishSubject(reply))) {
      c.err("Invalid Publish Subject");
      return;
    }
    this.counters.inMsgs++;
    this.counters.inBytes += payload.length;

    // Plain subscriptions each get a copy; each queue group gets ONE copy, to one randomly chosen member.
    const groups = new Map<string, Subscription[]>();
    let delivered = 0;
    for (const sub of this.trie.match(subject)) {
      if (sub.client === c && !c.echo) continue;
      if (sub.queue === undefined) {
        if (this.deliver(sub, subject, reply, headerLen, payload)) delivered++;
      } else {
        const members = groups.get(sub.queue);
        if (members) members.push(sub);
        else groups.set(sub.queue, [sub]);
      }
    }
    for (const members of groups.values()) {
      const pick = members[Math.floor(Math.random() * members.length)]!;
      if (this.deliver(pick, subject, reply, headerLen, payload)) delivered++;
    }

    if (delivered === 0 && reply !== undefined && c.headers && c.noResponders) this.sendNoResponders(c, reply);
    c.ok();
  }

  /** Writes one MSG/HMSG frame. Returns false if the subscriber was dropped as a slow consumer instead. */
  private deliver(sub: Subscription, subject: string, reply: string | undefined, headerLen: number | undefined, payload: Buffer): boolean {
    const target = sub.client;
    if (target.closed) return false;
    const replyPart = reply === undefined ? "" : ` ${reply}`;
    let head: string;
    let body: Buffer;
    if (headerLen !== undefined && target.headers) {
      head = `HMSG ${subject} ${sub.sid}${replyPart} ${headerLen} ${payload.length}\r\n`;
      body = payload;
    } else {
      // A client that did not ask for headers gets the body only, as a plain MSG.
      body = headerLen === undefined ? payload : payload.subarray(headerLen);
      head = `MSG ${subject} ${sub.sid}${replyPart} ${body.length}\r\n`;
    }
    // One write per delivery: header, payload and CRLF together, so the frame is never interleaved with another.
    const frame = Buffer.concat([Buffer.from(head), body, CRLF]);
    if (target.socket.writableLength + frame.length > this.opts.maxPending) {
      this.slowConsumer(target);
      return false;
    }
    target.write(frame);
    this.counters.outMsgs++;
    this.counters.outBytes += body.length;
    sub.delivered++;
    if (sub.max !== undefined && sub.delivered >= sub.max) this.removeSub(sub);
    return true;
  }

  /** nats-server behaviour: tell the requester at once that nobody is listening, instead of letting it time out. */
  private sendNoResponders(c: Client, reply: string): void {
    const sub = this.trie.match(reply).find((s) => s.client === c);
    if (!sub) return;
    c.write(Buffer.concat([Buffer.from(`HMSG ${reply} ${sub.sid} ${NO_RESPONDERS.length} ${NO_RESPONDERS.length}\r\n`), NO_RESPONDERS, CRLF]));
  }
}
