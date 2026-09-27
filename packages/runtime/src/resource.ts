/**
 * Typing helper for a resource `source`: an object with list/find/create/
 * update/remove. `defineResource` is an identity function that pins the
 * shape so a typo is a compile error rather than a runtime surprise.
 */
export interface ResourceSource<T extends { id: string }, Input = Omit<T, "id">> {
  list(): Promise<T[]>;
  find(id: string): Promise<T | undefined>;
  create(input: Input): Promise<T>;
  update(id: string, input: Partial<Input>): Promise<T | undefined>;
  remove(id: string): Promise<void>;
}

export function defineResource<T extends { id: string }, Input = Omit<T, "id">>(source: ResourceSource<T, Input>): ResourceSource<T, Input> {
  return source;
}

/** A Map-backed source for prototypes and tests. Survives HMR when given a global key. */
export function memoryResource<T extends { id: string }>(seed: T[] = [], globalKey?: string): ResourceSource<T> {
  const g = globalThis as unknown as Record<string, Map<string, T> | undefined>;
  const store: Map<string, T> = (globalKey && g[globalKey]) || new Map(seed.map((t) => [t.id, t]));
  if (globalKey) g[globalKey] = store;
  return {
    async list() {
      return [...store.values()];
    },
    async find(id) {
      return store.get(id);
    },
    async create(input) {
      const t = { ...(input as object), id: Math.random().toString(36).slice(2, 8) } as T;
      store.set(t.id, t);
      return t;
    },
    async update(id, input) {
      const t = store.get(id);
      if (!t) return undefined;
      const next = { ...t, ...(input as object) } as T;
      store.set(id, next);
      return next;
    },
    async remove(id) {
      store.delete(id);
    },
  };
}
