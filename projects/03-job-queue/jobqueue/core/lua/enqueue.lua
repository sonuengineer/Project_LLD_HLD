-- KEYS[1]=ready zset  KEYS[2]=delayed zset  KEYS[3]=stats hash  KEYS[4]=idempotency key ('' allowed)
-- ARGV: 1 prefix, 2 job_id, 3 job json fields (flat k,v list encoded as cjson array), 4 priority,
--       5 run_at_ms ('' = now), 6 now_ms ('' = TIME), 7 idem_ttl_s
-- Returns {job_id, created(1/0)}
local now
if ARGV[6] == '' then local t = redis.call('TIME'); now = t[1]*1000 + math.floor(t[2]/1000) else now = tonumber(ARGV[6]) end

if KEYS[4] ~= '' then
  local existing = redis.call('GET', KEYS[4])
  if existing then return {existing, 0} end   -- same idempotency key -> same job, nothing enqueued
  redis.call('SET', KEYS[4], ARGV[2], 'EX', tonumber(ARGV[7]))
end

local jobkey = ARGV[1] .. 'job:' .. ARGV[2]
local fields = cjson.decode(ARGV[3])
redis.call('HSET', jobkey, unpack(fields))
redis.call('HSET', jobkey, 'created_at', now, 'attempts', 0)

local run_at = now
if ARGV[5] ~= '' then run_at = tonumber(ARGV[5]) end
if run_at > now then
  redis.call('HSET', jobkey, 'status', 'delayed', 'run_at', run_at)
  redis.call('ZADD', KEYS[2], run_at, ARGV[2])
else
  local seq = redis.call('INCR', ARGV[1] .. 'seq')
  redis.call('HSET', jobkey, 'status', 'queued', 'run_at', now)
  redis.call('ZADD', KEYS[1], (9 - tonumber(ARGV[4])) * 1e13 + seq, ARGV[2])
end
redis.call('HINCRBY', KEYS[3], 'enqueued', 1)
return {ARGV[2], 1}
