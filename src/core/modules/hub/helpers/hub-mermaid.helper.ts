/**
 * Pure builder for a Mermaid `erDiagram` from a normalized description of the Mongoose models.
 *
 * The CoreHubDbService walks `connection.models` and the ModelRegistry to produce the descriptors;
 * keeping the string builder pure makes it unit-testable without a live database and CDN-free
 * (the client shows the source + a mermaid.live link; no diagram library ships with the framework).
 */

export interface HubModelDescriptor {
  fields: HubModelField[];
  name: string;
}

export interface HubModelField {
  name: string;
  /** Referenced model name (Mongoose `ref`), if this field is a relation. */
  ref?: string;
  /** Human-readable type label (String, Number, ObjectId, …). */
  type: string;
}

/** Mermaid identifiers must be alphanumeric/underscore; collapse everything else. */
function sanitizeIdentifier(value: string): string {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * Build a Mermaid `erDiagram`. Entities carry their fields (`Type name`); ref fields become
 * one-to-many relationships (`A ||--o{ B : field`) when the target model is also present.
 */
export function buildErDiagram(models: HubModelDescriptor[]): string {
  if (!models || models.length === 0) {
    return 'erDiagram';
  }

  const present = new Set(models.map((m) => m.name));
  const lines: string[] = ['erDiagram'];

  for (const model of models) {
    const entity = sanitizeIdentifier(model.name);
    lines.push(`  ${entity} {`);
    for (const field of model.fields) {
      const type = sanitizeIdentifier(field.type || 'Mixed');
      const name = sanitizeIdentifier(field.name);
      lines.push(`    ${type} ${name}`);
    }
    lines.push('  }');
  }

  for (const model of models) {
    const from = sanitizeIdentifier(model.name);
    for (const field of model.fields) {
      if (field.ref && present.has(field.ref)) {
        const to = sanitizeIdentifier(field.ref);
        lines.push(`  ${from} ||--o{ ${to} : ${sanitizeIdentifier(field.name)}`);
      }
    }
  }

  return lines.join('\n');
}
