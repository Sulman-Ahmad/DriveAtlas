// Preact + htm in one place, so every screen imports from here.
import { h, render, Fragment } from '/vendor/preact.mjs';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from '/vendor/hooks.mjs';
import htm from '/vendor/htm.mjs';

export const html = htm.bind(h);
export { h, render, Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback };

// Calls the hub API. Throws an Error with the hub's message on failure.
export async function api(method, url, body) {
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
