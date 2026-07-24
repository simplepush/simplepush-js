import { InvalidBaseUrlError } from "./errors.js";

export function parseBaseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (err) {
    throw new InvalidBaseUrlError(value, err);
  }
}

export function toWsScheme(url: URL): URL {
  const out = new URL(url.toString());
  if (out.protocol === "https:") out.protocol = "wss:";
  else if (out.protocol === "http:") out.protocol = "ws:";
  return out;
}
