import http from "node:http";
import https from "node:https";

if (typeof globalThis.fetch !== "function") {
  globalThis.fetch = (async (input: string | URL, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => {
    const target = String(input);
    const performRequest = async (url: URL) => {
      const transport = url.protocol === "https:" ? https : http;
      const response = await new Promise<{
        status: number;
        headers: Record<string, string | string[] | undefined>;
        body: string;
      }>((resolve, reject) => {
        const req = transport.request(
          url,
          {
            method: init?.method ?? "GET",
            headers: init?.headers
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on("end", () => {
              resolve({
                status: res.statusCode ?? 500,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8")
              });
            });
          }
        );
        req.on("error", reject);
        if (init?.body) {
          req.write(init.body);
        }
        req.end();
      });
      return {
        status: response.status,
        headers: {
          get(name: string) {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : value ?? null;
          }
        },
        async text() {
          return response.body;
        },
        async json() {
          return JSON.parse(response.body);
        }
      } as Response;
    };

    return performRequest(new URL(target));
  }) as typeof fetch;
}
