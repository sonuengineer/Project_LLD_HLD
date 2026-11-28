// VpnNode wires a Peer (pure protocol state machine) to a real node:dgram UDP socket and an InMemoryTunDevice,
// so the full path -- app writes a packet -> encrypt -> real UDP send on 127.0.0.1 -> the other peer's real
// UDP socket receives -> decrypt -> delivered to ITS TunDevice -- is exercised end to end without a kernel
// device. This is the "transport" half the project description asks for; peer.ts has no idea any of this
// networking exists.
//
// Deliberately scoped to ONE active remote peer per node ("point-to-point", per the project brief): a Peer
// can know about and trust several named peers at once (useful at the protocol-test level), but a VpnNode's
// outbound app traffic (tun.send()) always goes to whichever peer its handshake most recently completed with.
import * as dgram from "node:dgram";
import type { AddressInfo } from "node:net";
import { VpnError } from "./errors.js";
import type { Peer } from "./peer.js";
import { InMemoryTunDevice } from "./tun.js";
import { MessageType, peekMessageType } from "./wire.js";

interface Address {
  host: string;
  port: number;
}

export class VpnNode {
  readonly tun: InMemoryTunDevice;
  private readonly socket: dgram.Socket;
  private readonly remotes = new Map<string, Address>(); // peerName -> where to send packets for it
  private readonly pendingConnects = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  private readonly droppedCallbacks: Array<(reason: string) => void> = [];
  private rekeyTimer: NodeJS.Timeout | undefined;
  activePeerName: string | undefined;

  constructor(private readonly peer: Peer, tun: InMemoryTunDevice = new InMemoryTunDevice()) {
    this.tun = tun;
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (data, rinfo) => this.handleMessage(data, { host: rinfo.address, port: rinfo.port }));
    this.tun.onSend((packet) => this.handleAppSend(packet));
  }

  bind(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.socket.once("error", onError);
      this.socket.bind(port, host, () => {
        this.socket.removeListener("error", onError);
        resolve((this.socket.address() as AddressInfo).port);
      });
    });
  }

  setRemote(peerName: string, host: string, port: number): void {
    this.remotes.set(peerName, { host, port });
  }

  // Initiator side: send a HANDSHAKE_INIT to `peerName` at host:port and resolve once a valid response
  // installs the session (or reject on timeout / rejection). `timeoutMs` is a real-time safety net against a
  // genuinely hung handshake (e.g. the other side never answers) -- it is not something any test relies on
  // the TIMING of; every test here either completes well within it or expects an explicit rejection instead.
  connect(peerName: string, host: string, port: number, timeoutMs = 3000): Promise<void> {
    this.setRemote(peerName, host, port);
    const message = this.peer.initiateHandshake(peerName);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConnects.delete(peerName);
        reject(new Error(`handshake with "${peerName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingConnects.set(peerName, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.send(message, port, host);
    });
  }

  // Sends already-built wire bytes to `peerName`'s known address. Used internally for every normal send, and
  // exposed so tests/demo can inject a deliberately tampered or duplicated packet at the wire level.
  sendRawTo(peerName: string, buffer: Buffer): void {
    const remote = this.remotes.get(peerName);
    if (!remote) throw new VpnError("UNKNOWN_PEER", `no known address for "${peerName}" (never connected or received from them)`);
    this.socket.send(buffer, remote.port, remote.host);
  }

  onDropped(callback: (reason: string) => void): void {
    this.droppedCallbacks.push(callback);
  }

  // Stage 2: periodic rekey housekeeping. Asks the Peer (via Peer.checkRekey, which wraps whatever Clock it
  // was built with) which peers this node is the original initiator for have aged past their configured
  // rekey threshold, and for each one, starts a brand new handshake toward that peer's already-known
  // address -- exactly like connect() does for a first handshake, minus the Promise/timeout bookkeeping,
  // since nothing here is waiting on the result (the existing HANDSHAKE_RESPONSE path in handleMessage()
  // installs the new session the same way it always does; there is nothing rekey-specific left for this
  // method to do once the bytes are on the wire). The OLD session is untouched by this call either way -- see
  // peer.ts / PLAN.md's "Stage 2 decisions" for exactly how it stays usable through the whole transition.
  //
  // No timer lives inside this method itself -- call it directly (e.g. right after ManualClock.advance() in
  // a test) or via startRekeyTimer() for a real wall-clock interval, same "inject the driver" rule the rest
  // of this project's time-based logic follows.
  checkRekey(now?: number): void {
    const due = this.peer.checkRekey(now);
    for (const { peerName } of due) {
      const remote = this.remotes.get(peerName);
      if (!remote) continue; // can't happen for an established session, but a housekeeping tick should never throw over it
      const message = this.peer.initiateHandshake(peerName);
      this.socket.send(message, remote.port, remote.host);
    }
  }

  // Convenience for real usage (see demo.ts): drives checkRekey() on a real wall-clock interval. Tests call
  // checkRekey() directly instead, so a ManualClock advance takes effect immediately rather than waiting on
  // a real timer tick.
  startRekeyTimer(intervalMs = 1000): void {
    this.stopRekeyTimer();
    this.rekeyTimer = setInterval(() => this.checkRekey(), intervalMs);
  }

  stopRekeyTimer(): void {
    if (this.rekeyTimer) {
      clearInterval(this.rekeyTimer);
      this.rekeyTimer = undefined;
    }
  }

  close(): Promise<void> {
    this.stopRekeyTimer();
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }

  private handleAppSend(packet: Buffer): void {
    if (!this.activePeerName) {
      this.emitDropped("outbound packet dropped: no established session yet");
      return;
    }
    const wire = this.peer.encryptPacket(this.activePeerName, packet);
    this.sendRawTo(this.activePeerName, wire);
  }

  private handleMessage(data: Buffer, from: Address): void {
    const type = peekMessageType(data);
    if (type === MessageType.HANDSHAKE_INIT) {
      const result = this.peer.receiveHandshakeInit(data);
      if (!result.ok) {
        this.emitDropped(`handshake init rejected: ${result.reason}`);
        return;
      }
      this.remotes.set(result.peerName, from);
      this.activePeerName ??= result.peerName;
      this.socket.send(result.response, from.port, from.host);
    } else if (type === MessageType.HANDSHAKE_RESPONSE) {
      const result = this.peer.receiveHandshakeResponse(data);
      if (!result.ok) {
        this.emitDropped(`handshake response rejected: ${result.reason}`);
        return;
      }
      this.remotes.set(result.peerName, from);
      this.activePeerName ??= result.peerName;
      const waiter = this.pendingConnects.get(result.peerName);
      if (waiter) {
        this.pendingConnects.delete(result.peerName);
        waiter.resolve();
      }
    } else if (type === MessageType.TRANSPORT_DATA) {
      const result = this.peer.decryptPacket(data);
      if (!result.ok) {
        this.emitDropped(`transport packet dropped: ${result.reason}`);
        return;
      }
      this.tun.deliver(result.payload);
    } else {
      this.emitDropped("unrecognized message type");
    }
  }

  private emitDropped(reason: string): void {
    for (const cb of this.droppedCallbacks) cb(reason);
  }
}
