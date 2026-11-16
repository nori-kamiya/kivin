export class PostStore {
  posts: Array<{ slug: string; title: string }> = [];

  // Stands in for a database: the data only exists once the app is initialised.
  onModuleInit() {
    this.posts = [{ slug: 'hello', title: 'Hello <world>' }, { slug: 'second', title: 'Second' }];
  }
}

export const store = new PostStore();
