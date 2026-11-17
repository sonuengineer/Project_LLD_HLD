-- Sliding window LOG (exact). Every accepted request is a member of a sorted set
-- scored by its timestamp. Memory = O(limit) per identity.
-- KEYS[1] = zset key
-- ARGV[1] = limit, ARGV[2] = window_ms, ARGV[3] = now_ms ('' => Redis TIME), ARGV[4] = cost, ARGV[5] = unique request id
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

-- Drop everything that slid out of the window.
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])

if count + cost > limit then
  -- Earliest moment a slot frees up = oldest entry + window.
  local retry = window
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if oldest[2] then
    retry = math.max(tonumber(oldest[2]) + window - now, 1)
  end
  return {0, math.max(limit - count, 0), retry, retry}
end

for i = 1, cost do
  redis.call('ZADD', KEYS[1], now, ARGV[5] .. ':' .. i)
end
redis.call('PEXPIRE', KEYS[1], window)
return {1, limit - count - cost, 0, window}
