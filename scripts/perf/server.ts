// Network benchmark server for scripts/perf-regression.ts (compiled with `bun build --compile`).
import { createBenchApp } from './bench-app';

const server = createBenchApp().listen(Number(process.env.PORT ?? 0));
console.log(`READY ${server.port}`);
