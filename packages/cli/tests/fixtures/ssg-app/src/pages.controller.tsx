/** @jsxImportSource @kivinjs/jsx */
import type { RouteInput } from '@kivinjs/core';
import { Controller, Get, Injectable, StaticParams, UseMiddleware } from '@kivinjs/decorators';
import { createJsxRenderer, render } from '@kivinjs/jsx';
import { store } from './posts';

export const Layout = createJsxRenderer(({ children }) => <html><body>{children}</body></html>);

@Controller('/')
@Injectable()
export class PagesController {
  @Get('/')
  @UseMiddleware(Layout)
  home({ context }: RouteInput) {
    return render(context, <ul>{store.posts.map((post) => <li key={post.slug}><a href={`/posts/${post.slug}`}>{post.title}</a></li>)}</ul>);
  }

  @Get('/posts/:slug')
  @UseMiddleware(Layout)
  @StaticParams(() => store.posts.map(({ slug }) => ({ slug })))
  post({ params, context }: RouteInput) {
    const post = store.posts.find((item) => item.slug === params.slug);
    return render(context, <h1>{post?.title ?? 'missing'}</h1>, post ? {} : { status: 404 });
  }

  @Get('/api/posts')
  list() {
    return store.posts;
  }

  @Get('/users/:id')
  user({ params }: RouteInput) {
    return { id: params.id };
  }

  @Get('/admin')
  admin() {
    return new Response('secret', { headers: { 'content-type': 'text/html' } });
  }
}
