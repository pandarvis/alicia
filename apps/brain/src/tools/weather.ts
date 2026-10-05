import { z } from "zod";
import { defineTool, type ToolResult } from "../engine/tools.ts";
import type { ToolProvider } from "./catalog.ts";

export interface Home {
  latitude: number;
  longitude: number;
}

export interface WeatherOptions {
  home: Home;
  /** IANA name: the days of the forecast are the family's days. */
  timezone: string;
  fetch: typeof fetch;
}

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 10_000;
const DEFAULT_DAYS = 2;
const UNAVAILABLE: ToolResult = {
  text: "Météo indisponible pour l'instant (le service ne répond pas). Ne devine pas : dis-le.", isError: true,
};

/** The part of Open-Meteo's answer we use (checked: a changed or broken answer is "unavailable", never guessed). */
const Forecast = z.object({
  current: z.object({
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    weather_code: z.number().int(),
    wind_speed_10m: z.number(),
    precipitation: z.number(),
  }),
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number().int()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    precipitation_probability_max: z.array(z.number().nullable()),
  }),
});
type Forecast = z.infer<typeof Forecast>;

/** WMO weather codes used by Open-Meteo, in French. */
const WMO: Readonly<Record<number, string>> = {
  0: "ciel dégagé", 1: "plutôt dégagé", 2: "partiellement nuageux", 3: "couvert",
  45: "brouillard", 48: "brouillard givrant",
  51: "bruine légère", 53: "bruine", 55: "bruine dense", 56: "bruine verglaçante", 57: "forte bruine verglaçante",
  61: "pluie faible", 63: "pluie", 65: "forte pluie", 66: "pluie verglaçante", 67: "forte pluie verglaçante",
  71: "neige faible", 73: "neige", 75: "forte neige", 77: "grains de neige",
  80: "averses faibles", 81: "averses", 82: "violentes averses", 85: "averses de neige", 86: "fortes averses de neige",
  95: "orage", 96: "orage avec grêle", 99: "orage avec forte grêle",
};

const sky = (code: number): string => WMO[code] ?? "temps indéterminé";
const DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
/** Open-Meteo days are local dates: read them at noon UTC so no time zone shifts them. */
const dayLabel = (day: string): string => DAY.format(new Date(`${day}T12:00:00Z`));
const MILLIMETRES = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

export function forecastUrl(home: Home, timezone: string, days: number): string {
  const params = new URLSearchParams({
    latitude: String(home.latitude),
    longitude: String(home.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone,
    forecast_days: String(days),
  });
  return `${ENDPOINT}?${params.toString()}`;
}

export function formatForecast(forecast: Forecast): string {
  const now = forecast.current;
  const rain = now.precipitation > 0 ? `, ${MILLIMETRES.format(now.precipitation)} mm de pluie` : "";
  const lines = [
    `Maintenant : ${Math.round(now.temperature_2m)} °C (ressenti ${Math.round(now.apparent_temperature)} °C), ${sky(now.weather_code)}, vent ${Math.round(now.wind_speed_10m)} km/h${rain}.`,
  ];
  const daily = forecast.daily;
  for (const [i, day] of daily.time.entries()) {
    const code = daily.weather_code[i];
    const max = daily.temperature_2m_max[i];
    const min = daily.temperature_2m_min[i];
    if (code === undefined || max === undefined || min === undefined) continue;
    const chance = daily.precipitation_probability_max[i];
    const rainChance = chance === undefined || chance === null ? "" : `, pluie ${Math.round(chance)} %`;
    lines.push(`${dayLabel(day)} : ${Math.round(min)} à ${Math.round(max)} °C, ${sky(code)}${rainChance}.`);
  }
  return lines.join("\n");
}

/** The weather at home (Open-Meteo: no key; nothing about the family leaves the house but the coordinates). */
export function weatherTools(options: WeatherOptions): ToolProvider {
  return () => [
    defineTool({
      name: "weather",
      label: "Alicia regarde la météo…",
      description:
        "Météo à la maison : conditions actuelles et prévisions jour par jour. days : 1 à 7 (défaut 2, aujourd'hui et demain).",
      input: { days: z.number().int().min(1).max(7).optional() },
      async run({ days }) {
        let body: unknown;
        try {
          const response = await options.fetch(forecastUrl(options.home, options.timezone, days ?? DEFAULT_DAYS), {
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!response.ok) return UNAVAILABLE;
          body = await response.json();
        } catch {
          return UNAVAILABLE;
        }
        const parsed = Forecast.safeParse(body);
        return parsed.success ? { text: formatForecast(parsed.data) } : UNAVAILABLE;
      },
    }),
  ];
}
