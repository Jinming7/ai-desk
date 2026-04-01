import http from "node:http";
import https from "node:https";

type HeaderInitValue = string | string[];
type FetchHeadersInit = Record<string, string> | Array<[string, string]> | { forEach: (callback: (value: string, name: string) => void) => void };
type FetchBodyInit =
  | string
  | Buffer
  | URLSearchParams
  | ArrayBuffer
  | ArrayBufferView
  | { toString(): string };
type FetchRequestInit = {
  method?: string;
  headers?: FetchHeadersInit;
  body?: FetchBodyInit | null;
  signal?: AbortSignal | null;
};
type FetchCompatOptions = {
  baseUrl?: string | URL;
};
type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  url: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
};
type FetchRequestLike = {
  url: string;
  method?: string;
  headers?: FetchHeadersInit;
  signal?: AbortSignal | null;
};

class SimpleHeaders {
  private readonly values = new Map<string, string[]>();

  constructor(init?: FetchHeadersInit | Record<string, string | string[] | undefined>) {
    if (!init) return;
    if (Array.isArray(init)) {
      for (const [name, value] of init) {
        this.append(name, value);
      }
      return;
    }
    if (typeof (init as { forEach?: unknown }).forEach === "function") {
      (init as { forEach: (callback: (value: string, name: string) => void) => void }).forEach((value, name) =>
        this.append(name, value)
      );
      return;
    }
    for (const [name, value] of Object.entries(init as Record<string, string | string[] | undefined>)) {
      if (Array.isArray(value)) {
        for (const item of value) this.append(name, item);
        continue;
      }
      if (typeof value === "string") this.append(name, value);
    }
  }

  append(name: string, value: string) {
    const normalized = name.toLowerCase();
    const current = this.values.get(normalized) ?? [];
    current.push(value);
    this.values.set(normalized, current);
  }

  get(name: string): string | null {
    const current = this.values.get(name.toLowerCase());
    return current?.length ? current.join(", ") : null;
  }

  has(name: string): boolean {
    return this.values.has(name.toLowerCase());
  }

  set(name: string, value: string) {
    this.values.set(name.toLowerCase(), [value]);
  }

  forEach(callback: (value: string, key: string, parent: SimpleHeaders) => void) {
    for (const [name, values] of this.values.entries()) {
      callback(values.join(", "), name, this);
    }
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [name, values] of this.values.entries()) {
      yield [name, values.join(", ")];
    }
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  toNodeHeaders(): Record<string, HeaderInitValue> {
    const normalized: Record<string, HeaderInitValue> = {};
    for (const [name, values] of this.values.entries()) {
      normalized[name] = values.length === 1 ? values[0] : values;
    }
    return normalized;
  }
}

function toHeaders(init?: FetchHeadersInit): SimpleHeaders {
  return new SimpleHeaders(init);
}

function toBuffer(body: FetchBodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return Buffer.from(String(body));
}

function resolveUrl(input: string | URL, options?: FetchCompatOptions): URL {
  if (input instanceof URL) return input;
  const value = String(input);
  try {
    return new URL(value);
  } catch {
    if (!options?.baseUrl) {
      throw new Error(`Relative URL requires baseUrl: ${value}`);
    }
    return new URL(value, options.baseUrl);
  }
}

function extractRequest(input: string | URL | FetchRequestLike, init?: FetchRequestInit, options?: FetchCompatOptions): {
  url: URL;
  method: string;
  headers: SimpleHeaders;
  body?: Buffer;
  signal?: AbortSignal | null;
} {
  if (typeof input === "string" || input instanceof URL) {
    return {
      url: resolveUrl(input, options),
      method: init?.method ?? "GET",
      headers: toHeaders(init?.headers),
      body: toBuffer(init?.body),
      signal: init?.signal ?? null
    };
  }

  const request = input as FetchRequestLike;
  return {
    url: resolveUrl(request.url, options),
    method: init?.method ?? request.method ?? "GET",
    headers: toHeaders(init?.headers ?? request.headers),
    body: toBuffer(init?.body),
    signal: init?.signal ?? request.signal ?? null
  };
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

async function fetchCompat(input: string | URL | FetchRequestLike, init?: FetchRequestInit): Promise<FetchResponse> {
  const request = extractRequest(input, init);
  const transport = request.url.protocol === "https:" ? https : http;

  return await new Promise<FetchResponse>((resolve, reject) => {
    const abortError = createAbortError();
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const req = transport.request(
      request.url,
      {
        method: request.method,
        headers: request.headers.toNodeHeaders()
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const headers = new SimpleHeaders(res.headers as Record<string, string>);
          done(() =>
            resolve({
              ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? "",
              headers,
              url: request.url.toString(),
              text: async () => body.toString("utf8"),
              json: async () => JSON.parse(body.toString("utf8")),
              arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
            })
          );
        });
      }
    );

    const onAbort = () => {
      req.destroy(abortError);
      done(() => reject(abortError));
    };

    const cleanup = () => {
      request.signal?.removeEventListener("abort", onAbort);
    };

    req.on("error", (error) => done(() => reject(error)));

    if (request.signal?.aborted) {
      onAbort();
      return;
    }
    request.signal?.addEventListener("abort", onAbort, { once: true });

    if (request.body) req.write(request.body);
    req.end();
  });
}

export async function fetchWithNodeCompat(
  input: string | URL | FetchRequestLike,
  init?: FetchRequestInit,
  options?: FetchCompatOptions
): Promise<FetchResponse> {
  const request = extractRequest(input, init, options);
  if (typeof globalThis.fetch === "function") {
    return (await globalThis.fetch(request.url, {
      method: request.method,
      headers: request.headers as never,
      body: request.body,
      signal: request.signal ?? undefined
    })) as unknown as FetchResponse;
  }
  return fetchCompat(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal
  });
}

export { SimpleHeaders };
