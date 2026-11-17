# Learning Guide (Hinglish) -- minikafka

## Step 1: Log vs queue

Queue (RabbitMQ) mein message consume hua toh gaya. Kafka mein message LOG mein append hota hai aur
retention tak rehta hai. Har consumer group apna "bookmark" (offset) rakhta hai. Isliye: 5 alag
services same stream padh sakti hain, aur bug fix ke baad purane events replay kar sakte ho
(`test_replay_with_seek`).

## Step 2: Disk pe log kaisa dikhta hai

`storage/`. Partition = folder, usme segment files `00000000000000004812.log` (naam = pehla offset).
Har record ke saath CRC. Sparse index har 4KB pe ek entry: offset dhoondhna = binary search + 4KB scan.
Crash ke time aadha record likha gaya? Startup pe CRC/length check karke kaat dete hain
(`test_recovery_truncates_torn_tail`). Retention puri purani segment file delete karta hai -- isliye
cheap hai.

## Step 3: Partition, key, ordering

Same key -> `crc32(key) % partitions` -> same partition -> us key ke messages order mein. Alag
partitions ke beech koi ordering nahi. Demo mein 5 customers 3 partitions pe -> 36/12/12: hot
partition / key skew ka real example.

## Step 4: Replication -- LEO, HW, ISR

- LEO = replica ka next offset.
- HW = sabse chhota LEO among ISR = "committed" boundary. Consumer sirf HW ke neeche padh sakta hai
  (`test_consumers_never_see_uncommitted_records`).
- ISR = jo followers time pe catch up kar rahe hain. Peeche reh gaya toh ISR se bahar
  (`test_isr_shrinks_on_lag_and_expands_after_heal`).
Followers leader se FETCH karte hain (pull). Fetch offset hi unka acknowledgement hai.

## Step 5: acks=1 vs acks=all -- sabse important interview point

`test_acks_1_can_lose_acknowledged_write_on_failover`: leader ne message likha, acks=1 hai toh
producer ko turant "ok" mil gaya, followers ne abhi copy nahi kiya, leader mar gaya -> naya leader ke
paas woh message hai hi nahi. Producer ko lagta hai save ho gaya, par gaya. acks=all + replication
factor 3 + min.insync.replicas 2 = ek broker marne pe bhi acked data safe
(`test_leader_failover_keeps_committed_data`).

min ISR kyun? acks=all ka matlab "saare ISR" -- agar ISR mein sirf leader bacha toh acks=all bhi
acks=1 jaisa ho jayega. min ISR 2 bolta hai: itne kam replicas pe likhne se mana kar do
(`test_min_insync_replicas_rejects_writes`).

## Step 6: Leader election, unclean election

Controller heartbeats dekhta hai. Leader gaya -> ISR mein se naya leader, epoch+1. Koi ISR member
zinda nahi -> partition OFFLINE (durability). Unclean election on karo toh out-of-sync replica leader
ban jata hai -- available, lekin data loss (test dono dikhata hai).

## Step 7: Consumer groups aur rebalancing

Ek partition group mein ek hi consumer ke paas. Naya consumer aaya / koi gaya / heartbeat band ->
rebalance -> generation+1 -> naya assignment. Purani generation wala "zombie" commit kare toh fenced
(`test_commit_fencing_and_ownership`). Range vs round-robin: range mein bahut topics ho toh pehla
consumer har topic ka extra partition le leta hai.

## Step 8: Delivery semantics

Process -> commit = at-least-once (crash beech mein = dobara process,
`test_at_least_once_redelivery_after_consumer_crash`). Commit -> process = at-most-once. Exactly-once
ke liye processing result aur offset ek saath atomic likhna padta hai (Kafka transactions ya DB
transaction) -- yahan implement nahi hai, aur yeh Kafka ke bahar ke side effects (email, payment
API) pe kaam nahi karta.

Idempotent producer: (producer id, sequence) se retry ka duplicate pakda jata hai. Limitation: is
project mein yeh state leader ki memory mein hai, failover pe chali jati hai.

## Step 9: Performance story

acks=all sirf 8.7k msg/s tha. Do hypotheses galat nikli (timeouts, slow reads). cProfile ne dikhaya
65% time `open()` mein -- Windows pe abhi-abhi likhi gayi file kholna mehenga hai. Read handle reuse
kiya -> 73.8k msg/s (7.7x). Aur batching: HTTP producer 376 -> 32,841 msg/s.

## Self-check

1. HW kya hai aur consumer HW ke upar kyun nahi padh sakta?
2. acks=1 mein acknowledged message kaise lose ho sakta hai?
3. min.insync.replicas ke bina acks=all kab weak ho jata hai?
4. Unclean leader election ka trade-off?
5. Ek group mein partitions se zyada consumers ho toh?
6. Zombie consumer kya hai, generation kaise bachata hai?
7. Exactly-once Kafka mein kahan tak possible hai, aur kahan nahi?
8. Retention per segment kyun, aur iska side effect?
9. Key skew / hot partition kaise handle karoge?
