/**
 * The broker: TCP server, one Client per connection, one shared SubjectTrie of subscriptions, and (stage 3) routes to
 * other brokers.
 *
 * Delivery model (core NATS): AT MOST ONCE. A PUB is matched against the subscriptions that exist at that moment,
 * written to each matching connection, and forgotten. Nothing is stored; a subscriber that is not connected misses it.
 *
 * Stage 2:
 *  - queue groups: subscriptions with the same queue name share the work; each message goes to ONE member per group
 *  - headers: HPUB in, HMSG out (stripped to a plain MSG for a client that did not ask for headers)
 *  - "no responders": a request (PUB with a reply subject) that reaches nobody gets an immediate 503 status message
 *  - slow-consumer protection: a per-client cap on bytes waiting in the socket's write buffer
 *  - graceful close: queued bytes are flushed before connections are closed
 *
 * Stage 3 (cluster, full mesh, our own route protocol in route.ts):
 *  - interest propagation: each broker tells every peer which subjects (and queue groups) its CLIENTS subscribe to, once
 *    per distinct subject/queue (RS+ on 0 -> 1, RS- on 1 -> 0). A message is forwarded only to peers with interest.
 *  - one hop only: a message that arrived from a route is delivered locally and NEVER forwarded to another route. In a
 *    full mesh every broker is one hop from every other, so this is enough, and it makes loops impossible.
 *  - queue groups cluster-wide: the ORIGIN broker picks the group's destination: a local member if there is one,
 *    otherwise exactly one peer that has a member. The RMSG names the groups that peer must serve.
 *  - duplicate connections (both sides dialled each other) are resolved by a rule both sides compute the same way.
 *  - a dialled route that drops is re-dialled with exponential backoff.
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { Parser, ParseError, type Op } from "./parser.js";
import { RouteParser, encodeInterest, encodeRinfo, encodeRmsg, type RouteMsgMeta, type RouteOp } from "./route.js";
import { SubjectTrie, isValidPublishSubject, isValidSubscribeSubject } from "./subjects.js";

export const VERSION = "0.3.0";

export interface ClusterOptions {
  host?: string;
  /** Port for route connections from other brokers (0 = any free port). */
  port: number;
  /** Peers to dial, "host:port" each. Every broker may list every other one; duplicates are resolved. */
  routes?: string[];
  /** First re-dial delay; doubles per failed attempt up to 32x. */
  reconnectMs?: number;
}

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
  cluster?: ClusterOptions;
}

export interface BrokerStats {
  connections: number;
  subscriptions: number;
  inMsgs: number;
  inBytes: number;
  outMsgs: number;
  outBytes: number;
  slowConsumers: number;
  routes: number;
  routeInMsgs: number;
  routeOutMsgs: number;
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

interface Interest {
  subject: string;
  queue: string | undefined;
}

const CRLF = Buffer.from("\r\n");
/** The status-only header block nats-server sends for "no responders". */
const NO_RESPONDERS = Buffer.from("NATS/1.0 503\r\n\r\n");

const interestKey = (subject: string, queue: string | undefined) => (queue === undefined ? subject : `${subject} ${queue}`);
const pickRandom = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

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

/** One connection to another broker. Exists before the handshake (peerId undefined) and after it. */
class Route {
  peerId: string | undefined;
  closed = false;
  /** What the PEER's clients subscribe to, as announced with RS+ / RS-. */
  readonly interest = new SubjectTrie<Interest>();
  readonly interestByKey = new Map<string, Interest>();
  parser!: RouteParser;

  constructor(
    readonly socket: net.Socket,
    /** True when WE dialled this connection (only then do we re-dial it). */
    readonly dialedBySelf: boolean,
    readonly url: string | undefined,
  ) {}

  write(data: string | Buffer): void {
    if (!this.closed) this.socket.write(data);
  }
}

interface Dialer {
  url: string;
  host: string;
  port: number;
  attempts: number;
  timer: NodeJS.Timeout | undefined;
  /** Learned from the handshake: lets us skip dialling while a route to that peer exists (dialled by the other side). */
  peerId: string | undefined;
  /** The URL turned out to be ourselves: never dial it again. */
  self: boolean;
}

export class Broker {
  readonly opts: Required<Omit<BrokerOptions, "cluster">> & { cluster: ClusterOptions | undefined };
  readonly serverId = randomBytes(11).toString("hex").toUpperCase();
  private readonly server: net.Server;
  private readonly clients = new Set<Client>();
  private readonly trie = new SubjectTrie<Subscription>();
  private nextClientId = 1;
  private counters = { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, slowConsumers: 0, routeInMsgs: 0, routeOutMsgs: 0 };

