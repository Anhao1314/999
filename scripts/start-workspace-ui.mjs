// Same runtime and store as the existing server; only choose a convenient default port.
process.env.FLOWCREDIT_PORT ??= '4320';
await import('../apps/runtime/server.mjs');
