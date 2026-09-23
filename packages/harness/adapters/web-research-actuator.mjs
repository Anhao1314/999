// Read-only external observation behind the Host's authorized tool session.
import { ToolSessionError } from "../tool-session.mjs";
import { assertSearchProvider } from "../search-provider.mjs";
import { createWebReader } from "../web-reader.mjs";
import { parsePublicWebUrl, WEB_LIMITS } from "../web-network-policy.mjs";

export const WEB_SEARCH = "research.web.search";
export const WEB_READ = "research.web.read";
const protocol = (message) => new ToolSessionError("TOOL_PROTOCOL_ERROR", message);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every((key) => keys.includes(key));

export function createWebResearchActuator({ searchProvider = null, reader = createWebReader() } = {}) {
  if (searchProvider !== null) assertSearchProvider(searchProvider);
  if (!reader || typeof reader.read !== "function") throw new Error("WebResearchActuator requires WebReader.read()");
  return Object.freeze({
    // The Host recognizes this trusted output shape and mints sourceId only
    // after a successful read. The Actuator never accepts or creates an ID.
    sourceObservationCapabilities: Object.freeze([WEB_READ]),
    supports(capability) { return capability === WEB_READ || (capability === WEB_SEARCH && searchProvider !== null); },
    async invoke({ capability, input, signal }) {
      if (signal?.aborted) throw new ToolSessionError("ABORTED", "web operation cancelled");
      if (capability === WEB_SEARCH) {
        if (!exact(input, ["query", "limit"]) || typeof input.query !== "string" ||
            !input.query.trim() || input.query.length > 300 ||
            (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > WEB_LIMITS.searchResults)))
          throw protocol("invalid web search input");
        if (!searchProvider) throw new ToolSessionError("WEB_SEARCH_UNAVAILABLE", "no search provider is configured");
        const limit = input.limit ?? WEB_LIMITS.searchResults;
        let candidates;
        try { candidates = await searchProvider.search({ query: input.query.trim(), limit, signal }); }
        catch (error) {
          if (signal?.aborted) throw new ToolSessionError("ABORTED", "web search cancelled");
          throw new ToolSessionError("WEB_SEARCH_FAILED", "search provider failed");
        }
        if (signal?.aborted) throw new ToolSessionError("ABORTED", "web search cancelled");
        if (!Array.isArray(candidates) || candidates.length > limit)
          throw new ToolSessionError("WEB_SEARCH_INVALID", "search provider returned too many or invalid candidates");
        const results = candidates.map((candidate) => {
          if (!exact(candidate, ["url", "title", "snippet"]) ||
              typeof candidate.url !== "string" ||
              (candidate.title !== undefined && (typeof candidate.title !== "string" || candidate.title.length > 200)) ||
              (candidate.snippet !== undefined && (typeof candidate.snippet !== "string" || candidate.snippet.length > 500)))
            throw new ToolSessionError("WEB_SEARCH_INVALID", "search candidate is malformed");
          const url = parsePublicWebUrl(candidate.url);
          return Object.freeze({ url: url.href, title: candidate.title ?? null, snippet: candidate.snippet ?? null });
        });
        return Object.freeze({ results: Object.freeze(results) });
      }
      if (capability === WEB_READ) {
        if (!exact(input, ["url"]) || typeof input.url !== "string")
          throw protocol("web read accepts only a URL; sourceId cannot be supplied");
        const sourceObservation = await reader.read({ url: input.url, signal });
        if (signal?.aborted) throw new ToolSessionError("ABORTED", "web read cancelled");
        // A trusted reader is required, but its returned URL still crosses an
        // Actuator boundary before the Host mints an evidence identifier.
        parsePublicWebUrl(sourceObservation?.canonicalUrl);
        return Object.freeze({ sourceObservation });
      }
      throw new ToolSessionError("TOOL_PROTOCOL_ERROR", "unsupported web capability");
    },
  });
}
