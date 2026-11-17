# Learning Guide (Hinglish) -- minidis

Redis ko "black box cache" ki tarah use karna aur Redis ko andar se samajhna -- do alag levels hain.
Is project ke baad tum interviewer ko bata paoge ki SET command bhejne se disk tak kya kya hota hai.

## Step 1: TCP stream hai, messages nahi

File: `minidis/protocol.py::Parser`

TCP ek byte stream hai. Client ne 3 commands bheje toh server ko ek `read()` mein aadha command bhi
mil sakta hai, ya teeno ek saath. Isliye parser **incremental** hai: bytes buffer mein jodte jao, aur
command tabhi nikalo jab poora aa jaye.

```bash
../../.venv/Scripts/python -m pytest -q tests/test_protocol.py -k partial
```
Yeh test command ko ek-ek byte karke feed karta hai -- aakhri byte tak `None` milta hai.

RESP format yaad rakho: `*2\r\n$3\r\nGET\r\n$1\r\nk\r\n` = array of 2 bulk strings. Length pehle
aati hai, isliye value mein `\r\n` ho tab bhi koi dikkat nahi (binary safe).

## Step 2: RESP2 vs RESP3 (real bug se seekha)

redis-py 8 connect hote hi `HELLO 3` bhejta hai. Pehle minidis sirf RESP2 bolta tha, toh har
connection fail. RESP3 mein typed replies hain -- map (`%`), set (`~`), null (`_`). Humare commands
Python types return karte hain (dict, RespSet, None) aur `encode(value, proto)` client ke protocol
ke hisaab se wire format chunta hai. `HGETALL` RESP2 mein flat array, RESP3 mein map.

## Step 3: Single thread phir bhi atomic aur fast kaise?

File: `minidis/commands/__init__.py` (docstring), `server.py::Server.execute`

Har command handler normal (sync) function hai -- `await` nahi karta. asyncio event loop ek waqt pe
ek hi cheez chalata hai, toh do clients ke INCR kabhi interleave nahi ho sakte. Lock ki zaroorat hi
nahi. Proof:
```bash
../../.venv/Scripts/python -m pytest -q tests/test_concurrency.py -k incr
```
50 clients x 200 INCR = exactly 10000.

Kamzori bhi dekho: `test_slow_command_blocks_all_clients` -- `DEBUG SLEEP 0.3` chala toh doosre
client ka PING bhi 0.3s ruka. Isliye production Redis mein `KEYS *` mana hai.

## Step 4: Expiry -- lazy + active

File: `minidis/keyspace.py`

- **Lazy**: key access hui toh check karo expired hai kya. Sasta, lekin jo key koi padhta hi nahi
  woh memory mein padi rahegi.
- **Active**: har 100ms, 20 random volatile keys sample karo, expired delete karo; agar 25% se
  zyada expired nikli toh dobara karo. `test_active_expiry_removes_keys_nobody_reads` mein 1000 keys
  bina access ke saaf hoti hain.

Random sample O(1) mein kaise? `randomset.py` -- list + index map. Remove karte waqt last element ko
khali jagah pe swap karo. Yeh classic "insert/delete/getRandom O(1)" interview problem bhi hai.

## Step 5: Eviction -- memory full ho gayi toh

`maxmemory` set hai aur write aaya -> pehle memory free karo. Policies:
- `noeviction` -> OOM error (data loss nahi chahiye toh yeh).
- `allkeys-lru` -> sabse purani access wali key hatao (cache ke liye best).
- `volatile-lru` -> sirf TTL wali keys mein se, **sampling** se (Redis yahi karta hai: exact LRU
  ke liye har key pe linked list pointers lagenge, memory waste).

## Step 6: Persistence -- snapshot vs AOF

- Snapshot (`persistence/snapshot.py`): poore dataset ki photo. Restart fast, lekin last snapshot ke
  baad ka data gaya. File temp mein likho, fsync, phir `os.replace` -- crash ho toh purani file safe.
  CRC32 se corruption pakdo.
- AOF (`persistence/aof.py`): har write command log karo. `appendfsync` decide karta hai kitna data
  khona acceptable hai: `always` (kuch nahi), `everysec` (~1s), `no` (OS ki marzi).

Important trick: `SET k v EX 60` AOF mein `SET` + `PEXPIREAT <absolute ms>` banta hai. Warna kal
restart pe replay karoge toh key ko phir se fresh 60s mil jayenge (`test_aof_stores_absolute_expiry`).

Crash beech mein hua aur AOF ka last command aadha likha? `test_aof_truncated_tail_is_recovered` --
pehle ke saare commands apply, aadha wala kaat do.

AOF rewrite: 500 INCR = 500 lines, lekin state sirf `SET n 500`. Rewrite ke dauraan aaye naye
writes "rewrite buffer" mein jaate hain aur swap se pehle jode jaate hain.

## Step 7: Replication

Files: `replication.py`, `server.py::_serve_replica`

Replica `SYNC` bhejta hai -> master snapshot bhejta hai -> phir har write command stream karta hai.
Replica har second `REPLCONF ACK offset` bhejta hai, master `INFO` mein `lag_bytes` dikhata hai.

Do tests ne real bugs pakde:
1. Replica expired key ko apne aap delete nahi karta (master ke DEL ka wait karta hai). Lekin DEL
   aane pe bhi delete nahi ho raha tha -- memory leak. Fix `Keyspace.delete`.
2. BGSAVE ke baad dirty counter -1 ho gaya.

## Step 8: Benchmark se seekha (interview story)

`TESTING.md` padho. redis-benchmark se writes reads se 2-6x slow nikle. Hypothesis: replica ko har
command alag socket write. Test: replica band kiya -> SET 2x fast. Fix: replication stream ko batch
karke loop tick mein ek baar bhejo -> pipelined SET 11k se ~35k. Yeh "measure -> hypothesis ->
experiment -> fix -> re-measure" wala approach interview mein bahut strong lagta hai.

## Self-check

1. TCP pe ek read() mein aadha command aaya -- parser kya karega?
2. Single-threaded server mein INCR atomic kyun hai? Kab yeh guarantee toot sakti hai?
3. Lazy aur active expiry dono kyun chahiye?
4. Exact LRU vs sampled LRU -- Redis sampling kyun karta hai?
5. AOF everysec mein maximum kitna data loss? always mein fsync per command kyun nahi kiya?
6. Snapshot likhte waqt crash hua -- purana data kaise bacha?
7. Relative TTL ko AOF mein absolute kyun likhte hain?
8. Async replication mein acknowledged write kab lose ho sakta hai?
9. Replica khud keys expire kyun nahi karta?
10. BGSAVE Redis fork se karta hai -- copy-on-write kya hai aur yahan kyun nahi kiya?
