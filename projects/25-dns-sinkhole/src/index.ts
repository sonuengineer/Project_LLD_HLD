export { BlockList, loadBlockListFile, parseBlockListText } from "./blocklist.js";
export { ResponseCache, type ResponseCacheOptions } from "./cache.js";
export { ManualClock, systemClock, type Clock } from "./clock.js";
export { SinkholeProxy, type BlockMode, type ProxyStats, type SinkholeProxyOptions } from "./proxy.js";
export { SinkholeServer, isLoopback, type SinkholeServerOptions } from "./server.js";
export { StubUpstream, type StubBehavior, type StubCall, type StubUpstreamOptions } from "./stub-upstream.js";
export { TimeoutError, TransportError, forwardQuery, frameTcp, type Endpoint, type ForwardOptions } from "./transport.js";
export {
  CLASS_IN,
  OPCODE_QUERY,
  RCODE,
  TYPE,
  WireError,
  buildQuery,
  canonicalName,
  decodeHeader,
  decodeQuery,
  decodeResponse,
  encodeARecord,
  encodeMessage,
  type AnswerMeta,
  type DecodedQuery,
  type DecodedResponse,
  type Header,
  type Question,
} from "./wire.js";
