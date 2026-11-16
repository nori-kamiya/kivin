/** @jsxImportSource @kivinjs/jsx */
import { createContext, jsonScript, raw, renderToReadableStream, renderToString, Suspense, useContext, type Child } from '@kivinjs/jsx';
import { describe, expect, spyOn, test } from 'bun:test';

const PAYLOAD = `"><script>alert(1)</script><img src=x onerror=alert(2)>'`;

describe('escaping (XSS regressions)', () => {
  test('given hostile text, when rendered as a child, then it is escaped', async () => {
    expect(await renderToString(<p>{PAYLOAD}</p>)).toBe('<p>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&#39;</p>');
  });

  test('given hostile attribute values, when rendered, then quotes and brackets cannot leave the attribute', async () => {
    const html = await renderToString(<a href={PAYLOAD} title={PAYLOAD} class={[PAYLOAD]} style={{ color: PAYLOAD }} data-x={PAYLOAD}>x</a>);

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html.match(/"/g)?.length).toBe(10);
  });

  test('given a hostile attribute name from a spread, when rendered, then it throws instead of writing it', async () => {
    const props = { 'onmouseover="alert(1)"': 'x' } as Record<string, string>;
    await expect(renderToString(<div {...props} />)).rejects.toThrow(/invalid attribute name/);
    await expect(renderToString(<div {...{ 'a b': 'x' }} />)).rejects.toThrow(/invalid attribute name/);
  });

  test('given text inside script and style, when rendered, then it is escaped like any text', async () => {
    expect(await renderToString(<script>{'</script><script>alert(1)</script>'}</script>)).toBe('<script>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</script>');
    expect(await renderToString(<style>{'</style><script>alert(1)</script>'}</style>)).toBe('<style>&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;</style>');
  });

  test('given data for a script, when embedded with jsonScript, then it cannot close the script and still parses', async () => {
    const data = { name: '</script><script>alert(1)</script>', amp: 'a&b', line: '\u2028' };
    const html = await renderToString(<script type="application/json">{jsonScript(data)}</script>);
    const body = html.slice('<script type="application/json">'.length, -'</script>'.length);

    expect(body).not.toContain('<');
    expect(JSON.parse(body)).toEqual(data);
  });

  test('given an invalid element type, when rendered, then it throws', async () => {
    const Tag = 'img src=x onerror=alert(1)' as 'div';
    await expect(renderToString(<Tag />)).rejects.toThrow(/invalid element type/);
  });

  test('given raw HTML or dangerouslySetInnerHTML, when rendered, then only they skip escaping', async () => {
    expect(await renderToString(<div>{raw('<b>ok</b>')}</div>)).toBe('<div><b>ok</b></div>');
    expect(await renderToString(<div dangerouslySetInnerHTML={{ __html: '<i>ok</i>' }} />)).toBe('<div><i>ok</i></div>');
  });
});

describe('attributes', () => {
  test('given booleans, when rendered, then true is a bare attribute, false is dropped and aria / data keep the value', async () => {
    expect(await renderToString(<input disabled checked={false} aria-hidden={true} data-on={false} />)).toBe('<input disabled aria-hidden="true" data-on="false">');
  });

  test('given class lists and records and a style object, when rendered, then they are flattened', async () => {
    expect(await renderToString(<div className={['a', false, ['b']]} class={{ c: true, d: false }} style={{ fontSize: '12px', '--gap': 4, color: null }} />))
      .toBe('<div class="a b c" style="font-size:12px;--gap:4"></div>');
  });

  test('given htmlFor, functions, null and undefined, when rendered, then for is written and the rest is dropped', async () => {
    const handlers = { onclick: () => undefined } as Record<string, unknown>;
    expect(await renderToString(<label htmlFor="name" {...handlers} title={undefined} hidden={null}>Name</label>)).toBe('<label for="name">Name</label>');
  });

  test('given void and normal elements, when rendered, then void ones have no closing tag', async () => {
    expect(await renderToString(<><br /><img src="/a.png" alt="" /><span /></>)).toBe('<br><img src="/a.png" alt=""><span></span>');
  });
});

describe('components', () => {
  const Greeting = ({ name }: { name: string }) => <b>Hello, {name}</b>;
  const Later = async ({ ms, label }: { ms: number; label: string }) => {
    await Bun.sleep(ms);
    return <i>{label}</i>;
  };

  test('given components, fragments, arrays and numbers, when rendered, then they compose in order', async () => {
    const items = ['a', 'b'];
    expect(await renderToString(<ul>{items.map((item, index) => <li key={item}>{index}:{item}</li>)}<Greeting name="Ada" /></ul>))
      .toBe('<ul><li>0:a</li><li>1:b</li><b>Hello, Ada</b></ul>');
  });

  test('given async components, when rendered to a string, then their output is awaited in place', async () => {
    expect(await renderToString(<p><Later ms={5} label="slow" /> and <Later ms={0} label="fast" /></p>)).toBe('<p><i>slow</i> and <i>fast</i></p>');
  });

  test('given a context provider, when nested components read it, then they get the nearest value or the default', async () => {
    const Theme = createContext('light');
    const Show = () => <span>{useContext(Theme)}</span>;
    const AsyncShow = async () => {
      const theme = useContext(Theme);
      await Bun.sleep(1);
      return <em>{theme}</em>;
    };

    expect(await renderToString(<><Show /><Theme.Provider value="dark"><Show /><AsyncShow /></Theme.Provider></>)).toBe('<span>light</span><span>dark</span><em>dark</em>');
    expect(() => useContext(Theme)).toThrow(/while a component renders/);
  });

  test('given a component that throws, when rendered, then rendering rejects', async () => {
    const Broken = (): Child => {
      throw new Error('broken');
    };
    await expect(renderToString(<div><Broken /></div>)).rejects.toThrow('broken');
  });
});

describe('streaming', () => {
  const Slow = async ({ label }: { label: string }) => {
    await Bun.sleep(30);
    return <p>{label}</p>;
  };

  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      chunks.push(decoder.decode(chunk));
    }
    return chunks;
  };

  test('given a Suspense boundary, when streamed, then the shell with the fallback comes first and the content follows with its swap script', async () => {
    const stream = await renderToReadableStream(
      <main><h1>Title</h1><Suspense fallback={<span>loading</span>}><Slow label="done" /></Suspense></main>,
      { prefix: '<!DOCTYPE html>', nonce: 'n0"' },
    );
    const chunks = await read(stream);

    expect(chunks[0]).toBe('<!DOCTYPE html><main><h1>Title</h1><template id="ks:0"></template><span>loading</span><!--/ks:0--></main>');
    expect(chunks[1]).toStartWith('<template data-ks="0"><p>done</p></template><script nonce="n0&quot;">');
    expect(chunks).toHaveLength(2);
  });

  test('given a Suspense boundary, when rendered to a string, then the content is awaited and the fallback never appears', async () => {
    expect(await renderToString(<Suspense fallback="loading"><Slow label="done" /></Suspense>)).toBe('<p>done</p>');
  });

  test('given nested boundaries, when streamed, then each streams its content once resolved', async () => {
    const chunks = await read(await renderToReadableStream(
      <Suspense fallback="outer"><Slow label="a" /><Suspense fallback="inner"><Slow label="b" /></Suspense></Suspense>,
    ));
    const html = chunks.join('');

    expect(chunks[0]).toBe('<template id="ks:0"></template>outer<!--/ks:0-->');
    expect(html).toContain('<template data-ks="0"><p>a</p><template id="ks:1"></template>inner<!--/ks:1--></template>');
    expect(html).toContain('<template data-ks="1"><p>b</p></template>');
  });

  test('given a boundary that fails, when streamed, then the fallback stays and the error is logged', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const Failing = async (): Promise<Child> => {
      await Bun.sleep(1);
      throw new Error('late failure');
    };
    try {
      const chunks = await read(await renderToReadableStream(<Suspense fallback="soon"><Failing /></Suspense>));

      expect(chunks).toEqual(['<template id="ks:0"></template>soon<!--/ks:0-->']);
      expect(consoleError).toHaveBeenCalledWith('[kivin] Suspense boundary failed', expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  test('given an error in the shell, when streamed, then the promise rejects before any byte', async () => {
    const Broken = (): Child => {
      throw new Error('shell');
    };
    await expect(renderToReadableStream(<div><Broken /></div>)).rejects.toThrow('shell');
  });
});
