import { describe, expect, test } from "vitest";
import { callTool } from "../src/engine/fake-engine.ts";
import { ToolCatalog } from "../src/tools/catalog.ts";
import { weatherTools } from "../src/tools/weather.ts";
import { createTestTurn, KEVIN, testRequest } from "./helpers.ts";

const CONV = "11111111-1111-4111-8111-111111111111";
/** Shape of a real Open-Meteo answer (2026-10-04). */
const SAMPLE = {
  latitude: 48.84, longitude: 2.36, timezone: "Europe/Paris",
  current: { time: "2026-10-04T23:00", interval: 900, temperature_2m: 19.0, apparent_temperature: 18.4, weather_code: 0, wind_speed_10m: 8.0, precipitation: 0.0 },
  daily: {
    time: ["2026-10-04", "2026-10-05"], weather_code: [3, 61],
    temperature_2m_max: [24.9, 24.1], temperature_2m_min: [13.9, 13.8], precipitation_probability_max: [35, null],
  },
};

function setup(answer: () => Promise<Response>, home = { latitude: 48.85, longitude: 2.35 }) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init });
    return answer();
  };
  const provider = weatherTools({ home, timezone: "Europe/Paris", fetch: fakeFetch });
  const { turn, end } = createTestTurn(KEVIN, CONV);
  const tools = new ToolCatalog([provider]).forTurn(turn);
  return { calls, turn, end, request: testRequest({ tools }) };
}

const json = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));
const UNAVAILABLE = {
  text: "Météo indisponible pour l'instant (le service ne répond pas). Ne devine pas : dis-le.", isError: true,
};

describe("weather", () => {
  test("now and day by day, in French, from the home coordinates; the turn stays trusted", async () => {
    const { calls, request, turn } = setup(json(SAMPLE));
    const result = await callTool(request, "weather", {});
    expect(result).toEqual({
      text: [
        "Maintenant : 19 °C (ressenti 18 °C), ciel dégagé, vent 8 km/h.",
        "dimanche 4 octobre : 14 à 25 °C, couvert, pluie 35 %.",
        "lundi 5 octobre : 14 à 24 °C, pluie faible.",
      ].join("\n"),
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe("48.85");
    expect(url.searchParams.get("longitude")).toBe("2.35");
    expect(url.searchParams.get("timezone")).toBe("Europe/Paris");
    expect(url.searchParams.get("forecast_days")).toBe("2");
    // Never waits forever on the service.
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(turn.untrusted).toBe(false);
  });

  test("rain falling now, and a weather code it does not know", async () => {
    const { request } = setup(json({
      ...SAMPLE,
      current: { ...SAMPLE.current, precipitation: 1.2, weather_code: 42 },
      daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [] },
    }));
    expect((await callTool(request, "weather", {})).text)
      .toBe("Maintenant : 19 °C (ressenti 18 °C), temps indéterminé, vent 8 km/h, 1,2 mm de pluie.");
  });

  test("only the coordinates rounded to about a kilometre leave the house", async () => {
    const { calls, request } = setup(json(SAMPLE), { latitude: 48.856_613, longitude: 2.352_222 });
    await callTool(request, "weather", {});
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("latitude")).toBe("48.86");
    expect(url.searchParams.get("longitude")).toBe("2.35");
  });

  test("the request stops when the turn ends", async () => {
    const { calls, end, request } = setup(json(SAMPLE));
    await callTool(request, "weather", {});
    const signal = calls[0]?.init?.signal;
    expect(signal?.aborted).toBe(false);
    end();
    expect(signal?.aborted).toBe(true);
  });

  test("days: 1 to 7", async () => {
    const { calls, request } = setup(json(SAMPLE));
    await callTool(request, "weather", { days: 7 });
    expect(new URL(calls[0]?.url ?? "").searchParams.get("forecast_days")).toBe("7");
    await expect(callTool(request, "weather", { days: 8 })).rejects.toThrow();
    await expect(callTool(request, "weather", { days: 0 })).rejects.toThrow();
  });

  test.each([
    ["HTTP error", json({ error: true }, 500)],
    ["unexpected answer", json({ current: {} })],
    ["days that are not dates", json({ ...SAMPLE, daily: { ...SAMPLE.daily, time: ["demain", "après"] } })],
    ["not JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    ["network failure", () => Promise.reject(new Error("offline"))],
  ])("%s: says it is unavailable, never makes up a forecast", async (_label, answer) => {
    const { request } = setup(answer);
    expect(await callTool(request, "weather", {})).toEqual(UNAVAILABLE);
  });
});
