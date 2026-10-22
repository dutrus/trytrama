/**
 * Starts every fake provider in providers/<x>/src/server.ts plus your API.
 * Each process logs with its own [TAG]. Ctrl+C stops everything.
 */
const providers = [...new Bun.Glob("providers/*/src/server.ts").scanSync(".")].sort();

const processes: Array<{ name: string; cmd: string[] }> = [
  ...providers.map((path) => ({ name: `provider-${path.split("/")[1]}`, cmd: ["bun", path] })),
  { name: "api", cmd: ["bun", "--watch", "apps/api/src/index.ts"] },
];

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const c of children) c.kill();
  process.exit(code);
}

const children = processes.map(({ name, cmd }) => {
  const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env: process.env });
  child.exited.then((code) => {
    if (shuttingDown) return;
    console.error(`\n${name} exited with code ${code}. Stopping everything (is the port already in use?).`);
    shutdown(1);
  });
  return child;
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`Starting ${processes.map((p) => p.name).join(", ")}`);
