// Must stay the first import: it configures Zod before any schema is created.
import "./zod-config.ts";
import { mount } from "svelte";
import { parseSurface } from "../../shared/surface.ts";
import App from "./App.svelte";
import HoloApp from "./HoloApp.svelte";
import SpotlightApp from "./SpotlightApp.svelte";
import "./app.css";

const surface = parseSurface(new URLSearchParams(location.search).get("surface"));
document.documentElement.dataset["surface"] = surface;
const target = document.getElementById("app");
if (target === null) throw new Error("Missing #app element");
if (surface === "holo") mount(HoloApp, { target });
else if (surface === "spotlight") mount(SpotlightApp, { target });
else mount(App, { target });
