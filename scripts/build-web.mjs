// Bundles the browser app (TypeScript) into public/app.js with esbuild.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/web/main.ts'],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari15'],
  outfile: 'public/app.js',
  minify: process.env.NODE_ENV === 'production',
  sourcemap: process.env.NODE_ENV === 'production' ? false : 'linked',
  legalComments: 'none',
  logLevel: 'info',
});
