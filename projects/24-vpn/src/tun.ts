// The app-facing side of a (simulated) network interface. A real VPN hands the OS a TUN device: the kernel
// routes packets destined for the VPN's subnet into it, the VPN process reads them, encrypts, and ships them
// out over a real socket -- and the reverse on receive. That needs a kernel device and root/admin, neither of
// which exists in this environment or is built here (see README.md's "Known and NOT handled").
//
// TunDevice is the app's view of that interface, reduced to exactly the two operations stage 1 needs:
// `send` (the app hands a packet to go out through the tunnel) and `onReceive` (the app is told about a
// packet that arrived through the tunnel). InMemoryTunDevice also exposes a second, "engine" side -- `onSend`
// and `deliver` -- that is NOT part of the TunDevice interface itself; it is what transport.ts (the thing that
// actually owns the encrypt/UDP-send/decrypt pipeline) hooks into to drive the interface from both ends.
export interface TunDevice {
  send(packet: Buffer): void;
  onReceive(callback: (packet: Buffer) => void): void;
}

export class InMemoryTunDevice implements TunDevice {
  private readonly receiveCallbacks: Array<(packet: Buffer) => void> = [];
  private readonly sendCallbacks: Array<(packet: Buffer) => void> = [];

  // App side.
  send(packet: Buffer): void {
    for (const cb of this.sendCallbacks) cb(packet);
  }

  onReceive(callback: (packet: Buffer) => void): void {
    this.receiveCallbacks.push(callback);
  }

  // Engine side: observes every packet the app writes with send(), so it can be encrypted and transmitted.
  onSend(callback: (packet: Buffer) => void): void {
    this.sendCallbacks.push(callback);
  }

  // Engine side: injects a packet that arrived (decrypted, authenticated) from the remote peer, delivering it
  // to every onReceive() subscriber.
  deliver(packet: Buffer): void {
    for (const cb of this.receiveCallbacks) cb(packet);
  }
}
