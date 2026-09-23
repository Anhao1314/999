// Bounded, read-only public web observation. Redirects are handled here rather
// than by a client library so every destination receives a fresh DNS check.
import http from "node:http";
import https from "node:https";
import { digestOf } from "../work/records.mjs";
import { ToolSessionError } from "./tool-session.mjs";
import { parsePublicWebUrl, resolvePublicWebUrl, WEB_LIMITS } from "./web-network-policy.mjs";

const fail = (code, message) => new ToolSessionError(code, message);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CONTENT_TYPES = new Set(["text/html", "text/plain"]);
const networkReaders = new WeakSet();
export function isNetworkWebReader(reader) { return networkReaders.has(reader); }

function nodeGet({ url, address, family, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "GET",
      agent: false,
      signal,
      family,
      maxHeaderSize: WEB_LIMITS.headerBytes,
      lookup: (_host, _options, callback) => callback(null, address, family),
      headers: {
        accept: "text/html, text/plain",
        "accept-encoding": "identity",
        "user-agent": "FlowCredit-WebReader/0.1",
      },
    }, (response) => {
      response.on("error", reject);
      const headerBytes = Buffer.byteLength(response.rawHeaders.join("\r\n"));
      if (headerBytes > WEB_LIMITS.headerBytes) {
        response.destroy(fail("WEB_HEADERS_TOO_LARGE", "web headers exceed limit"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > WEB_LIMITS.responseBytes) {
          response.destroy(fail("WEB_RESPONSE_TOO_LARGE", "web response exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end();
  });
}

const header = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

function decodeEntity(text) {
  return text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => {
    const key = name.toLowerCase();
    if (key.startsWith("#")) {
      const point = key[1] === "x" ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[key];
  });
}

function extract(body, contentType) {
  const raw = new TextDecoder("utf-8").decode(body);
  if (contentType === "text/plain") return { title: null, content: raw.trim().replace(/\s+/g, " ") };
  const titleMatch = raw.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? decodeEntity(titleMatch[1].replace(/<[^>]*>/g, " ")).trim().replace(/\s+/g, " ").slice(0, 200) : null;
  const content = decodeEntity(raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " "))
    .trim().replace(/\s+/g, " ");
  return { title, content };
}

export function createWebReader({ resolveHost, transport = nodeGet, now = () => new Date().toISOString(),
  timeoutMs = WEB_LIMITS.durationMs, sameHostRedirectsOnly = false } = {}) {
  if (resolveHost !== undefined && typeof resolveHost !== "function") throw new Error("resolveHost must be a function");
  if (typeof sameHostRedirectsOnly !== "boolean") throw new Error("sameHostRedirectsOnly must be boolean");
  if (typeof transport !== "function" || typeof now !== "function") throw new Error("WebReader requires transport and clock functions");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WEB_LIMITS.durationMs)
    throw new Error("WebReader timeout must be positive and at most the public web limit");
  const reader = Object.freeze({
    async read({ url: rawUrl, signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      let url;
      let redirects = 0;
      try {
        url = parsePublicWebUrl(rawUrl);
        const authorizedHost = url.hostname;
        while (true) {
          if (controller.signal.aborted) throw fail(signal?.aborted ? "ABORTED" : "TOOL_TIMEOUT", "web read cancelled or timed out");
          const pin = await resolvePublicWebUrl(url, { resolveHost, signal: controller.signal });
          let response;
          try { response = await transport({ url, ...pin, signal: controller.signal }); }
          catch (error) {
            if (controller.signal.aborted) throw fail(signal?.aborted ? "ABORTED" : "TOOL_TIMEOUT", "web read cancelled or timed out");
            if (error instanceof ToolSessionError) throw error;
            if (error?.code === "HPE_HEADER_OVERFLOW") throw fail("WEB_HEADERS_TOO_LARGE", "web headers exceed limit");
            throw fail("WEB_NETWORK_FAILED", "web GET failed");
          }
          if (controller.signal.aborted) throw fail(signal?.aborted ? "ABORTED" : "TOOL_TIMEOUT", "web read cancelled or timed out");
          if (!response || !Number.isInteger(response.statusCode) || !response.headers ||
              Buffer.byteLength(JSON.stringify(response.headers)) > WEB_LIMITS.headerBytes ||
              !Buffer.isBuffer(response.body) || response.body.length > WEB_LIMITS.responseBytes)
            throw fail("WEB_RESPONSE_TOO_LARGE", "web response is invalid or exceeds limits");
          if (REDIRECTS.has(response.statusCode)) {
            if (redirects >= WEB_LIMITS.redirects) throw fail("WEB_REDIRECT_LIMIT", "too many web redirects");
            const location = header(response.headers, "location");
            if (typeof location !== "string" || Buffer.byteLength(location) > WEB_LIMITS.urlBytes)
              throw fail("WEB_REDIRECT_INVALID", "redirect has no bounded Location");
            let target;
            try { target = new URL(location, url); } catch { throw fail("WEB_REDIRECT_INVALID", "redirect target is invalid"); }
            // The next iteration rechecks scheme, host, every DNS answer and
            // pins a newly validated address before connecting.
            url = parsePublicWebUrl(target.href);
            if (sameHostRedirectsOnly && url.hostname !== authorizedHost)
              throw fail("WEB_URL_DENIED", "redirect leaves the authorized public host");
            redirects += 1;
            continue;
          }
          if (response.statusCode !== 200) throw fail("WEB_HTTP_STATUS", "web server did not return 200");
          const encoding = header(response.headers, "content-encoding");
          if (encoding && String(encoding).toLowerCase() !== "identity")
            throw fail("WEB_ENCODING_UNSUPPORTED", "compressed web responses are not accepted");
          const type = String(header(response.headers, "content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
          if (!CONTENT_TYPES.has(type)) throw fail("WEB_CONTENT_TYPE_UNSUPPORTED", "web content type is unsupported");
          const extracted = extract(response.body, type);
          const title = extracted.title;
          let content = extracted.content;
          if (!content) throw fail("WEB_EXTRACTED_TEXT_TOO_LARGE", "extracted web text is empty");
          if (Buffer.byteLength(content) > WEB_LIMITS.extractedTextBytes) {
            const suffix = " [Excerpt truncated; full page was not observed as model context.]";
            const limit = WEB_LIMITS.extractedTextBytes - Buffer.byteLength(suffix);
            while (Buffer.byteLength(content) > limit) content = content.slice(0, Math.max(0, content.length - 256));
            content = `${content.trimEnd()}${suffix}`;
          }
          const observedAt = now();
          if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt)))
            throw fail("WEB_OBSERVATION_INVALID", "web observation clock is invalid");
          return Object.freeze({
            canonicalUrl: url.href,
            title,
            observedAt,
            contentDigest: digestOf(response.body),
            content,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) throw fail(signal?.aborted ? "ABORTED" : "TOOL_TIMEOUT", "web read cancelled or timed out");
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  });
  if (transport === nodeGet) networkReaders.add(reader);
  return reader;
}
