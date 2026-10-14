// Pure rules for the fields Jira offers when creating an issue (its createmeta): which ones pjPlanner can fill, and how a
// submitted value becomes the JSON shape Jira expects. Nothing here touches the database or the network.
import { bad } from './errors.js';

export type FieldKind = 'string' | 'text' | 'number' | 'date' | 'datetime' | 'option' | 'priority' | 'component' | 'version' | 'user' | 'labels' | 'unsupported';

export interface AllowedValue { id?: string; name: string; value?: string }
export interface FieldDescriptor {
  id: string;
  name: string;
  required: boolean;
  kind: FieldKind;
  multi?: boolean;
  allowedValues?: AllowedValue[];
  unsupported?: boolean;
}

// pjPlanner sets these itself (or never); they are never offered as form fields.
export const SKIPPED_FIELDS = ['project', 'issuetype', 'summary', 'description', 'labels', 'parent', 'reporter', 'attachment'];

const SIMPLE: Record<string, FieldKind> = { string: 'string', number: 'number', date: 'date', datetime: 'datetime', option: 'option', priority: 'priority', user: 'user', component: 'component', version: 'version' };
const ITEM: Record<string, FieldKind> = { option: 'option', string: 'labels', component: 'component', version: 'version', user: 'user' };

const allowed = (list: unknown): AllowedValue[] | undefined => {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.filter((a) => a && typeof a === 'object').map((a: any) => ({
    ...(a.id != null ? { id: String(a.id) } : {}),
    name: String(a.name ?? a.value ?? a.id ?? ''),
    ...(a.value != null ? { value: String(a.value) } : {}),
  }));
};

// One entry of Jira's createmeta (either response shape; the id is `fieldId`, `key` or `id`) as a descriptor.
export function normaliseField(raw: any): FieldDescriptor {
  const schema = raw?.schema ?? {};
  const id = String(raw?.fieldId ?? raw?.key ?? raw?.id ?? '');
  const isArray = schema.type === 'array';
  let kind: FieldKind = (isArray ? ITEM[schema.items] : SIMPLE[schema.type]) ?? 'unsupported';
  if (kind === 'string' && (/textarea/i.test(String(schema.custom ?? '')) || schema.system === 'environment')) kind = 'text';
  // A cascading select carries child options pjPlanner cannot choose.
  if (kind === 'option' && Array.isArray(raw?.allowedValues) && raw.allowedValues.some((a: any) => a?.children)) kind = 'unsupported';
  const d: FieldDescriptor = {
    id, name: String(raw?.name ?? id),
    // A required field with a default value is filled in by Jira when left out.
    required: Boolean(raw?.required) && !raw?.hasDefaultValue,
    kind,
  };
  if (isArray && kind !== 'unsupported') d.multi = true;
  const av = allowed(raw?.allowedValues);
  if (av && kind !== 'unsupported') d.allowedValues = av;
  if (kind === 'unsupported') d.unsupported = true;
  return d;
}

// All descriptors of a createmeta, minus the fields pjPlanner owns and the extra ids (Epic Link, Epic Name, Parent Link) to skip.
export function normaliseFields(raws: unknown[], skip: (string | null | undefined)[] = []): FieldDescriptor[] {
  const skipped = new Set<string>([...SKIPPED_FIELDS, ...skip.filter((s): s is string => Boolean(s))]);
  return raws.map(normaliseField).filter((d) => d.id && !skipped.has(d.id));
}

// A label is a non-empty string without whitespace.
export const isLabel = (l: unknown): l is string => typeof l === 'string' && l.trim() !== '' && !/\s/.test(l.trim());

const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

const scalar = (d: FieldDescriptor, v: unknown): unknown => {
  const fail = (why: string) => bad(`field ${d.name} (${d.id}) ${why}`);
  switch (d.kind) {
    case 'string': case 'text':
      if (typeof v !== 'string') throw fail('must be a string');
      return v.trim();
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw fail('must be a number');
      return v;
    case 'date': {
      if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v) || Number.isNaN(Date.parse(v))) throw fail('must be a date as YYYY-MM-DD');
      return v;
    }
    case 'datetime': {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      if (Number.isNaN(t)) throw fail('must be an ISO date-time');
      return new Date(t).toISOString().replace('Z', '+0000');
    }
    case 'option': case 'priority': case 'component': case 'version': {
      if (typeof v !== 'string' && typeof v !== 'number') throw fail('must be the id of one of its allowed values');
      const given = String(v);
      if (!d.allowedValues) return { id: given };
      // An option without an id (some Jira versions) is matched by its value, a priority, component or version by its name.
      const byId = d.allowedValues.find((a) => a.id === given);
      if (byId) return { id: given };
      if (d.kind === 'option') {
        const byValue = d.allowedValues.find((a) => a.value === given);
        if (byValue) return { value: byValue.value };
      }
      const byName = d.allowedValues.find((a) => a.id == null && a.name === given);
      if (byName) return d.kind === 'option' ? { value: byName.name } : { name: byName.name };
      throw fail(`has no allowed value ${given}`);
    }
    case 'user':
      if (typeof v !== 'string' || !v.trim()) throw fail('must be a user name');
      return { name: v.trim() };
    default:
      throw fail('cannot be set from pjPlanner');
  }
};

