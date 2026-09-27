/** An in-memory store so the example runs with no setup. Survives HMR via globalThis. */
export interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
}

const g = globalThis as unknown as { __todos?: Map<string, Todo> };
const todos =
  g.__todos ??
  (g.__todos = new Map<string, Todo>(
    [
      { id: "a1", title: "Run orchidery dev", done: true, createdAt: 1 },
      { id: "b2", title: "Press Alt+Shift+E and circle something", done: false, createdAt: 2 },
      { id: "c3", title: "Let an agent tend the annotation", done: false, createdAt: 3 },
    ].map((t) => [t.id, t]),
  ));

const wait = () => new Promise((r) => setTimeout(r, 5));

export const db = {
  async list(): Promise<Todo[]> {
    await wait();
    return [...todos.values()].sort((a, b) => a.createdAt - b.createdAt);
  },
  async find(id: string): Promise<Todo | undefined> {
    await wait();
    return todos.get(id);
  },
  async add(title: string): Promise<Todo> {
    await wait();
    const todo: Todo = { id: Math.random().toString(36).slice(2, 8), title, done: false, createdAt: Date.now() };
    todos.set(todo.id, todo);
    return todo;
  },
  async toggle(id: string): Promise<void> {
    await wait();
    const t = todos.get(id);
    if (t) t.done = !t.done;
  },
  async remove(id: string): Promise<void> {
    await wait();
    todos.delete(id);
  },
};
