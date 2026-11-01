// In-process counters (next start runs server components, actions and route handlers in one process).
export const stats = (globalThis.__nwStats ??= { logins: 0, mutations: 0 });
