// Request dispatch shared by the desktop sidecar (Node, JSON-RPC over stdio)
// and the in-app providers on iPhone (web view, see web.ts).

export interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface Provider {
  search(query: string, page: number): Promise<unknown>;
  resolveStream(sourceId: string): Promise<unknown>;
  getMetadata(sourceId: string): Promise<unknown>;
  isHealthy(): boolean;
  trending?(): Promise<unknown>;
}

/** Runs `provider.action` (for example `youtube.search`) with its params. */
export async function callProvider(
  providers: Record<string, Provider>,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const [providerName, action] = method.split('.');
  const provider = Object.hasOwn(providers, providerName) ? providers[providerName] : undefined;
  if (!provider) {
    throw new RpcError(-32601, `Unknown provider: ${providerName}`);
  }
  switch (action) {
    case 'search':
      return provider.search(params?.query as string, (params?.page as number) ?? 0);
    case 'resolve_stream':
      return provider.resolveStream(params?.source_id as string);
    case 'get_metadata':
      return provider.getMetadata(params?.source_id as string);
    case 'is_healthy':
      return provider.isHealthy();
    case 'trending':
      if (!provider.trending) throw new RpcError(-32601, `${providerName} has no trending list`);
      return provider.trending();
    default:
      throw new RpcError(-32601, `Unknown method: ${action}`);
  }
}
