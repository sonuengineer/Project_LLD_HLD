-- Failure of an attempt: retry with backoff, or move to the dead letter queue.
-- Used both by workers (handler raised / timed out) and by the reaper (lease expired).
-- KEYS[1]=active KEYS[2]=delayed KEYS[3]=dead KEYS[4]=stats
-- ARGV: 1 prefix, 2 job_id, 3 token ('' = reaper: no token check, but must still be active+expired),
--       4 error text, 5 retry_delay_ms, 6 now_ms, 7 reason ('error'|'timeout'|'lease_expired'|'permanent'),
--       8 force_dead ('1' = non-retryable error: skip remaining attempts)
-- Returns 'retry' | 'dead' | 'stale'
local now
if ARGV[6] == '' then local t = redis.call('TIME'); now = t[1]*1000 + math.floor(t[2]/1000) else now = tonumber(ARGV[6]) end
local jk = ARGV[1] .. 'job:' .. ARGV[2]
local s = redis.call('HMGET', jk, 'status', 'attempts', 'max_attempts', 'lease_until')
if s[1] ~= 'active' then return 'stale' end
if ARGV[3] ~= '' and s[2] ~= ARGV[3] then return 'stale' end
if ARGV[3] == '' and tonumber(s[4] or '0') > now then return 'stale' end  -- reaper raced with a lease extension

redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('HDEL', jk, 'lease_until')
redis.call('HSET', jk, 'last_error', ARGV[4], 'last_failure_reason', ARGV[7], 'last_failed_at', now)
redis.call('RPUSH', jk .. ':errors', cjson.encode({attempt = tonumber(s[2]), at = now, reason = ARGV[7], error = ARGV[4]}))
redis.call('LTRIM', jk .. ':errors', -20, -1)

if ARGV[8] ~= '1' and tonumber(s[2]) < tonumber(s[3]) then
  local run_at = now + tonumber(ARGV[5])
  redis.call('HSET', jk, 'status', 'delayed', 'run_at', run_at)
  redis.call('ZADD', KEYS[2], run_at, ARGV[2])
  redis.call('HINCRBY', KEYS[4], 'retried', 1)
  if ARGV[7] == 'lease_expired' then redis.call('HINCRBY', KEYS[4], 'reaped', 1) end
  return 'retry'
end
redis.call('HSET', jk, 'status', 'dead', 'finished_at', now)
redis.call('ZADD', KEYS[3], now, ARGV[2])
redis.call('HINCRBY', KEYS[4], 'dead', 1)
if ARGV[7] == 'lease_expired' then redis.call('HINCRBY', KEYS[4], 'reaped', 1) end
return 'dead'
