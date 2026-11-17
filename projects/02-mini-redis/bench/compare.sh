#!/usr/bin/env bash
# Side-by-side: real Redis 7 vs minidis, same Docker network, same client (redis-benchmark, C).
# Both servers run with AOF everysec. Usage: bash bench/compare.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
docker compose --profile bench up -d real-redis master >/dev/null 2>&1
N=${N:-50000}; C=${C:-50}
for P in 1 16; do
  for target in "real-redis 6379" "master 6380"; do
    set -- $target
    echo "== $1 (pipeline=$P, clients=$C, requests=$N)"
    docker compose run --rm -T cli redis-benchmark -h "$1" -p "$2" -n "$N" -c "$C" -P "$P" \
      -t set,get,incr,lpush,hset -q 2>/dev/null | tr '\r' '\n' | grep -E "requests per second" || true
  done
done
