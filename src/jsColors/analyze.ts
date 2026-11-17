// JetBrains-accurate colours for JavaScript / TypeScript that a VS Code theme cannot express:
// the TypeScript server gives a function-typed parameter the same semantic token as a function
// declaration, and a function-typed property of a type the same token as a class method.
// This module parses a file (TypeScript compiler, no type checking) and returns the ranges that
// WebStorm / PhpStorm colour differently:
// - parameters, declarations and references (WebStorm: "Parameter", plain text);
// - properties whose type is a function (`onReset?: () => void`: an instance field);
// - JSX tag names with the import they come from (components of a 'use client' module are
//   "JSX client component" in WebStorm; the caller resolves the modules).
// Pure module: bundled separately with the TypeScript compiler and loaded on demand.

import * as ts from 'typescript';

export interface JsxTag {
  /** [start, end) offsets of the tag name (`AlertDialog.Content`). */
  start: number;
  end: number;
  /** Module specifier the root identifier is imported from. */
  module: string;
}

export interface JsColorRanges {
  /** Flat [start, end) offset pairs. */
  params: number[];
  fields: number[];
  jsxTags: JsxTag[];
}

type Binding = 'param' | 'other';
type Scope = Map<string, Binding>;

const scriptKind = (fileName: string) =>
  /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : /\.jsx$/i.test(fileName) ? ts.ScriptKind.JSX : /\.(c|m)?js$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;

