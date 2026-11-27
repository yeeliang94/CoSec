import { defaultImportSettings, type ImportSettings } from '../../domain/imports';
import type { Settings } from '../../domain/model';

/**
 * An OpenAI-compatible model gateway (for example LiteLLM), called through the OpenAI Responses API.
 * There is no fallback: without a gateway address, model name and key, bulk import is off.
 * Proxy and certificates come from the process: start.mjs sets NODE_USE_ENV_PROXY so fetch
 * honours HTTPS_PROXY, and --use-system-ca so the operating system's certificates are trusted.
 */
export type GatewayConfig = ImportSettings & { apiKey: string };

export function importSettingsOf(settings: Settings): ImportSettings {
  return { ...defaultImportSettings, ...(settings.importSettings ?? {}) };
}
/** Why bulk import is off, or null when it can run. */
export function gatewayProblem(settings: ImportSettings): string | null {
  if (!settings.gatewayUrl)
    return 'Bulk import is off. Set the gateway address on the Settings page.';
  if (!settings.model) return 'Set the model name on the Settings page.';
  if (!process.env.OPENAI_API_KEY)
    return 'The gateway key is missing. Add OPENAI_API_KEY to the .env file and restart.';
  return null;
}
export function gatewayConfig(settings: Settings): GatewayConfig | null {
  const values = importSettingsOf(settings);
  if (gatewayProblem(values)) return null;
  return { ...values, apiKey: process.env.OPENAI_API_KEY! };
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type ModelItem = Record<string, unknown> & { type: string };
export type ModelReply = {
  output: ModelItem[];
  usage: { inputTokens: number; outputTokens: number };
};
export type ModelRequest = {
  instructions?: string;
  input: unknown[];
  tools?: unknown[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
};
/** One model call. Replaced in tests by a scripted model. */
export type ModelCaller = (request: ModelRequest) => Promise<ModelReply>;

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DELAYS_MS = [2000, 5000, 10000];
const ATTEMPT_TIMEOUT_MS = 180_000;

function statusMessage(status: number) {
  if (status === 401 || status === 403) return 'The gateway refused the key. Check OPENAI_API_KEY.';
  if (status === 404) return 'The gateway address or model name was not found. Check Settings.';
  if (status === 413) return 'A file was too large for the gateway.';
  if (status === 429) return 'The gateway is busy or a usage limit was reached.';
  if (status >= 500) return 'The gateway had a problem answering.';
  return `The gateway did not accept the request (status ${status}).`;
}
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new GatewayError('Stopped.', false));
    });
  });

/** Calls the gateway's Responses endpoint, retrying dropped connections and busy replies. */
export function gatewayCaller(config: GatewayConfig): ModelCaller {
  const url = config.gatewayUrl.replace(/\/+$/, '') + '/responses';
  return async (request) => {
    const body = JSON.stringify({
      model: config.model,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      input: request.input,
      ...(request.tools?.length ? { tools: request.tools, tool_choice: 'auto' } : {}),
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      // Nothing is kept by the provider; every call sends what the model needs.
      store: false,
    });
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      ...(config.providerHeader ? { 'custom-llm-provider': config.providerHeader } : {}),
    };
    let last: GatewayError | null = null;
    for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(DELAYS_MS[attempt - 1], request.signal);
      let response: Response;
      try {
        const signals = [AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)];
        if (request.signal) signals.push(request.signal);
        response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        if (request.signal?.aborted) throw new GatewayError('Stopped.', false);
        const name = error instanceof Error ? error.name : '';
        last = new GatewayError(
          name === 'TimeoutError'
            ? 'The gateway took too long to answer.'
            : 'The gateway could not be reached. Check the address, proxy and certificates.',
          true,
        );
        continue;
      }
      if (response.ok) {
        const json = (await response.json()) as {
          output?: ModelItem[];
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        return {
          output: json.output ?? [],
          usage: {
            inputTokens: json.usage?.input_tokens ?? 0,
            outputTokens: json.usage?.output_tokens ?? 0,
          },
        };
      }
      last = new GatewayError(statusMessage(response.status), RETRY_STATUS.has(response.status));
      await response.body?.cancel().catch(() => undefined);
      if (!last.retryable) throw last;
    }
    throw last ?? new GatewayError('The gateway could not be reached.', true);
  };
}

/** The text of a reply's message items. */
export function replyText(output: ModelItem[]) {
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (item.content as { type: string; text?: string }[] | undefined) ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Sends one tiny request, so a wrong address, key, model, proxy or certificate shows up here
 * rather than in the middle of an import. It avoids the gateway's /health, which costs tokens.
 */
export async function checkConnection(config: GatewayConfig, call = gatewayCaller(config)) {
  const started = Date.now();
  const reply = await call({
    input: [{ role: 'user', content: 'Reply with the single word OK.' }],
    maxOutputTokens: 16,
  });
  return {
    ok: true as const,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    reply: replyText(reply.output).slice(0, 40),
  };
}
