// k6 benchmark. Run inside the compose network (see TESTING.md):
//   docker run --rm -i --network p01-rate-limiter_default -e MODE=allowed grafana/k6:1.4.2 run - < loadtest/k6_benchmark.js
// MODE=baseline -> /healthz (no limiter, no Redis): the stack's ceiling
// MODE=allowed  -> /api/resource from 50k fake IPs: limiter path that mostly ALLOWS (2 Lua calls/request)
// MODE=hot      -> /api/resource from one IP: limiter path that mostly DENIES (429)
// Instances are hit directly (round-robin in the script) with X-Real-IP so we can fake many clients;
// the app trusts X-Real-IP because RL_TRUST_FORWARDED_FOR=true in this compose file.
import http from 'k6/http';
import { check } from 'k6';

const MODE = __ENV.MODE || 'allowed';
const VUS = parseInt(__ENV.VUS || '64');
export const options = {
  scenarios: { load: { executor: 'constant-vus', vus: VUS, duration: __ENV.DURATION || '20s' } },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};
const hosts = ['api1', 'api2', 'api3'];

export default function () {
  const host = hosts[Math.floor(Math.random() * hosts.length)];
  if (MODE === 'baseline') {
    const r = http.get(`http://${host}:8000/healthz`);
    check(r, { '200': (x) => x.status === 200 });
    return;
  }
  const ip = MODE === 'hot' ? '203.0.113.7' : `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.1`;
  const r = http.get(`http://${host}:8000/api/resource`, { headers: { 'X-Real-IP': ip }, responseCallback: http.expectedStatuses(200, 429) });
  check(r, { '200 or 429': (x) => x.status === 200 || x.status === 429, 'not 5xx': (x) => x.status < 500 });
}
