-- Mark success. Fencing: only the CURRENT lease holder (attempt == token) may ack.
-- KEYS[1]=active KEYS[2]=completed zset KEYS[3]=stats
-- ARGV: 1 prefix, 2 job_id, 3 token(attempt), 4 result json, 5 now_ms, 6 retention_s, 7 completed_cap
local now
if ARGV[5] == '' then local t = redis.call('TIME'); now = t[1]*1000 + math.floor(t[2]/1000) else now = tonumber(ARGV[5]) end
local jk = ARGV[1] .. 'job:' .. ARGV[2]
local state = redis.call('HMGET', jk, 'status', 'attempts')
if state[1] ~= 'active' or state[2] ~= ARGV[3] then
  return 0   -- stale: lease expired and the job was re-delivered (or already finished)
end
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('HSET', jk, 'status', 'succeeded', 'result', ARGV[4], 'finished_at', now)
redis.call('HDEL', jk, 'lease_until')
redis.call('EXPIRE', jk, tonumber(ARGV[6]))
redis.call('EXPIRE', jk .. ':errors', tonumber(ARGV[6]))  -- error history expires with the job
redis.call('ZADD', KEYS[2], now, ARGV[2])
redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -tonumber(ARGV[7]) - 1)  -- keep only the newest N ids
redis.call('HINCRBY', KEYS[3], 'succeeded', 1)
return 1
