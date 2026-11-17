-- Manual replay from the DLQ (after the bug is fixed). Resets attempts.
-- KEYS[1]=dead KEYS[2]=ready KEYS[3]=stats  ARGV: 1 prefix, 2 job_id
local jk = ARGV[1] .. 'job:' .. ARGV[2]
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
local pri = tonumber(redis.call('HGET', jk, 'priority') or '5')
local seq = redis.call('INCR', ARGV[1] .. 'seq')
redis.call('HSET', jk, 'status', 'queued', 'attempts', 0)
redis.call('HDEL', jk, 'finished_at')
redis.call('ZADD', KEYS[2], (9 - pri) * 1e13 + seq, ARGV[2])
redis.call('HINCRBY', KEYS[3], 'requeued_from_dlq', 1)
return 1
