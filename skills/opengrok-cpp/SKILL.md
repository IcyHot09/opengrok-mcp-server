---
name: opengrok-cpp
description: Specialized patterns for navigating C++ codebases with OpenGrok MCP
---

# OpenGrok C++ Skill

Specialized navigation patterns for C++ projects. Use alongside the `opengrok` skill
for general tool reference.

## Class Navigation

### Search for class definition

Use `opengrok_get_symbol_context` with `include_header: true` to fetch both the class
definition and its header file in one call:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "ClassName",
    "file_type": "cxx",
    "include_header": true,
    "context_lines": 25,
    "max_refs": 10
  }
}
```

### Finding all subclasses

Search for class definitions that inherit from a base class:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "class*:ClassName",
    "search_type": "defs",
    "file_type": "cxx",
    "max_results": 20
  }
}
```

Or use full-text search for explicit inheritance patterns:

```json
{
  "tool": "opengrok_search_and_read",
  "arguments": {
    "query": "class*: public ClassName",
    "search_type": "full",
    "file_type": "cxx",
    "context_lines": 10,
    "max_results": 15
  }
}
```

### Virtual method overrides

Search for references to a base class method to find all overrides:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "baseMethod",
    "file_type": "cxx",
    "max_refs": 25
  }
}
```

Then search for the `override` keyword near method declarations in derived classes:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "override",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 50
  }
}
```

## Template Patterns

### Template class instantiations

Templates are not indexed as definitions — use full-text search for instantiation
patterns:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "ClassName<",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 20
  }
}
```

### Template specializations

Find template specializations by searching for both the class name and angle brackets:

```json
{
  "tool": "opengrok_batch_search",
  "arguments": {
    "queries": [
      { "query": "ClassName", "search_type": "defs" },
      { "query": "template<>", "search_type": "full" }
    ],
    "file_type": "cxx"
  }
}
```

### Template metaprogramming

Locate template metaprogramming patterns by searching for common constructs:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "enable_if OR type_traits OR static_assert",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 20
  }
}
```

Look for includes of common TMP headers:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "#include <type_traits> OR #include <enable_if>",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 10
  }
}
```

## Macro Resolution

### Find macro definition

Use `opengrok_get_symbol_context` to locate where a macro
is defined (it always returns both definitions and references):

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "MACRO_NAME",
    "file_type": "cxx",
    "include_header": true
  }
}
```

### Find all macro uses

Search for all references to the macro:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "MACRO_NAME",
    "file_type": "cxx",
    "max_refs": 30
  }
}
```

### Conditional compilation

Find all uses of a preprocessor macro in conditional blocks:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "#ifdef MACRO_NAME OR #if defined(MACRO_NAME)",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 25
  }
}
```

## Include Chain Analysis

### Direct includes

Search for files that include a specific header:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "#include \"header.h\" OR #include <header.h>",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 20
  }
}
```

### Reverse includes (who includes this file)

Find all files that include a target header by searching for the filename:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "target.h",
    "search_type": "refs",
    "file_type": "cxx",
    "max_results": 30
  }
}
```

### Circular include detection

Trace include chains using `opengrok_batch_search` recursively. Start with a header
and search for its includes, then search for includes of those files:

```json
{
  "tool": "opengrok_batch_search",
  "arguments": {
    "queries": [
      { "query": "#include \"module_a.h\"", "search_type": "full" },
      { "query": "#include \"module_b.h\"", "search_type": "full" },
      { "query": "#include \"module_c.h\"", "search_type": "full" }
    ],
    "file_type": "cxx"
  }
}
```

### Compiler flags

Use `opengrok_get_compile_info` to retrieve compiler flags, include paths, defines,
and language standard for a source file (requires local `compile_commands.json`):

```json
{
  "tool": "opengrok_get_compile_info",
  "arguments": {
    "path": "src/main.cpp"
  }
}
```

Returns `-I` include paths, `-D` defines, `-std` version, and full compiler flags.

## Call Chain Tracing

### Who calls this function?

```javascript
// Callers via refs search; callees via tree-sitter AST (C++ fully supported)
const callers = env.opengrok.traceCallChain('handleCrash', { direction: 'callers', depth: 2 });
return callers;
```

### Bidirectional trace (callers + callees)

```javascript
const chain = env.opengrok.traceCallChain('processEvent', { direction: 'both', depth: 1 });
return { callers: chain.callers, callees: chain.callees };
```

Callees direction uses tree-sitter AST analysis — for C/C++ it returns real
callee results, not empty. `caller.symbol` is the enclosing function name when
resolvable, otherwise `path:line`.

### Expand matches to enclosing functions

