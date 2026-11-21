# Measured results

Date: 2026-11-21T17:08:20.878Z  |  Node v20.20.1  |  linux/arm64  |  2 CPUs (Neoverse-N1)  |  commit c856b80

Topology: multi host: one local broker plus 2 remote broker(s) over the private network.

Whole run took 858s. CPU time over the run (all cores): busy 24.47%, idle 74.45%, iowait 0.01%, STEAL 1.07% (time the hypervisor gave to other tenants; high steal means noisy numbers).

## B2 Reference point: the same load generator against the real nats-server

Median of 3 run(s). Same machine, same client, same message size. nats-server is written in Go and multi-threaded; ours is one Node.js event loop. If both give a similar number, the load generator is the limit, not the broker.

| measurement | ours | nats-server |
|---|---|---|
| fan-out, 1 subscriber(s): delivered msg/s | 36916 (36847-37428) | 428378 (412771-437837) |
| fan-out, 10 subscriber(s): delivered msg/s | 47078 (46779-48175) | 556610 (556273-557532) |
| request/reply on one broker: p50 us | 238 (232-239) | 194 (193-202) |
| request/reply on one broker: p99 us | 1037 (852-1430) | 315 (307-347) |

Raw data: `b2.json`

## B3 Request/reply latency: same broker vs across one route hop

3 run(s), median with min-max. One request at a time (no pipelining); each round trip is timed on the requester's clock, so no clocks need to agree. Cross-node = request goes A -> B over the route and the reply comes back B -> A, so it contains TWO hops. Remote brokers on other servers.

| path | requests per run | p50 us | p90 us | p99 us |
|---|---|---|---|---|
| requester and responder on the same broker | 3000 | 224 (222-228) | 343 (335-380) | 1317 (1060-1490) |
| responder on another broker (2 route hops per round trip) | 3000 | 1315 (1308-1362) | 1447 (1418-1552) | 2538 (1735-2916) |

Raw data: `b3.json`

## B4 Kill the subscriber's broker under load (SIGKILL, no warning)

3 run(s). Publisher on broker C sends 2000 msg/s with sequence numbers; the subscriber (official nats client, server list [A, B]) is on broker A, which is SIGKILLed after 4 s. Delivery is AT MOST ONCE, so loss is expected; the point is how much and for how long. "Lost" = sequence numbers never received.

| run | sent | received | lost | duplicates | kill -> client reconnected (ms) | kill -> first message again (ms) |
|---|---|---|---|---|---|---|
| 1 | 22160 | 22131 | 29 | 0 | 10 | 0 |
| 2 | 22400 | 22380 | 20 | 0 | 9 | 16 |
| 3 | 22600 | 22580 | 20 | 0 | 8 | 12 |

Raw data: `b4.json`

## B5 Slow consumer: a subscriber stops reading while 1 KiB messages are published as fast as possible

One run per limit, each stops after 20 s if nothing was dropped. RSS = the broker's resident memory. The kernel's socket buffers hold some bytes before the broker's own queue starts growing, so a drop happens somewhat after maxPending bytes were sent. The drop is detected from the broker's stats line (every 100 ms), so "ms until drop" is accurate to about 100 ms.

| maxPending MiB | dropped? | ms until drop | MiB published by then | RSS before MiB | peak RSS MiB | RSS 2 s later MiB |
|---|---|---|---|---|---|---|
| 8 | yes | 289 | 12 | 42 | 79 | 79 |
| 64 | yes | 1231 | 66 | 42 | 250 | 250 |
| 512 | yes | 9286 | 506 | 42 | 1375 | 1375 |

Raw data: `b5.json`

## B6 Queue group across the cluster: 4 members on brokers B and C, publisher on broker A

3 run(s) of 20000 messages. Each message must reach exactly ONE member in the whole cluster. The origin broker picks a peer at random, the peer picks a member at random, so 25% each is the expectation. Last column: a fifth member then joins on the publisher's own broker and 1000 more messages are sent; local preference means all of them should stay local.

| run | delivered / sent | member 1 (B) % | member 2 (C) % | member 3 (B) % | member 4 (C) % | with a local member: local / remote |
|---|---|---|---|---|---|---|
| 1 | 20000 / 20000 | 24.8 | 25 | 25 | 25.2 | 1000 / 0 |
| 2 | 20000 / 20000 | 24.9 | 24.9 | 25.1 | 25 | 1000 / 0 |
| 3 | 20000 / 20000 | 24.8 | 24.9 | 25 | 25.3 | 1000 / 0 |

Raw data: `b6.json`

## B7 Soak: 600 s of 20 clients connecting, subscribing and disconnecting at random (half abruptly)

A publisher sends 500 msg/s to 50 subjects meanwhile. After the churn stops, every counter must return to zero: connections, subscriptions, and the interest each broker holds from its peers. Totals: 7527 connections, 22464 subscriptions, 3764 abrupt disconnects, 329581 deliveries. Only the LOCAL broker's counters are readable here; the remote brokers' stats are in their own logs.

| broker | connections after | subscriptions after | remote interest after | RSS early MiB | RSS peak MiB | RSS at end MiB |
|---|---|---|---|---|---|---|
| A | 0 | 0 | 0 | 46 | 69 | 69 |

Raw data: `b7.json`

