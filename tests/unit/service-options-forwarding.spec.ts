/**
 * Unit Tests: a method that HAS the caller's context must PASS IT ON.
 *
 * THE BUG CLASS
 * -------------
 * 11.33.1 was, in full: `deleteFile()` forwards `serviceOptions` to its inner `getFileInfo()`,
 * `deleteFileByName()` did not forward it to its inner `getFileInfoByName()`. One line, two
 * siblings, one of them wrong.
 *
 * The consequence is worse than "a parameter is missing". An overridden `checkRights()` gets asked
 * TWO DIFFERENT QUESTIONS about ONE request: the outer check sees the caller and allows, the inner
 * lookup sees an empty context and denies. Under the ownership rule the framework itself documents,
 * the caller is then told `File not found` about a file that exists and that they were just
 * authorized for. A missing file and a refused one are different answers, and dropping the context
 * silently converts one into the other.
 *
 * That shape is not specific to files. Any `src/core/` service whose methods thread a
 * `ServiceOptions` through an internal call chain can grow the same asymmetry, and no test will see
 * it unless a project happens to override the hook the context feeds — which is exactly why it
 * reached a release.
 *
 * WHY THIS IS A STRUCTURAL TEST AND NOT A BEHAVIOURAL ONE
 * -------------------------------------------------------
 * A behavioural test can only cover the pairs someone thought to write a case for. The defect is
 * mechanical — "the sibling forwards, this one does not" — so it can be read straight off the AST,
 * for every method in `src/core/`, including the ones added tomorrow. Same reasoning as
 * `import-cycle-invariants.spec.ts`: assert the property, not one of its symptoms.
 *
 * WHAT COUNTS AS FORWARDING
 * -------------------------
 * Passing the context parameter itself, OR any local derived from it — `const config = { ...opts,
 * … }` then `this.x(config)` is forwarding, and narrowing a sub-option out of such a local
 * (`const o = config.prepareOutput`) still is. The rule deliberately does NOT try to judge whether
 * the derivation is the RIGHT one; it catches the failure that actually ships, which is passing
 * NOTHING (or an unrelated literal) where a sibling passes the context.
 *
 * OPTING OUT
 * ----------
 * A call that must genuinely run context-free says so at the call site:
 *
 *     // serviceOptions-forwarding: <why this call must not carry the caller's context>
 *
 * An opt-out is a claim about authorization, so it belongs next to the call, in the diff, where a
 * reviewer sees it — never in a list in this file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import type { MethodDeclaration } from 'ts-morph';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const OPT_OUT = 'serviceOptions-forwarding:';

interface Violation {
  callee: string;
  location: string;
  passed: string;
  where: string;
}

/**
 * Index of the parameter carrying the caller's context, or -1.
 *
 * Two spellings, because the codebase has both: the explicit `serviceOptions`, and an `options`
 * object whose type mentions `ServiceOptions` (`ModuleService.process()` takes the second shape).
 * Matching only the first would leave the whole `process()` pipeline unguarded.
 */
function contextParamIndex(method: MethodDeclaration): number {
  return method.getParameters().findIndex((parameter) => {
    const name = parameter.getName();
    if (name === 'serviceOptions') {
      return true;
    }
    const type = parameter.getTypeNode()?.getText() ?? '';
    return (name === 'options' || name === '_options') && /ServiceOptions/.test(type);
  });
}

function collectViolations(): Violation[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
  project.addSourceFilesAtPaths(join(ROOT, 'src', 'core', '**', '*.ts'));

  const violations: Violation[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const relative = sourceFile.getFilePath().replace(`${ROOT}/`, '');

    for (const cls of sourceFile.getClasses()) {
      // Which methods of this class (own + inherited) accept the context, and where.
      const accepts = new Map<string, number>();
      let cursor = cls;
      const walked = new Set<unknown>();
      while (cursor && !walked.has(cursor)) {
        walked.add(cursor);
        for (const method of cursor.getMethods()) {
          const index = contextParamIndex(method);
          if (index >= 0 && !accepts.has(method.getName())) {
            accepts.set(method.getName(), index);
          }
        }
        cursor = cursor.getBaseClass();
      }
      if (!accepts.size) {
        continue;
      }

      for (const method of cls.getMethods()) {
        const callerIndex = contextParamIndex(method);
        if (callerIndex < 0) {
          continue;
        }

        // Names that COUNT as the context: the parameter, plus every local transitively derived
        // from it. Fixpoint, because a derivation chain can be two or three deep
        // (`serviceOptions` -> `config` -> `config.prepareOutput`).
        const derived = new Set([method.getParameters()[callerIndex].getName()]);
        for (let pass = 0; pass < 5; pass++) {
          const before = derived.size;
          for (const declaration of method.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
            const initializer = declaration.getInitializer()?.getText() ?? '';
            if ([...derived].some(name => initializer.includes(name))) {
              derived.add(declaration.getName());
            }
          }
          if (derived.size === before) {
            break;
          }
        }

        for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const access = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
          if (!access) {
            continue;
          }
          const receiver = access.getExpression().getText();
          if (receiver !== 'this' && receiver !== 'super') {
            continue;
          }
          const callee = access.getName();
          const calleeIndex = accepts.get(callee);
          if (calleeIndex === undefined) {
            continue;
          }

          const argument = call.getArguments()[calleeIndex];
          const passed = argument?.getText().replace(/\s+/g, ' ') ?? '<nothing>';
          if (argument && [...derived].some(name => passed.includes(name))) {
            continue;
          }

          // Opt-out lives at the call site — on the call, or on the statement holding it.
          const statement = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement)
            ?? call.getFirstAncestorByKind(SyntaxKind.VariableStatement)
            ?? call.getFirstAncestorByKind(SyntaxKind.ReturnStatement);
          const comments = [
            ...call.getLeadingCommentRanges().map(range => range.getText()),
            ...(statement?.getLeadingCommentRanges().map(range => range.getText()) ?? []),
          ].join('\n');
          if (comments.includes(OPT_OUT)) {
            continue;
          }

          violations.push({
            callee,
            location: `${relative}:${call.getStartLineNumber()}`,
            passed: passed.slice(0, 80),
            where: `${cls.getName()}.${method.getName()}`,
          });
        }
      }
    }
  }

  return violations;
}