  private clusterServer: net.Server | undefined;
  private readonly routes = new Map<string, Route>();
  private readonly pendingRoutes = new Set<Route>();
  private readonly localInterest = new Map<string, number>();
  private readonly dialers = new Map<string, Dialer>();
  private stopping = false;

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
      cluster: options.cluster,
    };
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<{ host: string; port: number; clusterPort: number | undefined }> {
    const a = await listenOn(this.server, this.opts.port, this.opts.host);
    let clusterPort: number | undefined;
    const cluster = this.opts.cluster;
    if (cluster) {
      this.clusterServer = net.createServer((socket) => this.setupRoute(new Route(socket, false, undefined)));
      clusterPort = (await listenOn(this.clusterServer, cluster.port, cluster.host ?? this.opts.host)).port;
      for (const url of cluster.routes ?? []) this.addRoute(url);
    }
    return { host: a.address, port: a.port, clusterPort };
  }

  /** Start dialling a peer ("host:port"). Also used by tests that only know the ports after listen(). */
  addRoute(url: string): void {
    if (this.dialers.has(url) || this.stopping) return;
    const cut = url.lastIndexOf(":");
    const port = Number(url.slice(cut + 1));
    if (cut < 0 || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad route url ${url}`);
    const d: Dialer = { url, host: url.slice(0, cut), port, attempts: 0, timer: undefined, peerId: undefined, self: false };
    this.dialers.set(url, d);
    this.dial(d);
  }

  /**
   * Graceful close: stop accepting, cut the routes, stop routing, then end() every client connection. end() sends what is
   * already queued for that client and THEN the FIN, so messages accepted before close() are still delivered. A peer that
   * does not read (or never closes its side) is destroyed after forceMs.
   */
  async close(forceMs = 5000): Promise<"closed" | "forced"> {
    this.stopping = true;
    for (const d of this.dialers.values()) clearTimeout(d.timer);
    for (const r of [...this.pendingRoutes, ...this.routes.values()]) {
      this.routeGone(r);
      r.socket.destroy();
    }
    const clusterClosed = this.clusterServer
      ? new Promise<void>((resolve) => this.clusterServer!.close(() => resolve()))
      : Promise.resolve();

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
    await Promise.all([serverClosed, clusterClosed]);
    return result;
  }

  stats(): BrokerStats {
    return { connections: this.clients.size, subscriptions: this.trie.size, routes: this.routes.size, ...this.counters };
  }

  /** Peer ids of the established routes (tests use it to wait for the mesh). */
  routePeers(): string[] {
    return [...this.routes.keys()].sort();
  }

  /** True if at least one peer announced interest matching this subject (tests use it to wait for propagation). */
  hasRemoteInterest(subject: string, queue?: string): boolean {
    for (const r of this.routes.values()) {
      if (r.interest.match(subject).some((i) => queue === undefined || i.queue === queue)) return true;
    }
    return false;
  }

  /**
   * How many peers announced interest matching this subject: as plain subscribers (queue undefined) or as members of
   * the given queue group. Tests use it to wait until propagation has reached every peer.
   */
  peerInterest(subject: string, queue?: string): number {
    let n = 0;
    for (const r of this.routes.values()) if (r.interest.match(subject).some((i) => i.queue === queue)) n++;
    return n;
  }

  // ---------------------------------------------------------------- clients

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
      for (const s of [...c.subs.values()]) this.removeSub(s);
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
      this.interestUp(subject, queue);
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
    if (!this.trie.remove(sub.subject, sub)) return;
    sub.client.subs.delete(sub.sid);
    this.interestDown(sub.subject, sub.queue);
  }

  // ---------------------------------------------------------------- routing

  private publish(c: Client, subject: string, reply: string | undefined, headerLen: number | undefined, payload: Buffer): void {
    if (!isValidPublishSubject(subject) || (reply !== undefined && !isValidPublishSubject(reply))) {
      c.err("Invalid Publish Subject");
      return;
    }
    this.counters.inMsgs++;
    this.counters.inBytes += payload.length;

    let delivered = 0;
    // Local: plain subscribers each get a copy; queue groups are collected, one member is picked below.
    const localGroups = new Map<string, Subscription[]>();
    for (const sub of this.trie.match(subject)) {
      if (sub.client === c && !c.echo) continue;
      if (sub.queue === undefined) {
        if (this.deliver(sub, subject, reply, headerLen, payload)) delivered++;
      } else {
        const members = localGroups.get(sub.queue);
        if (members) members.push(sub);
        else localGroups.set(sub.queue, [sub]);
      }
    }

    // Remote: which peers want it as plain subscribers, and which peers have members of which queue groups.
    const plainPeers: Route[] = [];
    const peersByGroup = new Map<string, Route[]>();
    for (const r of this.routes.values()) {
      let plain = false;
      for (const i of r.interest.match(subject)) {
        if (i.queue === undefined) plain = true;
        else {
          const list = peersByGroup.get(i.queue);
          if (!list) peersByGroup.set(i.queue, [r]);
          else if (!list.includes(r)) list.push(r);
        }
      }
      if (plain) plainPeers.push(r);
    }

    // Each queue group gets the message ONCE in the whole cluster: a local member if there is one, else one peer.
    const groupsForPeer = new Map<Route, string[]>();
    for (const [group, members] of localGroups) {
      if (this.deliver(pickRandom(members), subject, reply, headerLen, payload)) delivered++;
      peersByGroup.delete(group);
    }
    for (const [group, peers] of peersByGroup) {
      const peer = pickRandom(peers);
      const list = groupsForPeer.get(peer);
      if (list) list.push(group);
      else groupsForPeer.set(peer, [group]);
    }

    // One RMSG per peer at most, carrying "deliver to your plain subscribers" and the groups it must serve.
    for (const r of new Set([...plainPeers, ...groupsForPeer.keys()])) {
      const meta: RouteMsgMeta = { s: subject, p: plainPeers.includes(r) };
      if (reply !== undefined) meta.r = reply;
      const groups = groupsForPeer.get(r);
      if (groups) meta.q = groups;
      if (headerLen !== undefined) meta.h = headerLen;
      r.write(encodeRmsg(meta, payload));
      this.counters.routeOutMsgs++;
      delivered++;
    }

    if (delivered === 0 && reply !== undefined && c.headers && c.noResponders) this.sendNoResponders(c, reply);
    c.ok();
  }

  /** A message from a peer: deliver to LOCAL subscribers only. Never forwarded to another route (one hop, no loops). */
  private fromRoute(meta: RouteMsgMeta, payload: Buffer): void {
    this.counters.routeInMsgs++;
    const groups = new Set(meta.q ?? []);
    const members = new Map<string, Subscription[]>();
    for (const sub of this.trie.match(meta.s)) {
      if (sub.queue === undefined) {
        if (meta.p) this.deliver(sub, meta.s, meta.r, meta.h, payload);
      } else if (groups.has(sub.queue)) {
        const list = members.get(sub.queue);
        if (list) list.push(sub);
        else members.set(sub.queue, [sub]);
      }
    }
    // If the member left between the RS+ and this message, the group misses it: at most once.
    for (const list of members.values()) this.deliver(pickRandom(list), meta.s, meta.r, meta.h, payload);
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

  // ---------------------------------------------------------------- interest propagation

  /** Counts local subscriptions per subject/queue; only the 0 -> 1 change is announced to peers. */
  private interestUp(subject: string, queue: string | undefined): void {
    const key = interestKey(subject, queue);
    const n = (this.localInterest.get(key) ?? 0) + 1;
    this.localInterest.set(key, n);
    if (n === 1) for (const r of this.routes.values()) r.write(encodeInterest("RS+", subject, queue));
  }

  /** Only the 1 -> 0 change is announced. */
  private interestDown(subject: string, queue: string | undefined): void {
    const key = interestKey(subject, queue);
    const n = (this.localInterest.get(key) ?? 0) - 1;
    if (n > 0) {
      this.localInterest.set(key, n);
      return;
    }
    this.localInterest.delete(key);
    for (const r of this.routes.values()) r.write(encodeInterest("RS-", subject, queue));
  }

  // ---------------------------------------------------------------- route connections

  private dial(d: Dialer): void {
    d.timer = undefined;
    if (this.stopping || d.self) return;
    if (d.peerId !== undefined && this.routes.has(d.peerId)) {
      // Already connected to that peer (the connection it dialled won the duplicate rule). Check again later, so we
      // take over if that connection drops.
      this.scheduleDial(d, false);
      return;
    }
    const socket = net.connect(d.port, d.host);
    this.setupRoute(new Route(socket, true, d.url));
  }

  private scheduleDial(d: Dialer, backoff = true): void {
    if (this.stopping || d.self || d.timer) return;
    const base = this.opts.cluster?.reconnectMs ?? 1000;
    const delay = Math.min(base * 2 ** d.attempts, base * 32);
    if (backoff) d.attempts++;
    d.timer = setTimeout(() => this.dial(d), delay);
    d.timer.unref();
  }

  private setupRoute(r: Route): void {
    this.pendingRoutes.add(r);
    r.socket.setNoDelay(true);
    r.socket.setKeepAlive(true, 10_000);
    r.parser = new RouteParser(
      { maxControlLine: this.opts.maxControlLine * 4, maxPayload: this.opts.maxPayload },
      (op) => this.handleRoute(r, op),
    );
    const start = () => r.write(encodeRinfo(this.serverId));
    if (r.dialedBySelf) r.socket.once("connect", start);
    else start();
    r.socket.on("data", (chunk: Buffer) => {
      try {
        r.parser.feed(chunk);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.routeGone(r);
        r.socket.destroy();
      }
    });
    r.socket.on("error", () => this.routeGone(r));
    r.socket.on("close", () => this.routeGone(r));
  }

  private handleRoute(r: Route, op: RouteOp): void {
    if (r.closed) return;
    if (op.op === "RINFO") {
      this.handshake(r, op.serverId);
      return;
    }
    if (r.peerId === undefined) throw new ParseError("Route Protocol Error: RINFO expected first");
    switch (op.op) {
      case "PING":
        r.write("PONG\r\n");
        return;
      case "PONG":
        return;
      case "RS+": {
        const key = interestKey(op.subject, op.queue);
        if (!r.interestByKey.has(key)) {
          const i: Interest = { subject: op.subject, queue: op.queue };
          r.interestByKey.set(key, i);
          r.interest.insert(op.subject, i);
        }
        return;
      }
      case "RS-": {
        const key = interestKey(op.subject, op.queue);
        const i = r.interestByKey.get(key);
        if (i) {
          r.interestByKey.delete(key);
          r.interest.remove(i.subject, i);
        }
        return;
      }
      case "RMSG":
        this.fromRoute(op.meta, op.payload);
        return;
    }
  }

  private handshake(r: Route, peerId: string): void {
    if (r.peerId !== undefined) throw new ParseError("Route Protocol Error: second RINFO");
    r.peerId = peerId;
    const dialer = r.url ? this.dialers.get(r.url) : undefined;
    if (peerId === this.serverId) {
      // We dialled ourselves (a node listing its own address). Never again.
      if (dialer) dialer.self = true;
      this.routeGone(r);
      r.socket.destroy();
      return;
    }
    if (dialer) {
      dialer.peerId = peerId;
      dialer.attempts = 0;
    }
    const existing = this.routes.get(peerId);
    if (existing) {
      // Both sides dialled each other. Keep the connection dialled by the SMALLER server id; both ends compute the same
      // answer, so they close the same connection. (Same dialer on both = a reconnect race: keep the newer one.)
      const dialerOf = (x: Route) => (x.dialedBySelf ? this.serverId : peerId);
      const winnerDialer = this.serverId < peerId ? this.serverId : peerId;
      const keepNew = dialerOf(r) === dialerOf(existing) || dialerOf(r) === winnerDialer;
      const loser = keepNew ? existing : r;
      this.routes.delete(peerId);
      this.routeGone(loser);
      loser.socket.destroy();
      if (!keepNew) {
        this.routes.set(peerId, existing);
        return;
      }
    }
    this.pendingRoutes.delete(r);
    this.routes.set(peerId, r);
    // Tell the new peer everything our clients are subscribed to.
    for (const key of this.localInterest.keys()) {
      const space = key.indexOf(" ");
      r.write(encodeInterest("RS+", space < 0 ? key : key.slice(0, space), space < 0 ? undefined : key.slice(space + 1)));
    }
  }

  private routeGone(r: Route): void {
    if (r.closed) return;
    r.closed = true;
    this.pendingRoutes.delete(r);
    if (r.peerId !== undefined && this.routes.get(r.peerId) === r) this.routes.delete(r.peerId);
    // The peer's interest goes with the connection: nothing is forwarded to it any more.
    if (r.dialedBySelf && r.url && !this.stopping) {
      const d = this.dialers.get(r.url);
      if (d) this.scheduleDial(d);
    }
  }
}

function listenOn(server: net.Server, port: number, host: string): Promise<net.AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address() as net.AddressInfo);
    });
  });
}
