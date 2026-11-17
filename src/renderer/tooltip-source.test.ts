import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import ts from 'typescript';
import {expect, it} from 'vitest';

const RENDERER = 'src/renderer';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function findViolations(source: string, file = 'fixture.tsx'): string[] {
  const violations: string[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) {
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'title') {
            violations.push(`${relative('.', file)}:${line(attribute)} <${tag.text} title=...>`);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'setAttribute') {
      const first = node.arguments[0];
      const name = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
      if (name === 'title') violations.push(`${relative('.', file)}:${line(node)} setAttribute('title', ...)`);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'title') {
      const owner = node.left.expression.getText(sourceFile);
      if (owner !== 'document' && owner !== 'window.document') violations.push(`${relative('.', file)}:${line(node)} .title = ...`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/** Intrinsic DOM `title` attributes are native tooltip windows. React
 * component `title` props (for example `<GameTitle title=...>`) are not. */
it('keeps intrinsic DOM title attributes out of the renderer', () => {
  const violations = sourceFiles(RENDERER).flatMap(file => findViolations(readFileSync(file, 'utf8'), file));
  expect(violations).toEqual([]);
});

it('mounts the shared layer at the common renderer entry', () => {
  const main = readFileSync('src/renderer/main.tsx', 'utf8');
  expect(main).toContain("import {TooltipLayer} from './Tooltip'");
  expect(main).toContain('<TooltipLayer/>');
});

it('detects intrinsic title attributes without banning component title props', () => {
  expect(findViolations('const view = <button title="native">Open</button>;')).toHaveLength(1);
  expect(findViolations('const view = <GameTitle title="component prop" />;')).toHaveLength(0);
  expect(findViolations('element.setAttribute(\'title\', text);')).toHaveLength(1);
  expect(findViolations('document.title = text;')).toHaveLength(0);
});
