# Interview Preparation -- minikafka

Question bank: `interview/data/p05-mini-kafka/` (validated), browsable in the portfolio website.

## Stories

1. **Commit log internals**: segments, sparse index, CRC, recovery, retention per segment.
2. **acks=1 loses an acknowledged write; acks=all + min ISR doesn't** -- both proven by tests.
3. **HW/ISR/election**: why consumers stop at HW; clean vs unclean election; HW checkpoints on restart.
4. **Consumer groups**: generations, rebalance triggers, fencing zombies, range vs round-robin skew.
5. **Profiling story**: acks=all 8.7k -> 73.8k msg/s after two rejected hypotheses and a cProfile.
