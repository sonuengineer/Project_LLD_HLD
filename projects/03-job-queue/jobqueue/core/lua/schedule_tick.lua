-- Recurring schedules. Compare-and-advance makes it safe to run on every worker:
-- only the caller that sees next_run <= now AND moves it forward gets to enqueue.
-- KEYS[1]=schedules hash  ARGV: 1 name, 2 now_ms
-- Returns the schedule json if THIS caller must enqueue a run, else nil.
local now
if ARGV[2] == '' then local t = redis.call('TIME'); now = t[1]*1000 + math.floor(t[2]/1000) else now = tonumber(ARGV[2]) end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return nil end
local s = cjson.decode(raw)
if tonumber(s.next_run_ms) > now then return nil end
-- Skip missed runs instead of firing a burst after downtime (documented choice).
local interval = tonumber(s.interval_ms)
local next_run = tonumber(s.next_run_ms)
-- O(1) catch-up (a loop over every missed interval could run for a long time inside Redis after
-- a long downtime with a small interval, blocking every other client).
next_run = next_run + (math.floor((now - next_run) / interval) + 1) * interval
s.next_run_ms = next_run
s.last_fired_ms = now
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(s))
return raw
