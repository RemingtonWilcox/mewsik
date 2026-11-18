// Bundles the online providers for the app's web view (see src/web.ts).
// Output: ../static/web-providers.js, loaded only when the app runs its
// providers in the page (iPhone, or MEWSIK_WEB_PROVIDERS=1 on the desktop).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here('src/web.ts')],
  outfile: here('../static/web-providers.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari17'],
  minify: true,
  legalComments: 'none',
  inject: [here('src/web/native-fetch.ts')],
  alias: {
    undici: here('src/web/undici.ts'),
    os: here('src/web/os.ts'),
    url: here('src/web/url.ts'),
    path: here('src/web/path.ts'),
    events: here('src/web/events.ts'),
  },
  plugins: [
    {
      // The providers import 'youtubei.js' (its Node build); use the web one.
      name: 'youtubei-web',
      setup(b) {
        b.onResolve({ filter: /^youtubei\.js$/ }, (args) =>
          b.resolve('youtubei.js/web', { kind: args.kind, resolveDir: args.resolveDir }),
        );
      },
    },
  ],
  logLevel: 'warning',
});
