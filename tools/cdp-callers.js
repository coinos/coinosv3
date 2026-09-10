// Who calls a hot function? Aggregates ancestor chains (inclusive-time
// weighted) for every profile node named <fnName>, from a .cpuprofile saved
// by tools/cdp-profile.js --out.
const [file, name, depthS] = process.argv.slice(2); const depth = Number(depthS || 6);
const p = JSON.parse(await Bun.file(file).text());
const nodes = new Map(p.nodes.map((n) => [n.id, n])); const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const self = new Map(); for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (p.timeDeltas[i + 1] || 0));
const key = (n) => { const f = n.callFrame; return `${f.functionName || '(anon)'}@${f.url.replace(/^https?:\/\/[^/]+\//, '').slice(0, 22)}:${f.lineNumber + 1}:${f.columnNumber + 1}`; };
const chains = new Map();
for (const n of p.nodes) {
  if (n.callFrame.functionName !== name) continue;
  // inclusive time of this node = sum self of subtree
  let total = 0; const stack = [n.id]; while (stack.length) { const id = stack.pop(); total += self.get(id) || 0; for (const c of nodes.get(id).children || []) stack.push(c); }
  if (!total) continue;
  const path = []; let pid = parent.get(n.id); while (pid != null && path.length < depth) { path.push(key(nodes.get(pid))); pid = parent.get(pid); }
  const k = path.join(' <- '); chains.set(k, (chains.get(k) || 0) + total);
}
for (const [k, v] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log((v / 1000).toFixed(1).padStart(7) + 'ms  ' + k);
