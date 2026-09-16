import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  zodToTypeString,
  emitInterface,
  emitMethod,
  assembleSpec,
} from '../server/sandbox/schemas/generator.js';
import { generateApiSpec } from '../server/sandbox/schemas/index.js';
import { API_SPEC_TS } from '../server/sandbox/api-spec.js';

describe('zodToTypeString', () => {
  it('maps primitives, literals, and enums', () => {
    expect(zodToTypeString(z.string())).toBe('string');
    expect(zodToTypeString(z.number())).toBe('number');
    expect(zodToTypeString(z.boolean())).toBe('boolean');
    expect(zodToTypeString(z.literal('x'))).toBe("'x'");
    expect(zodToTypeString(z.enum(['a', 'b']))).toBe("'a'|'b'");
  });

  it('unwraps optional/nullable and handles arrays', () => {
    expect(zodToTypeString(z.string().optional())).toBe('string');
    expect(zodToTypeString(z.number().nullable())).toBe('number|null');
    expect(zodToTypeString(z.array(z.string()))).toBe('string[]');
  });

  it('uses registered interface names', () => {
    const schema = z.object({ a: z.string() });
    const registry = new Map<z.ZodType, string>([[schema, 'MyIface']]);
    expect(zodToTypeString(schema, registry)).toBe('MyIface');
  });
});

describe('emitInterface + emitMethod', () => {
  it('emits an interface block', () => {
    const out = emitInterface(
      { name: 'Foo', schema: z.object({ a: z.string().optional(), b: z.number() }) },
      new Map(),
    );
    expect(out).toContain('interface Foo');
    expect(out).toContain('a?: string');
    expect(out).toContain('b: number');
  });

  it('emits a method signature', () => {
    const out = emitMethod(
      {
        name: 'doThing',
        description: 'Does a thing.',
        params: [{ name: 'q', type: z.string() }],
        returns: z.string(),
      },
      new Map(),
    );
    expect(out).toContain('doThing');
    expect(out).toContain('Does a thing.');
  });
});

describe('assembleSpec + generateApiSpec', () => {
  it('joins header, interfaces, and sections', () => {
    const out = assembleSpec({
      headerLines: ['// hi'],
      interfaces: [],
      sections: [],
    });
    expect(out).toContain('// hi');
  });

  it('generated snapshot matches the checked-in file', () => {
    expect(generateApiSpec()).toBe(API_SPEC_TS);
  });

  it('covers all sandbox methods', () => {
    for (const name of ['search', 'getFileContent', 'traceCallChain', 'readMemory', 'elicit', 'sample']) {
      expect(API_SPEC_TS).toContain(`${name}(`);
    }
  });
});
