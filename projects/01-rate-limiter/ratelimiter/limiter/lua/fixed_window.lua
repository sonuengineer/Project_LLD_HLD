-- Fixed window counter.
-- KEYS[1] = base key (e.g. rl:{policy}:{identity})
-- ARGV[1] = limit, ARGV[2] = window_ms, ARGV[3] = now_ms ('' => use Redis TIME), ARGV[4] = cost
-- Returns {allowed, remaining, retry_after_ms, reset_ms}
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[4])
local now
if ARGV[3] == '' then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
else
  now = tonumber(ARGV[3])
end

local window_start = now - (now % window)
local key = KEYS[1] .. ':' .. window_start
local reset_ms = window_start + window - now

local current = tonumber(redis.call('GET', key) or '0')
if current + cost > limit then
  -- Rejected requests are NOT counted, so a client that backs off is not punished.
  return {0, math.max(limit - current, 0), reset_ms, reset_ms}
end
current = redis.call('INCRBY', key, cost)
if current == cost then
  redis.call('PEXPIRE', key, window)
end
return {1, limit - current, 0, reset_ms}
