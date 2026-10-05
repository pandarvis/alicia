// Test worker (office-isolated.test.ts): never answers, like a parser stuck on a huge document.
setInterval(() => undefined, 60_000);

export {};
