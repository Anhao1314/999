// Fixed HTTPS DNS infrastructure for environments whose system resolver
// returns Fake-IP addresses. Every answer still passes WebReader's existing
// whole-answer public-IP validation before a socket is pinned.
import { ToolSessionError } from "./tool-session.mjs";

const ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_BYTES = 8 * 1024;
const TYPES = [["A", 1, 4], ["AAAA", 28, 6]];
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const fail = () => new ToolSessionError("WEB_DNS_FAILED", "trusted public DNS resolution failed");
const canonical = name => typeof name === "string" ? name.replace(/\.$/, "").toLowerCase() : "";

async function boundedJson(response) {
  if (!response.ok || !response.body) throw fail();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw fail();
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw fail(); }
}

export function createTrustedDohResolver({ fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("DoH resolver requires fetch");
  return async (hostname, { signal } = {}) => {
    const requested = canonical(hostname);
    if (!hostnamePattern.test(requested)) throw fail();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 4_000);
    try {
      const responses = await Promise.all(TYPES.map(async ([name, type]) => {
        const url = new URL(ENDPOINT);
        url.searchParams.set("name", requested);
        url.searchParams.set("type", name);
        const result = await fetchImpl(url, { headers: { accept: "application/dns-json" },
          redirect: "error", signal: controller.signal });
        const data = await boundedJson(result);
        if (data?.Status !== 0 || !Array.isArray(data.Question) || data.Question.length !== 1 ||
            canonical(data.Question[0]?.name) !== requested || data.Question[0]?.type !== type ||
            (data.Answer !== undefined && !Array.isArray(data.Answer)) ||
            (data.Answer?.length ?? 0) > 32) throw fail();
        const records = data.Answer ?? [];
        let owner = requested;
        const seen = new Set([owner]);
        for (let depth = 0; depth < 4; depth += 1) {
          const aliases = records.filter(record => canonical(record?.name) === owner && record?.type === 5);
          if (aliases.length === 0) break;
          if (aliases.length !== 1 || !hostnamePattern.test(canonical(aliases[0].data))) throw fail();
          owner = canonical(aliases[0].data);
          if (seen.has(owner)) throw fail();
          seen.add(owner);
        }
        if (records.some(record => record?.type === 5 && canonical(record.name) === owner)) throw fail();
        const addresses = records.filter(record => record?.type === type && canonical(record.name) === owner)
          .map(record => ({ address: record.data, family: type === 1 ? 4 : 6 }));
        if (addresses.length > 32) throw fail();
        return addresses;
      }));
      const addresses = responses.flat();
      if (addresses.length === 0 || addresses.length > 32 || controller.signal.aborted) throw fail();
      return addresses;
    } catch (error) {
      if (signal?.aborted) throw new ToolSessionError("ABORTED", "public DNS cancelled");
      if (error instanceof ToolSessionError) throw error;
      throw fail();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  };
}
