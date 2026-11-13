// HTTP/1.1 load client for #65 that measures **server CPU time per request** instead of throughput:
// throughput on a shared 2-core VM varies ±15% between identical runs, while CPU µs per request of a
// server pinned to its own core (`taskset`) stays comparable. Each target is `port × path`; blocks run
// interleaved (A B …, then … B A) and every target is reported as a paired ratio to the first one,
// with a bootstrap 95% CI.
//
//   bun client.ts --ports 4651 --paths sync,resolved,pending,async     # one server, several routes
//   bun client.ts --ports 4701,4702 --paths item                       # base vs current server
//
// Env: CONNS (32), DEPTH (requests in flight per connection, 1 = no pipelining), BLOCK (requests per
// block, 30000), ROUNDS (16).
const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const ports = (flag('--ports') ?? '').split(',').filter(Boolean);
const paths = (flag('--paths') ?? 'sync').split(',').filter(Boolean);
if (ports.length === 0) {
  throw new Error('usage: bun client.ts --ports <port,...> [--paths <path,...>]');
}
const connections = Number(process.env.CONNS ?? 32);
const depth = Number(process.env.DEPTH ?? 1);
const perBlock = Number(process.env.BLOCK ?? 30_000);
const rounds = Number(process.env.ROUNDS ?? 16);
const targets = ports.flatMap((port) => paths.map((path) => ({ port, path, label: `${port} /${path}` })));

const encoder = new TextEncoder();
const cpu = async (port: string) => Number(await (await fetch(`http://127.0.0.1:${port}/cpu`)).text());

/** Sends `total` requests over `connections` sockets, `depth` in flight each; counts status lines. */
async function block(port: string, path: string, total: number) {
  const payload = encoder.encode(`GET /${path} HTTP/1.1\r\nHost: localhost\r\nOrigin: https://app.example\r\n\r\n`);
  const each = Math.ceil(total / connections);
  await Promise.all(Array.from({ length: connections }, () => new Promise<void>((resolve, reject) => {
    let sent = 0;
    let received = 0;
    let tail = '';
    const decoder = new TextDecoder();
    const pump = (socket: { write(data: Uint8Array): number }) => {
      while (sent < each && sent - received < depth) {
        socket.write(payload);
        sent += 1;
      }
    };
    void Bun.connect({
      hostname: '127.0.0.1',
      port: Number(port),
      socket: {
        open: pump,
        data(socket, data) {
          const text = tail + decoder.decode(data);
          let index = 0;
          while ((index = text.indexOf('HTTP/1.1 ', index)) !== -1) {
            received += 1;
            index += 9;
          }
          tail = text.slice(-8);
          if (received >= each) {
            socket.end();
            resolve();
          } else {
            pump(socket);
          }
        },
        error: (_socket, error) => reject(error),
      },
    });
  })));
  return each * connections;
}

async function measure(target: (typeof targets)[number]) {
  const before = await cpu(target.port);
  const count = await block(target.port, target.path, perBlock);
  return ((await cpu(target.port)) - before) / count;
}

for (const target of targets) {
  await block(target.port, target.path, perBlock);
}
const samples = targets.map(() => [] as number[]);
for (let round = 0; round < rounds; round += 1) {
  const order = round % 2 === 0 ? targets.map((_, index) => index) : targets.map((_, index) => targets.length - 1 - index);
  for (const index of order) {
    samples[index]!.push(await measure(targets[index]!));
  }
}

const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
for (const [index, target] of targets.entries()) {
  const ratios = samples[index]!.map((value, round) => value / samples[0]![round]!);
  const boots = Array.from({ length: 2000 }, () => median(ratios.map(() => ratios[Math.floor(Math.random() * ratios.length)]!))).sort((left, right) => left - right);
  const ci = index === 0 ? '' : ` [95% CI ${(boots[50]! * 100).toFixed(1)}–${(boots[1949]! * 100).toFixed(1)}%]`;
  console.log(`${target.label.padEnd(18)} ${median(samples[index]!).toFixed(3)} µs/req  ${(median(ratios) * 100).toFixed(1)}%${ci}`);
}
