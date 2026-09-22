// The loopback-origin gate shared by every local product surface.
//
// The Runtime binds to 127.0.0.1 and has no login: what protects it is that a
// browser page from another origin cannot read its responses or post a command.
// The rule is the same for static shells and for /commands, so it lives here
// once instead of being copied per app.
//
//   host        must be loopback (127.0.0.1 / localhost), port allowed;
//   fetch site  must not be cross-site;
//   origin      when sent, must equal the loopback origin exactly.
//
// It is a transport gate, not an authorization system, and it never claims to
// be one.
export function isLocalBrowserRequest(request) {
  const host = request.headers.host;
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host ?? '')) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return !request.headers.origin || request.headers.origin === `http://${host}`;
}
