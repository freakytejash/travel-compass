// Local browser check: the real app (server + web UI + database) with the free provider stack on a SIMULATED
// network, so every page can be clicked through without API keys or quota. Not used in production.
//   TEST_DATABASE_URL=… node test/e2e/serve-sim.ts   → http://127.0.0.1:4173  (admin@example.com / correct horse battery)
import { startHarness, signUp } from '../helpers/harness.ts';
import { setFetch } from '../../src/server/integrations/http.ts';
import { FreeGeo } from '../../src/server/integrations/freegeo.ts';
import { SerpApiExplore, SerpApiFlights, SerpApiHotels } from '../../src/server/integrations/serpapi.ts';
import { NagerHolidays } from '../../src/server/integrations/holidays.ts';
import { AIRPORTS, BRUSSELS, net, tzLookup } from '../helpers/simnet.ts';
import http from 'node:http';

setFetch(net());
const h = await startHarness({ SERPAPI_API_KEY: 'serp_sim', BREVO_API_KEY: 'sim' }, () => {
  const geo = new FreeGeo({ airportsUrl: 'unused', dataDir: '/nonexistent', photonUrl: 'https://photon.example', airports: AIRPORTS, tzLookup });
  const q = async () => {};
  return { flights: new SerpApiFlights('serp_sim', geo, q), stays: [new SerpApiHotels('serp_sim', q)], explore: new SerpApiExplore('serp_sim', q), holidays: new NagerHolidays() };
});
h.clock.now = new Date('2027-02-01T09:00:00Z');
const admin = await signUp(h, 'admin@example.com');
await admin.put('/api/profile', { homePlace: BRUSSELS, currency: 'EUR', timeZone: 'Europe/Brussels', onboardingComplete: true });
setInterval(() => { void h.worker.drain().catch(() => {}); }, 700);
// Fixed port proxy to the harness server.
const target = new URL(h.base);
http.createServer((req, res) => {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: 'localhost' };
  if (req.headers.origin) headers.origin = 'http://localhost'; else delete headers.origin;
  const p = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
  req.pipe(p);
}).listen(4173, '127.0.0.1', () => console.log('READY http://127.0.0.1:4173'));