export function analyze(text: string, fileName: string): JsColorRanges {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const params: number[] = [];
  const fields: number[] = [];
  const jsxTags: JsxTag[] = [];
  const imports = new Map<string, string>();
  const push = (out: number[], n: ts.Node) => out.push(n.getStart(sf), n.getEnd());

  /** Names bound by a binding name: `a`, `{ a, b: c, ...d }`, `[e, [f]]`. */
  const bindingNames = (name: ts.BindingName, out: ts.Identifier[]) => {
    if (ts.isIdentifier(name)) out.push(name);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  };

  /** Declarations made directly in a block-like list of statements. */
  const declareStatements = (scope: Scope, statements: readonly ts.Statement[]) => {
    for (const st of statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          const ids: ts.Identifier[] = [];
          bindingNames(d.name, ids);
          ids.forEach((id) => scope.set(id.text, 'other'));
        }
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
        scope.set(st.name.text, 'other');
      } else if (ts.isImportDeclaration(st) && st.importClause && !st.importClause.isTypeOnly && ts.isStringLiteral(st.moduleSpecifier)) {
        const mod = st.moduleSpecifier.text;
        const ic = st.importClause;
        if (ic.name) {
          scope.set(ic.name.text, 'other');
          imports.set(ic.name.text, mod);
        }
        const nb = ic.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) {
          scope.set(nb.name.text, 'other');
          imports.set(nb.name.text, mod);
        } else if (nb) {
          for (const s of nb.elements) {
            if (s.isTypeOnly) continue;
            scope.set(s.name.text, 'other');
            imports.set(s.name.text, mod);
          }
        }
      }
    }
  };

  const isFunctionLike = (n: ts.Node): n is ts.SignatureDeclaration & { body?: ts.Node } =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

  /** Scope introduced by a node, if any. */
  const scopeOf = (n: ts.Node): Scope | undefined => {
    if (isFunctionLike(n)) {
      const s: Scope = new Map();
      for (const p of n.parameters) {
        const ids: ts.Identifier[] = [];
        bindingNames(p.name, ids);
        for (const id of ids) {
          if (id.text === 'this') continue;
          s.set(id.text, 'param');
          push(params, id);
        }
      }
      return s;
    }
    if (ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n)) {
      const s: Scope = new Map();
      declareStatements(s, n.statements);
      return s;
    }
    if (ts.isCaseBlock(n)) {
      const s: Scope = new Map();
      for (const c of n.clauses) declareStatements(s, c.statements);
      return s;
    }
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      const s: Scope = new Map();
      for (const d of n.initializer.declarations) {
        const ids: ts.Identifier[] = [];
        bindingNames(d.name, ids);
        ids.forEach((id) => s.set(id.text, 'other'));
      }
      return s;
    }
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      const s: Scope = new Map();
      const ids: ts.Identifier[] = [];
      bindingNames(n.variableDeclaration.name, ids);
      ids.forEach((id) => s.set(id.text, 'other'));
      return s;
    }
    return undefined;
  };

  /** Is this identifier a value reference (not a declaration name, property name, label…)? */
  const isReference = (id: ts.Identifier): boolean => {
    const p = id.parent;
    if (!p) return false;
    if (ts.isShorthandPropertyAssignment(p)) return p.name === id; // { onReset } reads the variable
    if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && (p as ts.PropertyAccessExpression).name === id) return false;
    if (ts.isPropertyAssignment(p) && p.name === id) return false;
    if (ts.isBindingElement(p) || ts.isParameter(p) || ts.isVariableDeclaration(p)) return false;
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) return false;
    if (ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) return false;
    if (ts.isEnumMember(p) || ts.isEnumDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isModuleDeclaration(p)) return false;
    if (ts.isImportClause(p) || ts.isImportSpecifier(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || ts.isImportEqualsDeclaration(p)) return false;
    if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
    if (ts.isJsxAttribute(p) || ts.isJsxNamespacedName(p)) return false;
    if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === id) return false;
    if (ts.isTypeParameterDeclaration(p)) return false;
    return true;
  };

  /** JSX tag name: components (capitalised or dotted) with their import. */
  const jsxTag = (tag: ts.JsxTagNameExpression) => {
    let root: ts.Node = tag;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (!ts.isIdentifier(root)) return;
    if (root === tag && !/^[A-Z]/.test(root.text)) return; // intrinsic element (<div>)
    const mod = imports.get(root.text);
    if (mod !== undefined) jsxTags.push({ start: tag.getStart(sf), end: tag.getEnd(), module: mod });
  };

  /** Function-typed property of a type / class: `onReset?: () => void`, `handler = () => {}`. */
  const isFunctionType = (t: ts.TypeNode | undefined): boolean => {
    if (!t) return false;
    if (ts.isFunctionTypeNode(t)) return true;
    if (ts.isParenthesizedTypeNode(t)) return isFunctionType(t.type);
    if (ts.isUnionTypeNode(t)) return t.types.some((x) => ts.isFunctionTypeNode(x) || (ts.isParenthesizedTypeNode(x) && isFunctionType(x.type)));
    return false;
  };

  const stack: Scope[] = [];
  const resolve = (name: string): Binding | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const b = stack[i].get(name);
      if (b) return b;
    }
    return undefined;
  };

  const visit = (n: ts.Node) => {
    // Types live in another namespace (and `typeof x` inside them is rare): skip whole type nodes.
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
    if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) {
      // property signatures of interfaces / type aliases
      n.forEachChild(visitTypeMembers);
      return;
    }
    if (ts.isPropertySignature(n) && isFunctionType(n.type)) push(fields, n.name);
    if (ts.isPropertyDeclaration(n) && (isFunctionType(n.type) || (n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))))) push(fields, n.name);
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxClosingElement(n)) jsxTag(n.tagName);

    const scope = scopeOf(n);
    if (scope) stack.push(scope);
    if (ts.isIdentifier(n)) {
      if (isReference(n) && resolve(n.text) === 'param') push(params, n);
    } else if (isFunctionLike(n)) {
      // parameter type annotations may contain function-typed properties (inline props types)
      for (const p of n.parameters) {
        if (p.type) visitTypeMembers(p.type);
        if (p.initializer) visit(p.initializer);
        visitBindingDefaults(p.name);
      }
      if (n.body) visit(n.body);
    } else {
      n.forEachChild(visit);
    }
    if (scope) stack.pop();
  };

  /** Default values inside destructuring patterns are expressions: `{ a = b }`. */
  const visitBindingDefaults = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) return;
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (el.initializer) visit(el.initializer);
      visitBindingDefaults(el.name);
    }
  };

  /** Inside type nodes only function-typed properties matter. */
  const visitTypeMembers = (n: ts.Node) => {
    if (ts.isPropertySignature(n) && isFunctionType(n.type)) push(fields, n.name);
    n.forEachChild(visitTypeMembers);
  };

  visit(sf);
  return { params, fields, jsxTags };
}

