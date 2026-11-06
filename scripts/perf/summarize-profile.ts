// Summarises a `bun --cpu-prof` profile: top functions by self time, and kivin source functions by
// inclusive time (time spent in them and everything they call).
//
//   bun scripts/perf/summarize-profile.ts <profile dir or .cpuprofile file> [top N]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

const [target, topText] = process.argv.slice(2);
if (!target) {
  throw new Error('usage: bun scripts/perf/summarize-profile.ts <dir | file.cpuprofile> [top N]');
}
const file = statSync(target).isDirectory()
  ? join(target, readdirSync(target).filter((name) => name.endsWith('.cpuprofile')).sort().at(-1) ?? '')
  : target;
const profile = JSON.parse(readFileSync(file, 'utf8')) as { nodes: ProfileNode[]; samples: number[] };
const top = Number(topText ?? 25);

const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map<number, number>();
for (const node of profile.nodes) {
  for (const child of node.children ?? []) {
    parent.set(child, node.id);
  }
}
const key = (id: number) => {
  const frame = nodes.get(id)!.callFrame;
  return `${frame.functionName || '(anonymous)'}  ${basename(frame.url) || '(native)'}:${frame.lineNumber + 1}`;
};

const selfSamples = new Map<number, number>();
for (const id of profile.samples) {
  selfSamples.set(id, (selfSamples.get(id) ?? 0) + 1);
}
const total = profile.samples.length;
const self = new Map<string, number>();
const inclusive = new Map<string, number>();
for (const [id, count] of selfSamples) {
  self.set(key(id), (self.get(key(id)) ?? 0) + count);
  const seen = new Set<string>();
  for (let current: number | undefined = id; current !== undefined; current = parent.get(current)) {
    const name = key(current);
    if (!seen.has(name)) {
      seen.add(name);
      inclusive.set(name, (inclusive.get(name) ?? 0) + count);
    }
  }
}

const print = (title: string, entries: Map<string, number>, filter: (name: string) => boolean) => {
  console.log(`\n${title}`);
  for (const [name, count] of [...entries].filter(([entry]) => filter(entry)).sort((left, right) => right[1] - left[1]).slice(0, top)) {
    console.log(`${((count / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
  }
};
console.log(`${file}: ${total} samples`);
print('self time', self, () => true);
print('inclusive time (TypeScript sources)', inclusive, (name) => /\.ts:\d+$/.test(name) && !name.includes('profile.ts'));
