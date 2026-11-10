// Preact + htm in one place, so every screen imports from here.
import { h, render, Fragment } from '/vendor/preact.mjs';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from '/vendor/hooks.mjs';
import htm from '/vendor/htm.mjs';

export const html = htm.bind(h);
export { h, render, Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback };

// In the Android app the catalog lives on the phone: api() and openEvents() go to the phone's own
// local API instead of the PC hub. Set once at start-up by app.js.
let localHandler = null;
let eventsFactory = () => new EventSource('/api/events');
export function useLocalBackend(handle, openEvents) { localHandler = handle; eventsFactory = openEvents; }
export const openEvents = () => eventsFactory();
export const isLocalBackend = () => Boolean(localHandler);

// Calls the hub API. Throws an Error with the hub's message on failure.
export async function api(method, url, body) {
  if (localHandler) return localHandler(method, url, body);
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-DriveAtlas': '1' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `The hub answered ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function go(hash) { location.hash = hash; }
