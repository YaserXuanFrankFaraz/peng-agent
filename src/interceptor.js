export function createInterceptor() {
  const handlers = new Map();
  return {
    use(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => handlers.set(event, list.filter((item) => item !== handler));
    },
    async run(event, payload) {
      let current = payload;
      for (const handler of handlers.get(event) ?? []) current = await handler(current);
      return current;
    }
  };
}

export async function applyInterceptors(interceptors = [], payload) {
  let current = payload;
  for (const interceptor of interceptors) current = await interceptor(current);
  return current;
}
