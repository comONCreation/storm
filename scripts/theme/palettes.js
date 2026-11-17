// Syntax palettes of the JetBrains IDEs, expressed as VS Code TextMate rules
// and semantic token colours.
//
// JetBrains: syntax colours of the default dark editor schemes of the JetBrains
//   IDEs (PhpStorm, Rider, IntelliJ…): "Islands Dark" (2025.3+,
//   platform/platform-resources/src/themes/islands/IslandSchemeDark.xml) and the
//   New UI "Dark" (themes/expUI/expUI_darkScheme.xml) share the same token colours.
//   Both inherit from Darcula and do not redefine the PHP keys, so PhpStorm keeps
//   Darcula's PHP colours: variables / $this #9876AA, property access #CF8E6D,
//   named arguments #467CDA, function and method calls #57AAF7, static method calls
//   #CF8E6D, no italic (measured on PhpStorm 2025.3 Islands Dark screenshots).

/** TextMate scope suffixes and VS Code language ids of JavaScript / TypeScript. */
const JS_EXT = ['js', 'jsx', 'ts', 'tsx'];
const JS_LANGS = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];

/** Builds the TextMate rules of a palette. `c` = colour table. */
function textMateRules(c) {
  const r = [];
  const add = (scope, foreground, fontStyle) => r.push({ scope, settings: fontStyle === undefined ? { foreground } : { foreground, fontStyle } });

  // Default text first: operators, punctuation, identifiers, types and calls are plain in JetBrains schemes.
  add(['source', 'text', 'meta.embedded', 'punctuation', 'keyword.operator', 'meta.brace', 'variable', 'variable.other', 'meta.function-call', 'meta.method-call', 'support.function', 'entity.name.namespace', 'support.other.namespace', 'entity.name.type.namespace'], c.text);
  add(['entity.name.type', 'entity.name.class', 'support.class', 'entity.other.inherited-class', 'support.type'], c.type);
  add(['entity.name.type.enum', 'entity.name.type.struct'], c.enumType);

  // Keywords (also true/false/null, $this/this, primitive types, and keyword-like operators)
  add(['keyword', 'keyword.control', 'keyword.other', 'storage', 'storage.type', 'storage.modifier', 'constant.language', 'variable.language', 'variable.language.this', 'support.type.primitive', 'keyword.type', 'keyword.other.type', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.type', 'keyword.operator.instanceof', 'keyword.operator.logical.python', 'keyword.other.use', 'keyword.other.namespace', 'meta.directive.blade keyword', 'keyword.blade'], c.keyword);

  // Strings, escapes, numbers
  add(['string', 'string.quoted', 'string.template', 'string.regexp', 'punctuation.definition.string', 'string.unquoted.heredoc', 'string.unquoted.nowdoc'], c.string);
  add(['constant.character.escape', 'constant.character'], c.escape);
  add(['constant.numeric', 'keyword.other.unit'], c.number);

  // Comments
  add(['comment', 'punctuation.definition.comment'], c.comment, c.commentStyle);
  add(['comment.block.documentation', 'comment.block.documentation punctuation.definition.comment', 'comment.block.javadoc'], c.doc, c.docStyle);
  add(['comment.block.documentation keyword', 'comment.block.documentation storage.type', 'keyword.other.phpdoc', 'storage.type.class.jsdoc', 'storage.type.class.phpdoc', 'comment.block.documentation entity.name.tag'], c.docTag, c.docStyle);
  add(['comment.block.documentation entity.name.type', 'comment.block.documentation support.class', 'comment.block.documentation variable', 'comment.block.documentation keyword.other.type'], c.docValue, c.docStyle);

  // Functions: declarations, calls, method calls
  add(['entity.name.function', 'meta.function entity.name.function', 'meta.definition.method entity.name.function', 'meta.definition.function entity.name.function', 'meta.method.declaration entity.name.function'], c.fnDecl);
  add(['support.function.constructor.php', 'meta.function.php support.function.constructor.php'], c.fnDecl);
  add(['meta.function-call entity.name.function', 'meta.function-call.php entity.name.function', 'support.function', 'meta.function-call support.function'], c.fnCall);
  add(['meta.method-call entity.name.function', 'meta.method-call.php entity.name.function', 'meta.function-call.object entity.name.function', 'meta.function-call.object.php entity.name.function'], c.methodCall);

  // Variables, fields, constants
  add(['variable.other.php', 'variable.parameter.php', 'punctuation.definition.variable.php', 'variable.other.global.php'], c.phpVar);
  add(['variable.parameter'], c.param);
  add(['variable.other.property', 'variable.other.object.property', 'support.variable.property', 'meta.property-name', 'entity.name.variable.field', 'entity.name.variable.property'], c.field);
  // PHP: $this is coloured like the other variables, property access ($x->id) and named arguments have their own colours.
  add(['variable.language.this.php', 'variable.language.this.php punctuation.definition.variable.php'], c.phpVar);
  add(['variable.other.property.php'], c.phpProperty);
  // PHP calls (measured on PhpStorm 2025.3): functions and instance methods #57AAF7, static methods
  // (Foo::bar()) #CF8E6D, none in italic. The child combinator ">" only targets the name of the call
  // itself: vscode-textmate ranks parent selectors by length, so a plain descendant rule on
  // meta.method-call.static.php would also colour calls nested in its arguments
  // (validated() in Selection::create($request->validated())).
  add(['meta.function-call.php > entity.name.function', 'meta.function-call.php > support.function'], c.phpFnCall, '');
  add(['meta.method-call.php > entity.name.function'], c.methodCall, '');
  add(['meta.method-call.static.php > entity.name.function'], c.phpStaticCall, '');
  add(['entity.name.variable.parameter.php', 'meta.function-call.php punctuation.separator.colon.php', 'meta.method-call.php punctuation.separator.colon.php', 'meta.function-call.static.php punctuation.separator.colon.php', 'meta.method-call.static.php punctuation.separator.colon.php'], c.namedArg);
  add(['variable.other.class.php', 'variable.other.static'], c.field, c.staticStyle);
  add(['constant.other', 'variable.other.constant', 'support.constant', 'constant.other.class.php', 'constant.other.php', 'variable.other.enummember', 'constant.other.enum'], c.constant, c.staticStyle);

  // JavaScript / TypeScript, as in PhpStorm / WebStorm (New UI Dark): "=>" is an operator sign
  // (#BCBEC4, not a keyword); local constants and imports are plain local variables (only real
  // globals such as window are purple italic, see the semantic colours); function calls use
  // DEFAULT_FUNCTION_CALL, the same blue as declarations.
  add(['storage.type.function.arrow'], c.text);
  add(JS_EXT.map((x) => `variable.other.constant.${x}`), c.text, '');
  add(JS_EXT.map((x) => `entity.name.function.${x}`), c.fnDecl, '');
  // ...except decorators (@Component: annotation colour) and function-typed properties of a type
  // (onReset?: () => void: a field, as in WebStorm). Same leaf scope plus a parent: these win.
  add(JS_EXT.map((x) => `meta.decorator entity.name.function.${x}`), c.meta);
  add(JS_EXT.map((x) => `meta.definition.property entity.name.function.${x}`), c.field);

  // Attributes / decorators / annotations, type parameters
  add(['meta.attribute', 'meta.attribute.php entity.name.type', 'meta.attribute.php support.class', 'meta.decorator', 'punctuation.decorator', 'meta.decorator entity.name.function', 'storage.type.annotation', 'punctuation.definition.annotation'], c.meta);
  add(['entity.name.type.parameter', 'meta.type.parameters entity.name.type', 'storage.type.generic'], c.typeParam);

  // Markup: HTML / XML / Blade / Vue
  add(['entity.name.tag', 'punctuation.definition.tag', 'meta.tag.sgml.doctype'], c.tag);
  add(['entity.other.attribute-name'], c.attr);
  // JSX / TSX components (<Button>, <AlertDialog.Content>): "Custom Tag Name" in JetBrains IDEs,
  // distinct from HTML tags (<div>). More specific than the generic support.class rule.
  add(['support.class.component'], c.customTag);
  // CSS
  add(['entity.name.tag.css', 'entity.other.attribute-name.class.css', 'entity.other.attribute-name.id.css', 'entity.other.attribute-name.pseudo-class.css', 'entity.other.attribute-name.pseudo-element.css'], c.cssSelector);
  add(['support.type.property-name.css', 'support.type.property-name.scss', 'support.type.vendored.property-name'], c.cssProperty);
  add(['support.constant.property-value', 'support.constant.font-name'], c.text);
  // JSON / YAML / .env / ini
  add(['support.type.property-name.json', 'support.type.property-name'], c.jsonKey);
  add(['entity.name.tag.yaml', 'keyword.other.definition.ini', 'variable.other.env'], c.yamlKey);

  // Markdown
  add(['markup.heading', 'markup.heading entity.name', 'punctuation.definition.heading'], c.keyword, 'bold');
  add(['markup.bold'], undefined, 'bold');
  add(['markup.italic'], undefined, 'italic');
  add(['markup.inline.raw', 'markup.fenced_code', 'markup.raw'], c.string);
  add(['markup.underline.link', 'string.other.link', 'markup.link'], c.link);
  add(['markup.quote'], c.doc, 'italic');
  add(['markup.list punctuation.definition.list'], c.keyword);

  // Diff / invalid
  add(['markup.inserted'], c.string);
  add(['markup.deleted', 'invalid', 'invalid.illegal'], c.error);
  add(['markup.changed'], c.link);

  return r.map((x) => (x.settings.foreground === undefined ? { scope: x.scope, settings: { fontStyle: x.settings.fontStyle } } : x));
}

/** Semantic tokens (Intelephense, TypeScript, C#…) win over TextMate when semantic highlighting is on. */
function semanticTokenColors(c) {
  const style = (foreground, s) => (s ? { foreground, italic: /italic/.test(s), bold: /bold/.test(s) } : foreground);
  // TypeScript server (also used for JavaScript): a readonly variable (const, import) is a plain
  // local variable in WebStorm, not a constant. Without these rules VS Code maps it to the
  // TextMate scope variable.other.constant (purple italic). Globals of the default library
  // (window, document, console) are JS.GLOBAL_VARIABLE: purple italic.
  const js = {};
  for (const lang of JS_LANGS) {
    js[`variable.readonly:${lang}`] = { foreground: c.text, italic: false };
    js[`variable.defaultLibrary:${lang}`] = style(c.constant, c.staticStyle);
    js[`variable.readonly.defaultLibrary:${lang}`] = style(c.constant, c.staticStyle);
    js[`function:${lang}`] = { foreground: c.fnDecl, italic: false };
  }
  return {
    ...js,
    variable: c.text,
    'variable:php': c.phpVar,
    parameter: c.param,
    'parameter:php': c.phpVar,
    property: c.field,
    'property:php': c.phpProperty,
    'function:php': { foreground: c.phpFnCall, italic: false },
    'function.declaration:php': { foreground: c.fnDecl, italic: false },
    'method:php': { foreground: c.methodCall, italic: false },
    'method.static:php': { foreground: c.phpStaticCall, italic: false },
    'method.declaration:php': { foreground: c.fnDecl, italic: false },
    'method.static.declaration:php': { foreground: c.fnDecl, italic: false },
    'property.static': style(c.field, c.staticStyle),
    'variable.readonly.static': style(c.constant, c.staticStyle),
    enumMember: style(c.constant, c.staticStyle),
    function: c.fnCall,
    'function.declaration': c.fnDecl,
    method: c.methodCall,
    'method.declaration': c.fnDecl,
    'method.static': style(c.methodCall, c.staticStyle),
    'method.static.declaration': style(c.fnDecl, c.staticStyle),
    class: c.type,
    interface: c.type,
    type: c.type,
    struct: c.enumType,
    enum: c.enumType,
    namespace: c.text,
    typeParameter: c.typeParam,
    decorator: c.meta,
    keyword: c.keyword,
    string: c.string,
    number: c.number,
    comment: c.comment,
  };
}

const JETBRAINS = {
  text: '#BCBEC4',
  type: '#BCBEC4',
  enumType: '#BCBEC4',
  keyword: '#CF8E6D',
  string: '#6AAB73',
  escape: '#CF8E6D',
  number: '#2AACB8',
  comment: '#7A7E85',
  commentStyle: '',
  doc: '#5F826B',
  docStyle: 'italic',
  docTag: '#67A37C',
  docValue: '#ABADB3',
  fnDecl: '#56A8F5',
  fnCall: '#BCBEC4',
  methodCall: '#57AAF7',
  staticStyle: 'italic',
  phpVar: '#9876AA',
  phpProperty: '#CF8E6D',
  namedArg: '#467CDA',
  phpFnCall: '#57AAF7',
  phpStaticCall: '#CF8E6D',
  param: '#BCBEC4',
  field: '#C77DBB',
  constant: '#C77DBB',
  meta: '#B3AE60',
  typeParam: '#16BAAC',
  tag: '#D5B778',
  customTag: '#2FBAA3',
  attr: '#BCBEC4',
  cssSelector: '#D5B778',
  cssProperty: '#BCBEC4',
  jsonKey: '#C77DBB',
  yamlKey: '#CF8E6D',
  link: '#56A8F5',
  error: '#F75464',
};

module.exports = {
  variants: [{ id: 'jetbrains', label: 'Storm Dark', file: 'storm-dark.json', palette: JETBRAINS }],
  textMateRules,
  semanticTokenColors,
};
