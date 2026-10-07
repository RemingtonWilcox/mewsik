import http from 'node:http';
import readline from 'node:readline';

// Set up the youtubei.js JavaScript evaluator BEFORE any provider instantiation.
// The default node.js shim ships a no-op evaluator that throws; we replace it with
// a Function-constructor-based evaluator so signature/nsig deciphering works.
import { Platform } from 'youtubei.js';

// Capture the existing node.js shim (already loaded by the youtubei.js/node import),
// then patch only the eval function in-place so all other properties remain unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Platform.shim as any).eval = function (data: { output: string }, _env: unknown) {
  // data.output is a complete JS snippet ending with `return process(...)`.
  // Wrap in a Function and call it to get the sig/n result object.
  // eslint-disable-next-line no-new-func
  return new Function(data.output)();
};

import { YouTubeProvider } from './providers/youtube.js';
import { SoundCloudProvider } from './providers/soundcloud.js';
import { BandcampProvider } from './providers/bandcamp.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const providers = {
  youtube: new YouTubeProvider(),
  soundcloud: new SoundCloudProvider(),
  bandcamp: new BandcampProvider(),
};

const proxyServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'stream' && parts[1] === 'soundcloud' && parts[2]) {
      await providers.soundcloud.streamToResponse(decodeURIComponent(parts[2]), req, res);
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  } catch (err) {
    res.statusCode = 500;
    res.end(err instanceof Error ? err.message : 'Proxy server error');
  }
});

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  try {
    const [providerName, action] = method.split('.');
    const provider = providers[providerName as keyof typeof providers];

    if (!provider) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown provider: ${providerName}` } };
    }

    let result: unknown;

    switch (action) {
      case 'search':
        result = await provider.search(params?.query as string, (params?.page as number) ?? 0);
        break;
      case 'resolve_stream':
        result = await provider.resolveStream(params?.source_id as string);
        break;
      case 'get_metadata':
        result = await provider.getMetadata(params?.source_id as string);
        break;
      case 'is_healthy':
        result = provider.isHealthy();
        break;
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${action}` } };
    }

    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { jsonrpc: '2.0', id, error: { code: -32000, message } };
  }
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

// stdout carries the JSON-RPC frames; everything diagnostic must go to stderr.
proxyServer.listen(0, '127.0.0.1', () => {
  const address = proxyServer.address();
  if (address && typeof address === 'object') {
    providers.soundcloud.setProxyBaseUrl(`http://127.0.0.1:${address.port}`);
  }

  const port = address && typeof address === 'object' ? address.port : 'unknown';
  process.stderr.write(`Sidecar ready (proxy on 127.0.0.1:${port})\n`);
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed);
  } catch {
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }

  const response = await handleRequest(request);
  writeResponse(response);
});

// When the parent (Rust) closes our stdin, treat it as shutdown.
rl.on('close', () => {
  proxyServer.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  proxyServer.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  proxyServer.close();
  process.exit(0);
});
