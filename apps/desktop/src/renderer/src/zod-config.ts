import { z } from "zod";

// Zod probes `new Function` when schemas are created, to speed up parsing; the page's CSP forbids it and
// Chromium logs an error. Imported first by main.ts, so this runs before any schema module is evaluated.
z.config({ jitless: true });
