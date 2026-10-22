/**
 * Your API lives here. Right now it only has a health check.
 * See apps/api/README.md for what to build.
 */
const port = Number(process.env.API_PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    return Response.json({ error: "not_implemented" }, { status: 501 });
  },
});

console.log(`[API] listening on ${server.url}`);
