// Test worker (office-isolated.test.ts): fails like a parser crash whose message quotes the document.
throw Object.assign(new TypeError("Contenu secret du document : code du portail 4521"), { code: "ERR_TEST_PARSER" });

export {};
