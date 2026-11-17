-- Atomically: promote due delayed jobs -> pop highest-priority ready job -> lease it.
-- KEYS[1]=ready KEYS[2]=delayed KEYS[3]=active
-- ARGV: 1 prefix, 2 worker_id, 3 now_ms ('' = TIME), 4 max_promote, 5 max_lease_ms, 6 max_jobs
-- Returns a list of {job_id, attempt(=fencing token), lease_deadline_ms, {flat job hash}}
-- (batch claim + hash inline = 1 round trip for up to max_jobs jobs)
local now
if ARGV[3] == '' then local t = redis.call('TIME'); now = t[1]*1000 + math.floor(t[2]/1000) else now = tonumber(ARGV[3]) end
local prefix = ARGV[1]

-- 1) delayed -> ready (bounded so one call never blocks Redis for long)
local due = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, tonumber(ARGV[4]))
for _, id in ipairs(due) do
  redis.call('ZREM', KEYS[2], id)
  local jk = prefix .. 'job:' .. id
  local pri = tonumber(redis.call('HGET', jk, 'priority')) or 5
  local seq = redis.call('INCR', prefix .. 'seq')
  redis.call('HSET', jk, 'status', 'queued')
  redis.call('ZADD', KEYS[1], (9 - pri) * 1e13 + seq, id)
end

-- 2) pop up to max_jobs best ready jobs (lowest score = highest priority, then FIFO) and lease them.
--    Lease is capped at max_lease_ms: a 1h job gets a ~35s lease that the worker keeps extending
--    while alive, so a crashed worker is detected in ~35s, not 1h.
local out = {}
for _ = 1, tonumber(ARGV[6]) do
  local popped = redis.call('ZPOPMIN', KEYS[1])
  if #popped == 0 then break end
  local id = popped[1]
  local jk = prefix .. 'job:' .. id
  if redis.call('EXISTS', jk) == 1 then   -- job hash expired/deleted: skip it
    -- Defensive parsing: a script that errors AFTER ZPOPMIN would lose the job, because Redis does
    -- not roll back writes a script already made. Fall back to defaults instead of raising.
    local timeout_ms = tonumber(redis.call('HGET', jk, 'timeout_ms')) or 30000
    local grace_ms = tonumber(redis.call('HGET', jk, 'lease_grace_ms')) or 5000
    local lease_ms = math.min(timeout_ms, tonumber(ARGV[5])) + grace_ms
    local attempt = redis.call('HINCRBY', jk, 'attempts', 1)
    local deadline = now + lease_ms
    redis.call('HSET', jk, 'status', 'active', 'worker', ARGV[2], 'started_at', now, 'lease_until', deadline)
    redis.call('ZADD', KEYS[3], deadline, id)
    out[#out + 1] = {id, attempt, deadline, redis.call('HGETALL', jk)}
  end
end
return out
