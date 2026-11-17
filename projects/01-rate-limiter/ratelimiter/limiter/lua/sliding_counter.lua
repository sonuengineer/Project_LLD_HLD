-- Sliding window COUNTER (approximate, O(1) memory).
-- estimate = current_window_count + previous_window_count * (1 - elapsed_fraction)
-- This is the approach Cloudflare described publicly; error is small when traffic is smooth.
-- KEYS[1] = base key
-- ARGV[1] = limit, ARGV[2] = window_ms, ARGV[3] = now_ms ('' => Redis TIME), ARGV[4] = cost
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

local cur_start = now - (now % window)
local prev_start = cur_start - window
local cur_key = KEYS[1] .. ':' .. cur_start
local prev_key = KEYS[1] .. ':' .. prev_start

local cur = tonumber(redis.call('GET', cur_key) or '0')
local prev = tonumber(redis.call('GET', prev_key) or '0')
local elapsed = now - cur_start
local weight = (window - elapsed) / window
local estimated = cur + prev * weight

if estimated + cost > limit then
  -- Retry estimate: time until the previous window's weighted share drops enough.
  local retry = window - elapsed
  if prev > 0 then
    local needed = estimated + cost - limit          -- how much weighted count must disappear
    local ms = math.ceil(needed / prev * window)     -- prev contributes prev/window per ms
    if ms < retry then retry = ms end
  end
  return {0, math.max(math.floor(limit - estimated), 0), math.max(retry, 1), window - elapsed}
end

cur = redis.call('INCRBY', cur_key, cost)
-- Keep it for 2 windows: it is needed as "previous" during the next window.
redis.call('PEXPIRE', cur_key, window * 2)
return {1, math.max(math.floor(limit - (cur + prev * weight)), 0), 0, window - elapsed}
