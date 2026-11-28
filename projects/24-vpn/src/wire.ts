// The on-the-wire byte layout for the three message types this protocol sends over UDP, plus the AAD each
// AEAD call binds itself to. Every decode function throws on anything that is not exactly the right shape --
// callers that must never crash on untrusted bytes (peer.ts's receive-side methods) catch that and turn it
// into a typed rejection; callers that build outgoing bytes from local, trusted inputs let it throw.
//
//   HANDSHAKE_INIT     [type:1][initiatorReceiverId:4][ephemeralPub:32][ciphertext:32][tag:16]   = 85 bytes
//   HANDSHAKE_RESPONSE [type:1][responderReceiverId:4][initiatorReceiverId:4][ephemeralPub:32][tag:16] = 57 bytes
//   TRANSPORT_DATA     [type:1][receiverId:4][counter:8][ciphertext:N][tag:16]                    >= 29 bytes
//
// ciphertext2 (the handshake response's encrypted payload) is empty on purpose -- message 2 carries no data,
// only proof both sides derived the same key, so its ciphertext has zero length and is omitted from the layout.

export const MessageType = {
  HANDSHAKE_INIT: 1,
  HANDSHAKE_RESPONSE: 2,
  TRANSPORT_DATA: 3,
} as const;

const STATIC_KEY_LEN = 32;
const EPHEMERAL_KEY_LEN = 32;

function uint32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function readUint32be(b: Buffer, offset: number): number {
  return b.readUInt32BE(offset);
}

function uint64be(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n), 0);
  return b;
}

function readUint64be(b: Buffer, offset: number): number {
  return Number(b.readBigUInt64BE(offset));
}

export interface HandshakeInitWire {
  initiatorReceiverId: number;
  ephemeralPub: Buffer;
  ciphertext: Buffer; // encrypts the initiator's static public key (32 bytes)
  tag: Buffer;
}

export function handshakeInitAad(initiatorReceiverId: number, ephemeralPub: Buffer): Buffer {
  return Buffer.concat([uint32be(initiatorReceiverId), ephemeralPub]);
}

export function encodeHandshakeInit(fields: HandshakeInitWire): Buffer {
  return Buffer.concat([
    Buffer.from([MessageType.HANDSHAKE_INIT]),
    uint32be(fields.initiatorReceiverId),
    fields.ephemeralPub,
    fields.ciphertext,
    fields.tag,
  ]);
}

const HANDSHAKE_INIT_LEN = 1 + 4 + EPHEMERAL_KEY_LEN + STATIC_KEY_LEN + 16;

export function decodeHandshakeInit(data: Buffer): HandshakeInitWire {
  if (data.length !== HANDSHAKE_INIT_LEN || data[0] !== MessageType.HANDSHAKE_INIT) {
    throw new Error("not a well-formed HANDSHAKE_INIT message");
  }
  let o = 1;
  const initiatorReceiverId = readUint32be(data, o);
  o += 4;
  const ephemeralPub = data.subarray(o, o + EPHEMERAL_KEY_LEN);
  o += EPHEMERAL_KEY_LEN;
  const ciphertext = data.subarray(o, o + STATIC_KEY_LEN);
  o += STATIC_KEY_LEN;
  const tag = data.subarray(o, o + 16);
  return { initiatorReceiverId, ephemeralPub, ciphertext, tag };
}

export interface HandshakeResponseWire {
  responderReceiverId: number;
  initiatorReceiverId: number; // echoed back so the initiator can find its pending handshake without needing
  // the sender's address -- the same role a correlation id plays in any request/response protocol
  ephemeralPub: Buffer;
  tag: Buffer;
}

export function handshakeResponseAad(responderReceiverId: number, initiatorReceiverId: number, ephemeralPub: Buffer): Buffer {
  return Buffer.concat([uint32be(responderReceiverId), uint32be(initiatorReceiverId), ephemeralPub]);
}

export function encodeHandshakeResponse(fields: HandshakeResponseWire): Buffer {
  return Buffer.concat([
    Buffer.from([MessageType.HANDSHAKE_RESPONSE]),
    uint32be(fields.responderReceiverId),
    uint32be(fields.initiatorReceiverId),
    fields.ephemeralPub,
    fields.tag,
  ]);
}

const HANDSHAKE_RESPONSE_LEN = 1 + 4 + 4 + EPHEMERAL_KEY_LEN + 16;

export function decodeHandshakeResponse(data: Buffer): HandshakeResponseWire {
  if (data.length !== HANDSHAKE_RESPONSE_LEN || data[0] !== MessageType.HANDSHAKE_RESPONSE) {
    throw new Error("not a well-formed HANDSHAKE_RESPONSE message");
  }
  let o = 1;
  const responderReceiverId = readUint32be(data, o);
  o += 4;
  const initiatorReceiverId = readUint32be(data, o);
  o += 4;
  const ephemeralPub = data.subarray(o, o + EPHEMERAL_KEY_LEN);
  o += EPHEMERAL_KEY_LEN;
  const tag = data.subarray(o, o + 16);
  return { responderReceiverId, initiatorReceiverId, ephemeralPub, tag };
}

export interface TransportDataWire {
  receiverId: number;
  counter: number;
  ciphertext: Buffer;
  tag: Buffer;
}

export function transportAad(receiverId: number, counter: number): Buffer {
  return Buffer.concat([uint32be(receiverId), uint64be(counter)]);
}

export function counterNonce(counter: number): Buffer {
  // 12-byte ChaCha20-Poly1305 nonce: 4 zero bytes + an 8-byte big-endian counter. The counter is never reused
  // for a given key (it is assigned by incrementing a per-session send counter -- see session.ts), which is
  // the one hard rule a stream cipher nonce must follow.
  return Buffer.concat([Buffer.alloc(4), uint64be(counter)]);
}

export function encodeTransportData(fields: TransportDataWire): Buffer {
  return Buffer.concat([
    Buffer.from([MessageType.TRANSPORT_DATA]),
    uint32be(fields.receiverId),
    uint64be(fields.counter),
    fields.ciphertext,
    fields.tag,
  ]);
}

const TRANSPORT_DATA_HEADER_LEN = 1 + 4 + 8;

export function decodeTransportData(data: Buffer): TransportDataWire {
  if (data.length < TRANSPORT_DATA_HEADER_LEN + 16 || data[0] !== MessageType.TRANSPORT_DATA) {
    throw new Error("not a well-formed TRANSPORT_DATA message");
  }
  const receiverId = readUint32be(data, 1);
  const counter = readUint64be(data, 5);
  const ciphertext = data.subarray(TRANSPORT_DATA_HEADER_LEN, data.length - 16);
  const tag = data.subarray(data.length - 16);
  return { receiverId, counter, ciphertext, tag };
}

export function peekMessageType(data: Buffer): number | undefined {
  return data.length > 0 ? data[0] : undefined;
}
