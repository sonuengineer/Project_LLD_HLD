-- Long-running job heartbeat: push the visibility deadline forward. Token-checked.
-- KEYS[1]=active  ARGV: 1 prefix, 2 job_id, 3 token, 4 extend_ms, 5 now_ms
local now
if ARGV[5] == '' then local t = redis.call('TIME'); now = t[1]*1000 + math.floor(t[2]/1000) else now = tonumber(ARGV[5]) end
local jk = ARGV[1] .. 'job:' .. ARGV[2]
local s = redis.call('HMGET', jk, 'status', 'attempts')
if s[1] ~= 'active' or s[2] ~= ARGV[3] then return 0 end
local deadline = now + tonumber(ARGV[4])
redis.call('HSET', jk, 'lease_until', deadline)
redis.call('ZADD', KEYS[1], deadline, ARGV[2])
return deadline
