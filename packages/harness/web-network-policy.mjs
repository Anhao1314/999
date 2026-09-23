// Public HTTP(S) destinations only. DNS answers are checked as a set, then a
// validated address is pinned for the connection by WebReader.
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { ToolSessionError } from "./tool-session.mjs";

export const WEB_LIMITS = Object.freeze({
  redirects: 3,
  durationMs: 8_000,
  responseBytes: 128 * 1024,
  extractedTextBytes: 16 * 1024,
  headerBytes: 8 * 1024,
  searchResults: 5,
  urlBytes: 2048,
});

const denied = (message) => new ToolSessionError("WEB_URL_DENIED", message);
const ipv4Value = (address) => address.split(".").reduce((n, part) => (n << 8) | Number(part), 0) >>> 0;
const inV4 = (value, base, bits) => (value >>> (32 - bits)) === (ipv4Value(base) >>> (32 - bits));

export function isPublicIp(address) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Value(address);
    return ![
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["168.63.129.16", 32], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
      ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
      ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, bits]) => inV4(value, base, bits));
  }
  if (family !== 6 || address.includes("%")) return false;
  // Only global unicast. Exclude documentation, transition and special-use
  // space inside 2000::/3; transition forms can conceal private IPv4 targets.
  const head = address.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const expanded = head.split("::");
  if (expanded.length > 2) return false;
  const left = expanded[0] ? expanded[0].split(":") : [];
  const right = expanded[1] ? expanded[1].split(":") : [];
  if (left.some((part) => part.includes(".")) || right.some((part) => part.includes("."))) return false;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (expanded.length === 1 && missing !== 0)) return false;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return false;
  const first = words[0];
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2002) return false; // 6to4 embeds an IPv4 address.
  if (first === 0x2001) {
    if (words[1] === 0x0 || words[1] === 0x0db8 || words[1] === 0x2) return false;
    if (words[1] === 0x10 || words[1] === 0x20 || words[1] === 0x30) return false;
  }
  return true;
}

export function parsePublicWebUrl(raw) {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > WEB_LIMITS.urlBytes)
    throw denied("URL is missing or too long");
  let url;
  try { url = new URL(raw); } catch { throw denied("URL is invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw denied("only unauthenticated HTTP(S) is allowed");
  if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))
    throw denied("nonstandard web ports are not allowed");
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal") ||
      hostname === "metadata" || hostname === "metadata.google.internal" ||
      (!isIP(hostname) && !hostname.includes(".")))
    throw denied("local or metadata host is not allowed");
  if (isIP(hostname) && !isPublicIp(hostname)) throw denied("address is not public");
  url.hash = "";
  return url;
}

// The production resolver owns its outstanding A/AAAA queries and cancels
// them on abort. A missing address family is fine; other DNS errors fail shut.
export async function resolveDns(host, { signal } = {}) {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    if (signal?.aborted) throw new ToolSessionError("ABORTED", "web DNS cancelled");
    const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    if (signal?.aborted) throw new ToolSessionError("ABORTED", "web DNS cancelled");
    for (const result of results)
      if (result.status === "rejected" && !["ENODATA", "ENOTFOUND"].includes(result.reason?.code))
        throw new ToolSessionError("WEB_DNS_FAILED", "web host resolution failed");
    return results.flatMap((result, index) => result.status === "fulfilled"
      ? result.value.map((address) => ({ address, family: index === 0 ? 4 : 6 })) : []);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function resolvePublicWebUrl(url, { resolveHost = resolveDns, signal } = {}) {
  if (signal?.aborted) throw new ToolSessionError("ABORTED", "web request cancelled");
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(hostname)) return Object.freeze({ address: hostname, family: isIP(hostname) });
  let answers;
  let onAbort;
  try {
    answers = await Promise.race([
      resolveHost(hostname, { signal }),
      new Promise((_, reject) => {
        onAbort = () => reject(new ToolSessionError("ABORTED", "web request cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    if (signal?.aborted) throw new ToolSessionError("ABORTED", "web request cancelled");
    throw new ToolSessionError("WEB_DNS_FAILED", "web host resolution failed");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) throw new ToolSessionError("ABORTED", "web request cancelled");
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 32 ||
      answers.some((answer) => !answer || !isPublicIp(answer.address) || answer.family !== isIP(answer.address)))
    throw denied("DNS did not resolve exclusively to public addresses");
  return Object.freeze({ address: answers[0].address, family: answers[0].family });
}
