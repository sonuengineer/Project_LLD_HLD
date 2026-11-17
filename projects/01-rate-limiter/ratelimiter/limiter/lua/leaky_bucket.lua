-- Leaky bucket ("as a meter"). Each request pours `cost` units of water in; the bucket
-- leaks at a constant `leak_per_sec`. If the water would overflow `capacity`, reject.
-- Unlike token bucket this enforces a smooth output rate; burst tolerance = capacity.
-- (The "leaky bucket as a queue" variant delays requests instead of rejecting; see docs.)
-- KEYS[1] = hash key {level, ts}
-- ARGV[1] = capacity, ARGV[2] = leak_per_sec, ARGV[3] = now_ms ('' => Redis TIME), ARGV[4] = cost
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

local state = redis.call('HMGET', KEYS[1], 'level', 'ts')
local level = tonumber(state[1]) or 0
local ts = tonumber(state[2]) or now

local elapsed = math.max(now - ts, 0)
level = math.max(0, level - elapsed * rate / 1000)

local allowed = 0
local retry = 0
if level + cost <= capacity then
  level = level + cost
  allowed = 1
else
  retry = math.ceil((level + cost - capacity) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'level', tostring(level), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)

local reset = math.ceil(level * 1000 / rate)
return {allowed, math.floor(capacity - level), retry, reset}