```javascript
// Inline the enclosing function body for the top matches — saves a read call
const r = env.opengrok.search('handleCrash', { searchType: 'refs', fileType: 'cxx', expandFunction: true });
return r.results.slice(0, 3).map(x => x.functionContext ?? x.matches[0]?.content);
```

## Error Pattern Navigation

### Linker errors ("undefined reference")

Find the symbol definition that's missing by searching the definition index:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "missingSymbol",
    "file_type": "cxx"
  }
}
```

Check if it's defined in an inline method or header-only library:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "missingSymbol",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 20
  }
}
```

### Template instantiation errors

Find the template definition and check for constraint violations:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "TemplateClass",
    "file_type": "cxx",
    "include_header": true,
    "context_lines": 30
  }
}
```

Then search for `enable_if` constraints and `static_assert` in the template:

```json
{
  "tool": "opengrok_search_and_read",
  "arguments": {
    "query": "TemplateClass AND (enable_if OR static_assert)",
    "search_type": "full",
    "file_type": "cxx",
    "context_lines": 15,
    "max_results": 5
  }
}
```

### Missing virtual override

Search for the `override` keyword near method declarations to find missing overrides:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "override",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 30
  }
}
```

Or search for a method in the base class to find all where it should be overridden:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "virtualMethod",
    "file_type": "cxx",
    "max_refs": 20
  }
}
```

### Namespace resolution

Search for `using namespace` declarations and check nested namespaces:

```json
{
  "tool": "opengrok_search_code",
  "arguments": {
    "query": "using namespace",
    "search_type": "full",
    "file_type": "cxx",
    "max_results": 20
  }
}
```

Find a specific symbol within a namespace:

```json
{
  "tool": "opengrok_get_symbol_context",
  "arguments": {
    "symbol": "namespace::ClassName",
    "file_type": "cxx",
    "include_header": true
  }
}
```

## Code Mode Patterns for C++

Code Mode saves 75–95% tokens for complex investigations. Use `opengrok_execute` with
`env.opengrok.*` methods:

### Finding all usages of a class across the codebase

```javascript
// Search definitions, references, and instantiations in one sandbox execution
const [defs, refs, instantiations] = env.opengrok.batchSearch([
  { query: "MyClass", searchType: "defs" },
  { query: "MyClass", searchType: "refs", maxResults: 50 },
  { query: "MyClass<", searchType: "full", maxResults: 30 }
]);

const locations = {
  defined: defs.results[0]?.path,
  referenced: refs.results.map(r => ({ path: r.path, lines: r.matches.map(m => m.lineNumber) })),
  instantiated: instantiations.results.map(r => r.path)
};

return locations;
```

### Building an include graph

```javascript
// Recursively map include relationships without leaving the sandbox
const getIncludes = (filePath, depth = 0, visited = new Set()) => {
  if (depth > 5 || visited.has(filePath)) return [];
  visited.add(filePath);

  const content = env.opengrok.getFileContent('myproject', filePath);
  const includePattern = /#include\s+["<]([^">\n]+)[">]/g;
  const includes = [];
  let match;
  while ((match = includePattern.exec(content.content)) !== null) {
    includes.push(match[1]);
  }
  return includes;
};

const graph = getIncludes('src/main.cpp');
return graph;
```

### Finding all classes that implement an interface

```javascript
// Search for classes inheriting from a base interface
const results = env.opengrok.batchSearch([
  { query: "class*: public InterfaceName", searchType: "full", maxResults: 30 }
]);

const implementations = results[0].results.map(r => ({
  path: r.path,
  className: r.matches[0]?.lineContent
}));

return implementations;
```

## Gotchas

### 1. `file_type: cxx` vs `cpp`

OpenGrok uses `cxx` for C++ files (not `cpp`). Always use `file_type: "cxx"` when
filtering to C++ code. Aliases (`cpp`, `c++`, `h`, `hpp`) are normalized to
`cxx` automatically.

### 2. Templates are not functions

Template definitions are not indexed as `defs` entries — Ctags cannot instantiate
templates at index time. Use full-text search for template instantiation patterns
(e.g., `ClassName<`) instead of `search_type: "defs"`.

### 3. Inline methods

Methods defined directly in class bodies (inline) live in headers, not .cpp files.
Always set `include_header: true` in `opengrok_get_symbol_context` for C/C++, and
remember to search `.h`/`.hpp` files when looking for implementations.

### 4. Anonymous namespaces

Symbols in anonymous namespaces won't appear in global refs — they're file-local.
Scope searches to specific files when looking for anonymous namespace symbols, or
broaden the full-text search to include the namespace scope.

### 5. Preprocessor macros

`opengrok_get_file_symbols` will not list macro values or expansions — the indexer
only stores macro *names*. Use `opengrok_get_symbol_context` to find both macro
definitions and references in one call. For macro expansion
analysis, use full-text search or Code Mode to parse the preprocessed output.
