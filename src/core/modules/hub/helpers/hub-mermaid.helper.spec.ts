import { describe, expect, it } from 'vitest';

import { buildErDiagram, type HubModelDescriptor } from './hub-mermaid.helper';

describe('buildErDiagram', () => {
  const models: HubModelDescriptor[] = [
    {
      fields: [
        { name: 'email', type: 'String' },
        { name: 'age', type: 'Number' },
        { name: 'company', ref: 'Company', type: 'ObjectId' },
      ],
      name: 'User',
    },
    {
      fields: [{ name: 'name', type: 'String' }],
      name: 'Company',
    },
  ];

  it('opens an erDiagram block', () => {
    const out = buildErDiagram(models);
    expect(out.startsWith('erDiagram')).toBe(true);
  });

  it('emits one entity per model with its fields and types', () => {
    const out = buildErDiagram(models);
    expect(out).toContain('User {');
    expect(out).toContain('Company {');
    expect(out).toContain('String email');
    expect(out).toContain('Number age');
  });

  it('renders a relationship for a ref field', () => {
    const out = buildErDiagram(models);
    expect(out).toMatch(/User \|\|--o\{ Company : company/);
  });

  it('ignores refs pointing at models that are not present', () => {
    const out = buildErDiagram([{ fields: [{ name: 'ghost', ref: 'Missing', type: 'ObjectId' }], name: 'Solo' }]);
    expect(out).toContain('Solo {');
    expect(out).not.toContain('Missing');
  });

  it('sanitizes field/entity names so the diagram stays valid', () => {
    const out = buildErDiagram([{ fields: [{ name: 'weird-field.name', type: 'String' }], name: 'Odd Name' }]);
    expect(out).not.toContain('weird-field.name');
    expect(out).not.toContain('Odd Name {');
  });

  it('handles an empty model list without throwing', () => {
    expect(buildErDiagram([])).toBe('erDiagram');
  });
});
