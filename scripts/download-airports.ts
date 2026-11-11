// Downloads the public-domain OurAirports dataset into DATA_DIR (default ./data) once:
//   npm run airports:download
// The server also downloads it automatically on first use; run this to pre-fetch or refresh it.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server/config.ts';
import { FreeGeo } from '../src/server/integrations/freegeo.ts';

const cfg = loadConfig();
const file = path.join(cfg.geo.dataDir, 'airports.csv');
if (process.argv.includes('--refresh') && fs.existsSync(file)) fs.unlinkSync(file);
const geo = new FreeGeo({ airportsUrl: cfg.geo.airportsUrl, dataDir: cfg.geo.dataDir, photonUrl: cfg.geo.photonUrl });
const list = await geo.loadAirports();
console.log(`${list.length} airports with IATA codes and scheduled service → ${file}`);
