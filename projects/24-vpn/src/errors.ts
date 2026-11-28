// One error class with a machine-readable code, same convention as the rest of this repo (see
// 22-messaging/src/errors.ts). These are all thrown by the SEND side of the API, which is driven by the local
// program, not the network -- calling it wrong is a programmer error, and "an error means nothing happened"
// applies: no session, counter or window state changes before one of these throws.
//
// The RECEIVE side (anything that parses bytes that arrived over the wire) never throws. A malformed, tampered
// or replayed packet from an untrusted network must be reported as a rejection, not an exception -- see the
// `*Result` discriminated unions in handshake.ts, session.ts and peer.ts.

export type VpnErrorCode =
  | "UNKNOWN_PEER" // peerName was never registered with trustPeer()
  | "NO_SESSION" // encryptPacket called before a handshake with that peer completed
  | "HANDSHAKE_IN_PROGRESS"; // initiateHandshake called again before the first attempt resolved or was abandoned

export class VpnError extends Error {
  constructor(
    readonly code: VpnErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VpnError";
  }
}