describe('serviceOptions forwarding invariant (src/core)', () => {
  const violations = collectViolations();

  it('forwards the caller context to every internal call that accepts it', () => {
    const report = violations
      .map(
        violation =>
          `  ${violation.location}\n`
          + `    ${violation.where} -> this.${violation.callee}(…) passed ${violation.passed}`,
      )
      .join('\n');

    expect(
      violations,
      violations.length
        ? 'These internal calls drop the caller\'s ServiceOptions. Forward it, or state at the call '
          + `site why it must not travel:\n\n// ${OPT_OUT} <reason>\n\n${report}\n`
        : '',
    ).toEqual([]);
  });

  /**
   * The guard's own regression test.
   *
   * An invariant test that cannot fail is worse than none — it reports safety it never checked. So
   * the detector is run against the EXACT method body that shipped broken in 11.33.0, reconstructed
   * here rather than read from git (the file has since been fixed, and a fixture that tracks the
   * current source would go vacuous the moment someone "tidies" it).
   */
  it('detects the shape that shipped in 11.33.0', () => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    project.createSourceFile(
      'buggy.ts',
      `
        interface ServiceOptions { currentUser?: any; force?: boolean }
        class Broken {
          async getFileInfoByName(filename: string, serviceOptions?: ServiceOptions): Promise<any> {
            return { filename, serviceOptions };
          }
          async deleteFile(id: string, serviceOptions?: ServiceOptions): Promise<any> {
            return this.getFileInfoByName(id, serviceOptions);
          }
          async deleteFileByName(filename: string, serviceOptions?: ServiceOptions): Promise<any> {
            // The 11.33.1 defect, verbatim in shape: authorized WITH the context, then re-resolved
            // WITHOUT it.
            const fileInfo = await this.getFileInfoByName(filename);
            return this.deleteFile(fileInfo.id, serviceOptions);
          }
        }
      `,
    );

    const found: string[] = [];
    for (const cls of project.getSourceFiles()[0].getClasses()) {
      const accepts = new Map<string, number>();
      for (const method of cls.getMethods()) {
        const index = contextParamIndex(method);
        if (index >= 0) {
          accepts.set(method.getName(), index);
        }
      }
      for (const method of cls.getMethods()) {
        const callerIndex = contextParamIndex(method);
        if (callerIndex < 0) {
          continue;
        }
        const contextName = method.getParameters()[callerIndex].getName();
        for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const access = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
          if (!access || access.getExpression().getText() !== 'this') {
            continue;
          }
          const index = accepts.get(access.getName());
          if (index === undefined) {
            continue;
          }
          if (!call.getArguments()[index]?.getText().includes(contextName)) {
            found.push(`${method.getName()} -> ${access.getName()}`);
          }
        }
      }
    }

    expect(found).toEqual(['deleteFileByName -> getFileInfoByName']);
  });

  it('the fixed method really does forward, so the invariant has a live subject', () => {
    // Pins the fix itself. `collectViolations()` returning [] would also be satisfied by
    // `deleteFileByName` disappearing, or by its `getFileInfoByName` call being renamed out of the
    // detector's reach — neither of which is the property anyone cares about.
    const source = readFileSync(join(ROOT, 'src', 'core', 'modules', 'file', 'core-file.service.ts'), 'utf8');
    expect(source).toMatch(/getFileInfoByName\(filename,\s*serviceOptions\)/);
    expect(source).toMatch(/getFileInfo\(objectId,\s*serviceOptions\)/);
  });
});
