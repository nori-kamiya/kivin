import { gzipSync } from 'node:zlib';

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(name: string, size: number, type = '0'): Uint8Array {
  const block = new Uint8Array(512);
  const write = (offset: number, text: string) => block.set(new TextEncoder().encode(text), offset);
  write(0, name);
  write(100, octal(0o644, 8));
  write(108, octal(0, 8));
  write(116, octal(0, 8));
  write(124, octal(size, 12));
  write(136, octal(0, 12));
  write(148, '        ');
  write(156, type);
  write(257, 'ustar\0');
  write(263, '00');
  const sum = block.reduce((total, byte) => total + byte, 0);
  write(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return block;
}

/** Builds a gzip-compressed ustar archive the way `bun pm pack` lays it out: every path under `package/`. */
export function buildTarball(files: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = new TextEncoder().encode(content);
    chunks.push(header(`package/${path}`, data.length));
    chunks.push(data);
    chunks.push(new Uint8Array((512 - (data.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const tar = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.length;
  }
  return gzipSync(tar);
}

export function validPackageJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '@kivinjs/core',
    version: '1.2.3',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    engines: { bun: '>=1.4.0' },
    publishConfig: { access: 'public' },
    ...overrides,
  };
}

export function validFiles(packageJson: Record<string, unknown> = validPackageJson()): Record<string, string> {
  return {
    'package.json': JSON.stringify(packageJson),
    'README.md': '# kivin',
    LICENSE: 'MIT',
    'dist/index.js': 'export {}',
    'dist/index.d.ts': 'export {}',
  };
}
