export function createMessageWorker({ handler } = {}) {
  const history = [];
  return {
    history,
    async handle(message) {
      const startedAt = new Date().toISOString();
      if (typeof handler !== "function") {
        const result = { ok: false, error: "worker handler unavailable", message, startedAt, endedAt: startedAt };
        history.push(result);
        return result;
      }
      try {
        const value = await handler(message);
        const result = { ok: true, value, message, startedAt, endedAt: new Date().toISOString() };
        history.push(result);
        return result;
      } catch (error) {
        const result = { ok: false, error: error.message, message, startedAt, endedAt: new Date().toISOString() };
        history.push(result);
        return result;
      }
    },
    async drain(messages = []) {
      const results = [];
      for (const message of messages) results.push(await this.handle(message));
      return { ok: results.every((result) => result.ok), count: results.length, results };
    }
  };
}
