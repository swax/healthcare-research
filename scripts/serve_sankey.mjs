// Open the Sankey diagram in the standalone Jumpgate dev server (a browser, no VS Code needed).
//
//   npm run serve:sankey                                   # rebuild + serve the Sankey .jg
//   npm run serve:sankey -- diagrams/healthcare-flows.jg   # serve some other .jg as-is
//
// By default this rebuilds diagrams/healthcare-flows-sankey.jg from data/graph.json (so you always
// see the current graph), then boots the Jumpgate demo server from the sibling repo
// (../jumpgate/packages/jumpgate) preloaded with it. Open the printed URL in a browser; Ctrl+C to stop.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = new URL("..", import.meta.url);
const JUMPGATE = new URL("../jumpgate/packages/jumpgate/", ROOT); // sibling checkout of swax/jumpgate
const jumpgateDir = fileURLToPath(JUMPGATE);
const devScript = fileURLToPath(new URL("dev.mjs", JUMPGATE));

if (!existsSync(devScript)) {
  console.error(`Jumpgate dev server not found at ${jumpgateDir}`);
  console.error("Clone it next to this repo:  git clone https://github.com/swax/jumpgate ../jumpgate");
  process.exit(1);
}

// A default run rebuilds the Sankey .jg first; an explicit path arg is served as-is (no rebuild).
const arg = process.argv[2];
const target = arg
  ? resolve(process.cwd(), arg)
  : fileURLToPath(new URL("diagrams/healthcare-flows-sankey.jg", ROOT));

if (!arg) {
  const build = spawnSync(process.execPath, [fileURLToPath(new URL("scripts/build_sankey.mjs", ROOT))], {
    cwd: fileURLToPath(ROOT), stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

if (!existsSync(target)) { console.error(`No such diagram: ${target}`); process.exit(1); }

console.log(`\nServing ${target}\nOpen http://localhost:8080 in your browser (Ctrl+C to stop)\n`);
// Run Jumpgate's dev.mjs with this same Node — it resolves an absolute file path fine, and its
// esbuild server serves the demo relative to cwd, so cwd must be the jumpgate package dir.
const serve = spawn(process.execPath, [devScript, target], { cwd: jumpgateDir, stdio: "inherit" });
serve.on("exit", (code) => process.exit(code ?? 0));
