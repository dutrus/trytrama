/**
 * Your agent lives here. See apps/agent/README.md.
 *
 *   bun agent "Bariloche, 4 nights from July 10, 2 adults, with breakfast"
 */
const request = process.argv.slice(2).join(" ").trim();

if (!request) {
  console.error('Usage: bun agent "<what the travel agent is looking for>"');
  process.exit(1);
}

console.error("Not implemented yet. See apps/agent/README.md.");
process.exit(1);
