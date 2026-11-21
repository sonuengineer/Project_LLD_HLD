# A6 -- DNS resolver, written by hand

A recursive DNS resolver in TypeScript on Node's `dgram` and `net` modules, with **zero runtime dependencies** and
without `node:dns`.

Status (2026-11-21): **stages 1-3 of 4 done** -- wire format, iterative resolution, cache and stub server. The full write-up (tables, mutation checks) comes with stage 4.

## Stage 1: wire format (`src/wire.ts`)

| Rule | Where | Proven by (`test/wire.test.ts`) |
|---|---|---|
| Header flags QR, opcode, AA, TC, RD, RA, rcode on the right bits | `readHeader`, `encodeMessage` | "header flags are on the right bits" |
| A, AAAA, NS, CNAME, SOA, MX, TXT, PTR decoded and encoded; unknown types kept as raw rdata | `readRData`, `writeRData` | round-trip tests |
| Compression on encode (longest known suffix becomes a pointer, case-insensitive, only for offsets < 0x4000) | `Writer.name` | "encoding compresses repeated suffixes" |
| Compression on decode, RFC 1035 4.1.4 example | `readName` | "decodes the RFC 1035 4.1.4 example" |
| Loop protection: a pointer must point strictly before the labels being read | `readName` | self-pointer, A -> B -> A, forward pointer tests |
| At most 32 pointers per name | `readName`, `MAX_POINTER_JUMPS` | chain of 32 accepted, 33 rejected |
| Name <= 255 bytes, label <= 63, reserved label types rejected | `readName`, `nameToLabels` | limits tests |
| rdlength must match what the rdata uses (A = 4, AAAA = 16, names inside rdata stay inside it) | `readRData` | rdlength test |
| Every read is bounds checked; malformed input throws `WireError`, nothing else | `Reader` | truncation at every offset; 3000 random + 3000 bit-flipped packets |

## NOT implemented yet (honest list)

- Mutation checks and the full README (stage 4).
- EDNS(0), DNSSEC record types (they decode as raw rdata).
