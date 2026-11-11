// Any OpenAI-compatible chat-completions endpoint: Groq (free tier), a local Ollama server (free, private),
// OpenRouter free models, Mistral, etc. Same prompt-injection hygiene and budget controls as the Anthropic adapter.
import { AiBudgetExceeded, extractJson, UNTRUSTED_PREAMBLE, type BudgetCheck } from './ai.ts';
import { NotConfiguredError, ProviderError, recordUsage, requestJson } from './http.ts';
import type { AiProvider } from './types.ts';

export class OpenAiCompatAi implements AiProvider {
  name: string;
  private base?: string; private key?: string; private model: string; private budget: BudgetCheck; private price: { in: number; out: number };
  private jsonMode = true;
  constructor(o: { baseUrl?: string; apiKey?: string; model: string; budget: BudgetCheck; price: { in: number; out: number }; name?: string }) {
    this.base = o.baseUrl?.replace(/\/$/, ''); this.key = o.apiKey; this.model = o.model; this.budget = o.budget; this.price = o.price;
    this.name = o.name ?? 'openai_compatible';
  }
  configured() { return !!this.base && !!this.model; }

  async json<T>(i: { system: string; user: string; maxTokens?: number; userId?: string | null; operation: string }): Promise<T> {
    if (!this.configured()) throw new NotConfiguredError('AI', ['AI_BASE_URL', 'AI_MODEL']);
    const b = await this.budget(i.userId);
    if (!b.allowed) throw new AiBudgetExceeded(b.reason ?? 'AI budget exceeded');
    const body = (json: boolean) => ({
      model: this.model, temperature: 0.2, max_tokens: i.maxTokens ?? 2000,
      messages: [{ role: 'system', content: `${i.system}\n\n${UNTRUSTED_PREAMBLE}\nRespond with a single JSON object and nothing else.` }, { role: 'user', content: i.user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    });
    const send = (json: boolean) => requestJson<{ choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } }>(`${this.base}/chat/completions`, {
      provider: this.name, operation: i.operation, method: 'POST', idempotent: true, retries: 2, timeoutMs: 120000, userId: i.userId,
      headers: this.key ? { Authorization: `Bearer ${this.key}` } : {}, body: body(json),
    });
    let r;
    try { r = await send(this.jsonMode); }
    catch (e) {
      // Some servers/models reject response_format; fall back to plain text with JSON extraction.
      if (this.jsonMode && e instanceof ProviderError && e.status === 400) { this.jsonMode = false; r = await send(false); }
      else throw e;
    }
    const tin = r.usage?.prompt_tokens ?? 0; const tout = r.usage?.completion_tokens ?? 0;
    recordUsage({ provider: 'ai', operation: `${i.operation}.tokens`, status: 'ok', httpStatus: 200, latencyMs: 0, tokensIn: tin, tokensOut: tout, costUsd: (tin * this.price.in + tout * this.price.out) / 1e6, userId: i.userId });
    const text = r.choices?.[0]?.message?.content ?? '';
    try { return extractJson<T>(text); } catch (e) { throw new ProviderError(this.name, `invalid JSON: ${(e as Error).message}`, 200, true); }
  }
}
