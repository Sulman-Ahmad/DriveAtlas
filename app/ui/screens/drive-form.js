// The drive details form, used by Add drive and by Edit on the drive page.
import { html, useState } from '../lib.js';
import { Field, ErrorNote, Icon } from '../components.js';
import { DRIVE_TYPES, STATUSES } from '/shared/drive-types.js';

const toGB = (bytes) => (bytes ? +(bytes / 1e9).toFixed(bytes % 1e9 === 0 ? 0 : 1) : '');

export function DriveForm({ initial = {}, showType = false, submitLabel = 'Save', busy, error, onSubmit, onCancel, typeOverride }) {
  const [v, setV] = useState(() => ({
    name: '', brand: '', model: '', serial: '', status: 'stored', location: '', lent_to: '', due_back: '', notes: '',
    other_kind: '', interface: '', rated_read_mbs: '', rated_write_mbs: '', speed_class: '', purchase_price: '',
    purchase_date: '', shop: '', warranty_until: '', type: 'usb', ...strip(initial),
    capacityGB: toGB(initial.advertised_bytes), tagsText: (initial.tags || []).join(', ')
  }));
  const [more, setMore] = useState(Boolean(initial.purchase_price || initial.purchase_date || initial.shop || initial.warranty_until));
  const [specs, setSpecs] = useState(Boolean(initial.interface || initial.rated_read_mbs || initial.speed_class));
  const type = typeOverride || v.type;
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });

  function submit(e) {
    e.preventDefault();
    const out = {
      type, name: v.name.trim(), brand: v.brand, model: v.model, serial: v.serial, status: v.status, location: v.location,
      lent_to: v.status === 'lent' ? v.lent_to : null, due_back: v.status === 'lent' ? v.due_back : null, notes: v.notes,
      other_kind: type === 'other' ? v.other_kind : null, interface: v.interface, speed_class: v.speed_class,
      rated_read_mbs: v.rated_read_mbs, rated_write_mbs: v.rated_write_mbs, purchase_price: v.purchase_price,
      purchase_date: v.purchase_date, shop: v.shop, warranty_until: v.warranty_until,
      advertised_bytes: v.capacityGB === '' ? null : Math.round(Number(v.capacityGB) * 1e9),
      tags: v.tagsText.split(',').map((t) => t.trim()).filter(Boolean)
    };
    onSubmit(out);
  }

  return html`<form class="form" onSubmit=${submit}>
    ${showType ? html`<${Field} label="Type" id="f-type"><select id="f-type" value=${v.type} onChange=${set('type')}>
      ${DRIVE_TYPES.map((t) => html`<option value=${t.id}>${t.name}</option>`)}</select></${Field}>` : null}
    <div class="form-grid">
      <${Field} label="Name" id="f-name" hint="Your own name for it, e.g. Movies Archive"><input id="f-name" value=${v.name} onInput=${set('name')} required maxlength="80" autofocus /></${Field}>
      ${type === 'other' ? html`<${Field} label="Kind" id="f-kind" hint="e.g. DVD, Blu-ray, Tape"><input id="f-kind" value=${v.other_kind} onInput=${set('other_kind')} maxlength="40" /></${Field}>` : null}
      <${Field} label="Brand" id="f-brand"><input id="f-brand" value=${v.brand} onInput=${set('brand')} maxlength="60" /></${Field}>
      <${Field} label="Model" id="f-model"><input id="f-model" value=${v.model} onInput=${set('model')} maxlength="80" /></${Field}>
      <${Field} label="Capacity on the label (GB)" id="f-cap" hint="1 TB = 1000 GB. Usable space is worked out for you."><input id="f-cap" type="number" min="0" step="any" inputmode="decimal" value=${v.capacityGB} onInput=${set('capacityGB')} /></${Field}>
      <${Field} label="Serial number" id="f-serial"><input id="f-serial" value=${v.serial} onInput=${set('serial')} maxlength="80" /></${Field}>
      <${Field} label="Status" id="f-status"><select id="f-status" value=${v.status} onChange=${set('status')}>
        ${STATUSES.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select></${Field}>
      <${Field} label="Where you keep it" id="f-loc" hint="e.g. Shelf B, box 2"><input id="f-loc" value=${v.location} onInput=${set('location')} maxlength="80" /></${Field}>
      ${v.status === 'lent' ? html`
        <${Field} label="Lent to" id="f-lent"><input id="f-lent" value=${v.lent_to} onInput=${set('lent_to')} maxlength="60" /></${Field}>
        <${Field} label="Due back" id="f-due"><input id="f-due" type="date" value=${v.due_back} onInput=${set('due_back')} /></${Field}>` : null}
      <${Field} label="Tags" id="f-tags" hint="Separate with commas"><input id="f-tags" value=${v.tagsText} onInput=${set('tagsText')} maxlength="200" /></${Field}>
    </div>
    <${Field} label="Notes" id="f-notes"><textarea id="f-notes" rows="3" value=${v.notes} onInput=${set('notes')} maxlength="2000"></textarea></${Field}>

    <button type="button" class="disclosure" aria-expanded=${specs} onClick=${() => setSpecs(!specs)}><${Icon} name=${specs ? 'down' : 'right'} size=${16} />Specs (optional)</button>
    ${specs ? html`<div class="form-grid">
      <${Field} label="Interface" id="f-if" hint="e.g. USB 3.2 Gen 2, PCIe 4.0 x4"><input id="f-if" value=${v.interface} onInput=${set('interface')} maxlength="60" /></${Field}>
      <${Field} label="Speed class" id="f-class" hint="SD cards: e.g. U3, V30, A2"><input id="f-class" value=${v.speed_class} onInput=${set('speed_class')} maxlength="30" /></${Field}>
      <${Field} label="Rated read (MB/s)" id="f-read"><input id="f-read" type="number" min="0" value=${v.rated_read_mbs} onInput=${set('rated_read_mbs')} /></${Field}>
      <${Field} label="Rated write (MB/s)" id="f-write"><input id="f-write" type="number" min="0" value=${v.rated_write_mbs} onInput=${set('rated_write_mbs')} /></${Field}>
    </div>` : null}

    <button type="button" class="disclosure" aria-expanded=${more} onClick=${() => setMore(!more)}><${Icon} name=${more ? 'down' : 'right'} size=${16} />More details: purchase and warranty</button>
    ${more ? html`<div class="form-grid">
      <${Field} label="Price" id="f-price"><input id="f-price" value=${v.purchase_price} onInput=${set('purchase_price')} maxlength="30" /></${Field}>
      <${Field} label="Purchase date" id="f-pdate"><input id="f-pdate" type="date" value=${v.purchase_date} onInput=${set('purchase_date')} /></${Field}>
      <${Field} label="Shop" id="f-shop"><input id="f-shop" value=${v.shop} onInput=${set('shop')} maxlength="60" /></${Field}>
      <${Field} label="Warranty ends" id="f-warranty"><input id="f-warranty" type="date" value=${v.warranty_until} onInput=${set('warranty_until')} /></${Field}>
    </div>` : null}

    <${ErrorNote} error=${error} />
    <div class="form-actions">
      ${onCancel ? html`<button type="button" class="btn btn-secondary" onClick=${onCancel}>Cancel</button>` : null}
      <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? 'Saving…' : submitLabel}</button>
    </div>
  </form>`;
}

function strip(obj) {
  const out = {};
  for (const [k, val] of Object.entries(obj)) out[k] = val == null ? '' : val;
  return out;
}
