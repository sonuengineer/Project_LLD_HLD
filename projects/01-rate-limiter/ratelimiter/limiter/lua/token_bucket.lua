-- Token bucket. Bucket holds up to `capacity` tokens and refills at `rate` tokens/sec.
-- Allows bursts up to capacity, then a steady `rate`.
-- KEYS[1] = hash key {tokens, ts}
-- ARGV[1] = capacity, ARGV[2] = refill_per_sec, ARGV[3] = now_ms ('' => Redis TIME), ARGV[4] = cost
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[4])
local now
if ARGV[3] == '' then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
else
  now = tonumber(ARGV[3])
end

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity   -- new identity starts with a full bucket
  ts = now
end

-- Lazy refill: we never run a timer, we just compute how much would have dripped in.
local elapsed = math.max(now - ts, 0)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) * 1000 / rate)
end

-- Store state with full precision (tostring keeps the fraction).
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
-- After capacity/rate seconds the bucket is full again, so state can be dropped.
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)

local reset = math.ceil((capacity - tokens) * 1000 / rate)
return {allowed, math.floor(tokens), retry, reset}
