// Must stay the first import: it configures Zod before any schema is created.
import "./zod-config.ts";
import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (target === null) throw new Error("Missing #app element");
mount(App, { target });
