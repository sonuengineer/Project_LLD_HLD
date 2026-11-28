// A Session is the symmetric state that exists once a handshake has completed: two one-way keys (one to
// encrypt with, one to decrypt with -- a sender's "send" key is the receiver's "recv" key, never the same key
// used in both directions, so the two directions never share a nonce space), a send counter, and the receive
// side's anti-replay window. Everything here is local, in-memory state -- nothing in this class touches the
// network.
import { aeadDecrypt, aeadEncrypt } from "./crypto-utils.js";
import { AntiReplayWindow } from "./replay-window.js";
import { counterNonce, encodeTransportData, transportAad } from "./wire.js";

export type DecryptRejection = "REPLAY" | "TOO_OLD" | "AUTH_FAILED";
export type SessionDecryptResult = { ok: true; payload: Buffer } | { ok: false; reason: DecryptRejection };

export class Session {
  // myReceiverId: the value the OTHER side must stamp on packets addressed to this session (chosen by this
  // side, during the handshake, so the receiver -- not the sender -- picks its own lookup key).
  // peerReceiverId: the value this side must stamp when sending TO the other side (the id the other side chose).
  constructor(
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
    readonly myReceiverId: number,
    readonly peerReceiverId: number,
  ) {}

  private sendCounter = 0;
  private readonly window = new AntiReplayWindow();

  // Builds a ready-to-send TRANSPORT_DATA packet, consuming the next counter. Never reuses a counter for this
  // session's lifetime -- the counter only ever goes up, which is exactly what the nonce rule requires.
  encrypt(payload: Buffer): Buffer {
    const counter = this.sendCounter++;
    const aad = transportAad(this.peerReceiverId, counter);
    const { ciphertext, tag } = aeadEncrypt(this.sendKey, counterNonce(counter), payload, aad);
    return encodeTransportData({ receiverId: this.peerReceiverId, counter, ciphertext, tag });
  }

  // Decrypts an already-demultiplexed TRANSPORT_DATA payload (the caller, peer.ts, looked up this exact
  // session by receiverId before calling in). Order matters: the anti-replay check runs BEFORE decryption (a
  // cheap rejection of an obviously bad counter, without paying for an AEAD call), and the counter is recorded
  // as seen only AFTER the AEAD tag verifies -- see replay-window.ts's record() for why that order is load-
  // bearing, not cosmetic.
  decrypt(counter: number, ciphertext: Buffer, tag: Buffer, aad: Buffer): SessionDecryptResult {
    const check = this.window.check(counter);
    if (check !== "ACCEPT") return { ok: false, reason: check };
    let payload: Buffer;
    try {
      payload = aeadDecrypt(this.recvKey, counterNonce(counter), ciphertext, tag, aad);
    } catch {
      return { ok: false, reason: "AUTH_FAILED" };
    }
    this.window.record(counter);
    return { ok: true, payload };
  }
}