// One submitted value in the shape Jira wants: {id} for options, priorities, components and versions, {name} for users, arrays for multi fields.
export function toJiraValue(d: FieldDescriptor, v: unknown): unknown {
  if (d.kind === 'labels') {
    if (!Array.isArray(v) || !v.every(isLabel)) throw bad(`field ${d.name} (${d.id}) must be a list of labels without spaces`);
    return v.map((x: string) => x.trim());
  }
  if (d.multi) {
    if (!Array.isArray(v)) throw bad(`field ${d.name} (${d.id}) must be a list`);
    return v.map((x) => scalar(d, x));
  }
  return scalar(d, v);
}

// Checks the submitted values against the fields Jira offers and returns them ready to merge into a create payload.
// Unknown or unsupported ids, malformed values and missing required fields are all 400s. When Jira's field list could not
// be read (`readable` false) nothing can be validated, so any extra field is refused and only base-field creates go through.
export function validateFields(descriptors: FieldDescriptor[], given: Record<string, unknown>, readable = true): Record<string, unknown> {
  if (!readable && Object.values(given).some((v) => !empty(v))) throw bad('Jira did not tell us which fields it offers, so extra fields cannot be sent');
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  const out: Record<string, unknown> = {};
  for (const [fid, v] of Object.entries(given)) {
    const d = byId.get(fid);
    if (!d) throw bad(`field ${fid} is not available when creating this issue in Jira`);
    if (d.unsupported) throw bad(`field ${d.name} (${fid}) cannot be set from pjPlanner`);
    if (empty(v)) continue;
    out[fid] = toJiraValue(d, v);
  }
  const blocked = descriptors.find((d) => d.required && d.unsupported);
  if (blocked) throw bad(`field ${blocked.name} (${blocked.id}) is required by Jira but pjPlanner cannot fill it`);
  const missing = descriptors.filter((d) => d.required && !d.unsupported && !(d.id in out));
  if (missing.length) throw bad(`missing required field${missing.length > 1 ? 's' : ''}: ${missing.map((d) => `${d.name} (${d.id})`).join(', ')}`);
  return out;
}

export type UploadDefault = string | number | (string | number)[];
export interface UploadConfig { hidden: string[]; defaults: Record<string, UploadDefault> }
export const emptyUploadConfig = (): UploadConfig => ({ hidden: [], defaults: {} });

// A project's stored upload-form settings (JSON text or an already parsed value) as a config. Unreadable stored text gives the empty config.
export function readUploadConfig(stored: unknown): UploadConfig {
  if (stored == null || stored === '') return emptyUploadConfig();
  try { return parseUploadConfig(typeof stored === 'string' ? JSON.parse(stored) : stored); } catch { return emptyUploadConfig(); }
}

// Validates the config a client sends: `{hidden: string[], defaults: {fieldId: string | number | list of those}}`. Field ids are not checked against Jira.
export function parseUploadConfig(raw: unknown): UploadConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('jiraUploadConfig must be an object');
  const b = raw as Record<string, unknown>;
  const hiddenRaw = b.hidden ?? [];
  if (!Array.isArray(hiddenRaw) || hiddenRaw.length > 200 || !hiddenRaw.every((h) => typeof h === 'string' && h.trim() !== '')) throw bad('jiraUploadConfig.hidden must be a list of at most 200 field ids');
  const defaultsRaw = b.defaults ?? {};
  if (!defaultsRaw || typeof defaultsRaw !== 'object' || Array.isArray(defaultsRaw)) throw bad('jiraUploadConfig.defaults must be an object');
  const one = (v: unknown) => (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v));
  const defaults: Record<string, UploadDefault> = {};
  for (const [k, v] of Object.entries(defaultsRaw)) {
    if (k.trim() === '') throw bad('jiraUploadConfig.defaults keys must be field ids');
    if (!(one(v) || (Array.isArray(v) && v.every(one)))) throw bad(`jiraUploadConfig.defaults.${k} must be a string, a number or a list of those`);
    defaults[k] = v as UploadDefault;
  }
  return { hidden: [...new Set((hiddenRaw as string[]).map((h) => h.trim()))], defaults };
}

// Marks each descriptor with the project's default (only when it still passes the field's checks, so a stale one is dropped) and `hidden`.
// A required field without a usable default stays visible, and a required field pjPlanner cannot fill cannot be hidden.
export function applyUploadConfig(descriptors: FieldDescriptor[], config: UploadConfig): (FieldDescriptor & { default?: UploadDefault; hidden?: true })[] {
  const hidden = new Set(config.hidden);
  return descriptors.map((d) => {
    const out: FieldDescriptor & { default?: UploadDefault; hidden?: true } = { ...d };
    let usable = false;
    if (!d.unsupported && Object.hasOwn(config.defaults, d.id) && !empty(config.defaults[d.id])) {
      try { toJiraValue(d, config.defaults[d.id]); out.default = config.defaults[d.id]; usable = true; } catch { /* stale default */ }
    }
    if (hidden.has(d.id) && !(d.required && (d.unsupported || !usable))) out.hidden = true;
    return out;
  });
}

// Values for hidden fields the client did not send: the project's default, so a hidden field is always sent with it.
export function withHiddenDefaults(descriptors: FieldDescriptor[], config: UploadConfig, given: Record<string, unknown>): Record<string, unknown> {
  const out = { ...given };
  for (const d of applyUploadConfig(descriptors, config)) if (d.hidden && d.default !== undefined && !(d.id in out)) out[d.id] = d.default;
  return out;
}
