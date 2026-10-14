import { describe, it, expect } from 'vitest';
import { normaliseField, normaliseFields, toJiraValue, validateFields, SKIPPED_FIELDS, type FieldDescriptor } from '../src/jiraMeta.js';

const raw = (schema: any, over: any = {}) => ({ fieldId: 'f1', name: 'F', required: false, schema, ...over });
const d = (kind: FieldDescriptor['kind'], over: Partial<FieldDescriptor> = {}): FieldDescriptor => ({ id: 'f1', name: 'F', required: false, kind, ...over });
const status = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.statusCode ?? e.status; } return 200; };

describe('normaliseField', () => {
  it.each([
    [{ type: 'string' }, 'string'], [{ type: 'number' }, 'number'], [{ type: 'date' }, 'date'], [{ type: 'datetime' }, 'datetime'],
    [{ type: 'option' }, 'option'], [{ type: 'priority' }, 'priority'], [{ type: 'user' }, 'user'],
    [{ type: 'component' }, 'component'], [{ type: 'version' }, 'version'], [{ type: 'weird' }, 'unsupported'], [{}, 'unsupported'],
  ])('maps %j to %s', (schema, kind) => {
    expect(normaliseField(raw(schema)).kind).toBe(kind);
  });

  it('maps arrays to multi kinds', () => {
    const k = (items: string) => normaliseField(raw({ type: 'array', items }));
    expect(k('option')).toMatchObject({ kind: 'option', multi: true });
    expect(k('string')).toMatchObject({ kind: 'labels', multi: true });
    expect(k('component')).toMatchObject({ kind: 'component', multi: true });
    expect(k('version')).toMatchObject({ kind: 'version', multi: true });
    expect(k('user')).toMatchObject({ kind: 'user', multi: true });
    const u = k('attachment');
    expect(u).toMatchObject({ kind: 'unsupported', unsupported: true });
    expect(u.multi).toBeUndefined();
  });

  it('a cascading select is unsupported and drops its allowed values', () => {
    const f = normaliseField(raw({ type: 'option' }, { allowedValues: [{ id: '1', value: 'A', children: [{ id: '2', value: 'B' }] }] }));
    expect(f).toMatchObject({ kind: 'unsupported', unsupported: true });
    expect(f.allowedValues).toBeUndefined();
  });

  it('a textarea custom string and the environment field are text', () => {
    expect(normaliseField(raw({ type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' })).kind).toBe('text');
    expect(normaliseField(raw({ type: 'string', system: 'environment' })).kind).toBe('text');
    expect(normaliseField(raw({ type: 'string', custom: 'x:textfield' })).kind).toBe('string');
  });

  it('reads the id from fieldId, key or id, and falls back to the id for the name', () => {
    expect(normaliseField({ key: 'k1', schema: { type: 'string' } })).toMatchObject({ id: 'k1', name: 'k1' });
    expect(normaliseField({ id: 'i1', name: 'N', schema: { type: 'string' } })).toMatchObject({ id: 'i1', name: 'N' });
  });

  it('required is false when Jira has a default value', () => {
    expect(normaliseField(raw({ type: 'string' }, { required: true })).required).toBe(true);
    expect(normaliseField(raw({ type: 'string' }, { required: true, hasDefaultValue: true })).required).toBe(false);
  });

  it('maps allowed values to id/name/value', () => {
    const f = normaliseField(raw({ type: 'option' }, { allowedValues: [{ id: 10, value: 'Red' }, { id: '11', name: 'Blue' }] }));
    expect(f.allowedValues).toEqual([{ id: '10', name: 'Red', value: 'Red' }, { id: '11', name: 'Blue' }]);
    expect(normaliseField(raw({ type: 'option' }, { allowedValues: [] })).allowedValues).toBeUndefined();
  });
});

describe('normaliseFields', () => {
  it('drops the fields pjPlanner owns and the extra ids', () => {
    const all = [...SKIPPED_FIELDS, 'customfield_1', 'customfield_2', 'customfield_3', 'keep'].map((id) => ({ fieldId: id, name: id, schema: { type: 'string' } }));
    expect(normaliseFields(all, ['customfield_1', 'customfield_2', null, undefined, 'customfield_3']).map((f) => f.id)).toEqual(['keep']);
    expect(SKIPPED_FIELDS).toEqual(expect.arrayContaining(['project', 'issuetype', 'summary', 'description', 'labels', 'parent', 'reporter', 'attachment']));
  });
  it('drops entries without an id', () => {
    expect(normaliseFields([{ schema: { type: 'string' } }])).toEqual([]);
  });
});

describe('toJiraValue', () => {
  it('string/text are trimmed and must be strings', () => {
    expect(toJiraValue(d('string'), '  a ')).toBe('a');
    expect(toJiraValue(d('text'), ' b')).toBe('b');
    expect(status(() => toJiraValue(d('string'), 5))).toBe(400);
  });
  it('number', () => {
    expect(toJiraValue(d('number'), 3.5)).toBe(3.5);
    expect(status(() => toJiraValue(d('number'), '3'))).toBe(400);
    expect(status(() => toJiraValue(d('number'), NaN))).toBe(400);
  });
  it('date', () => {
    expect(toJiraValue(d('date'), '2026-01-02')).toBe('2026-01-02');
    expect(status(() => toJiraValue(d('date'), '02/01/2026'))).toBe(400);
    expect(status(() => toJiraValue(d('date'), '2026-13-45'))).toBe(400);
    expect(status(() => toJiraValue(d('date'), 20260102))).toBe(400);
  });
  it('datetime becomes Jira\'s +0000 form', () => {
    expect(toJiraValue(d('datetime'), '2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000+0000');
    expect(status(() => toJiraValue(d('datetime'), 'nope'))).toBe(400);
  });
  it('option, priority, component and version become {id} and are checked against allowed ids', () => {
    for (const kind of ['option', 'priority', 'component', 'version'] as const) {
      const f = d(kind, { allowedValues: [{ id: '1', name: 'A' }] });
      expect(toJiraValue(f, '1')).toEqual({ id: '1' });
      expect(toJiraValue(f, 1)).toEqual({ id: '1' });
      expect(status(() => toJiraValue(f, '2'))).toBe(400);
      expect(status(() => toJiraValue(f, {}))).toBe(400);
    }
    expect(toJiraValue(d('option'), 'free')).toEqual({ id: 'free' });
  });
  it('user becomes {name}', () => {
    expect(toJiraValue(d('user'), ' jdoe ')).toEqual({ name: 'jdoe' });
    expect(status(() => toJiraValue(d('user'), '  '))).toBe(400);
  });
  it('labels must be a list of space-free strings', () => {
    expect(toJiraValue(d('labels', { multi: true }), ['a', 'b'])).toEqual(['a', 'b']);
    expect(status(() => toJiraValue(d('labels', { multi: true }), ['a b']))).toBe(400);
    expect(status(() => toJiraValue(d('labels', { multi: true }), 'a'))).toBe(400);
    expect(status(() => toJiraValue(d('labels', { multi: true }), [1]))).toBe(400);
  });
  it('multi fields map each item and need an array', () => {
    const f = d('option', { multi: true, allowedValues: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] });
    expect(toJiraValue(f, ['1', '2'])).toEqual([{ id: '1' }, { id: '2' }]);
    expect(status(() => toJiraValue(f, '1'))).toBe(400);
    expect(status(() => toJiraValue(f, ['1', '9']))).toBe(400);
  });
  it('unsupported cannot be set', () => {
    expect(status(() => toJiraValue(d('unsupported', { unsupported: true }), 'x'))).toBe(400);
  });
});

describe('toJiraValue id-less options and label trimming', () => {
  it('matches an id-less option by value, and a priority/component by name', () => {
    const opt = d('option', { allowedValues: [{ name: 'Red', value: 'Red' }, { name: 'Blue', value: 'Blue' }] });
    expect(toJiraValue(opt, 'Blue')).toEqual({ value: 'Blue' });
    expect(status(() => toJiraValue(opt, 'Green'))).toBe(400);
    const withId = d('option', { allowedValues: [{ id: '5', name: 'A', value: 'A' }] });
    expect(toJiraValue(withId, '5')).toEqual({ id: '5' });
    expect(toJiraValue(withId, 'A')).toEqual({ value: 'A' });
    const prio = d('priority', { allowedValues: [{ name: 'High' }] });
    expect(toJiraValue(prio, 'High')).toEqual({ name: 'High' });
    const comp = d('component', { multi: true, allowedValues: [{ name: 'Api' }] });
    expect(toJiraValue(comp, ['Api'])).toEqual([{ name: 'Api' }]);
  });

  it('trims a label before checking for inner spaces', () => {
    expect(toJiraValue(d('labels', { multi: true }), [' x '])).toEqual(['x']);
    expect(status(() => toJiraValue(d('labels', { multi: true }), [' a b ']))).toBe(400);
  });

  it('refuses extra fields when Jira fields are unreadable but allows none', () => {
    expect(validateFields([], {}, false)).toEqual({});
    expect(status(() => validateFields([], { customfield_1: 'x' }, false))).toBe(400);
  });
});

describe('validateFields', () => {
  const fields: FieldDescriptor[] = [
    d('string', { id: 'a', name: 'Alpha' }),
    d('number', { id: 'n', name: 'Num', required: true }),
    d('unsupported', { id: 'u', name: 'Unsup', unsupported: true }),
  ];
  const msg = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.message as string; } return ''; };

  it('converts valid values', () => {
    expect(validateFields(fields, { a: ' x ', n: 2 })).toEqual({ a: 'x', n: 2 });
  });
  it('rejects unknown ids and skipped ids (not in descriptors)', () => {
    expect(status(() => validateFields(fields, { n: 1, zzz: 'x' }))).toBe(400);
    expect(msg(() => validateFields(fields, { n: 1, summary: 'x' }))).toMatch(/summary/);
  });
  it('rejects a given unsupported field', () => {
    expect(msg(() => validateFields(fields, { n: 1, u: 'x' }))).toMatch(/cannot be set from pjPlanner/);
  });
  it('names missing required fields', () => {
    expect(msg(() => validateFields(fields, {}))).toBe('missing required field: Num (n)');
    const two = [...fields, d('string', { id: 'b', name: 'Beta', required: true })];
    expect(msg(() => validateFields(two, {}))).toBe('missing required fields: Num (n), Beta (b)');
  });
  it('null, empty string and empty list count as omitted', () => {
    for (const v of [null, '', []]) {
      expect(validateFields(fields, { n: 1, a: v })).toEqual({ n: 1 });
      expect(msg(() => validateFields(fields, { n: v }))).toMatch(/missing required field: Num/);
    }
  });
  it('a required unsupported field is reported before other missing required fields', () => {
    const f = [d('number', { id: 'n', name: 'Num', required: true }), d('unsupported', { id: 'u', name: 'Unsup', unsupported: true, required: true })];
    expect(msg(() => validateFields(f, {}))).toBe('field Unsup (u) is required by Jira but pjPlanner cannot fill it');
  });
  it('a required unsupported field blocks with its own message', () => {
    const f = [d('unsupported', { id: 'u', name: 'Unsup', unsupported: true, required: true })];
    expect(msg(() => validateFields(f, {}))).toBe('field Unsup (u) is required by Jira but pjPlanner cannot fill it');
    expect(status(() => validateFields(f, {}))).toBe(400);
  });
});
