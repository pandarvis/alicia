import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/base/schema.ts",
  out: "./drizzle",
});
