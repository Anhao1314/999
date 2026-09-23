// Search providers only discover candidates. Their names and credentials do
// not appear in Relay capability names or SourceObservation evidence.
export function assertSearchProvider(provider) {
  if (!provider || typeof provider.search !== "function")
    throw new Error("SearchProvider requires search({ query, limit, signal })");
  return provider;
}
