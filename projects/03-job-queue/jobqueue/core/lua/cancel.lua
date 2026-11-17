-- Cancel a job that has not started. KEYS[1]=ready KEYS[2]=delayed ARGV: 1 prefix, 2 job_id, 3 retention_s
local jk = ARGV[1] .. 'job:' .. ARGV[2]
local removed = redis.call('ZREM', KEYS[1], ARGV[2]) + redis.call('ZREM', KEYS[2], ARGV[2])
if removed == 0 then return 0 end
redis.call('HSET', jk, 'status', 'cancelled')
redis.call('EXPIRE', jk, tonumber(ARGV[3]))
return 1
