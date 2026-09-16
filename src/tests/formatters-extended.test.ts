/**
 * Additional formatter tests focused on uncovered branches:
 * - formatCompileInfo (all branches — includes, defines, extraFlags, standard)
 * - formatSymbolContext with fileSymbols (grouped by type)
 * - formatFileSymbols with grouped symbols
 */
import { describe, it, expect } from 'vitest';
import {
  formatCompileInfo,
  formatSymbolContext,
} from '../server/formatters/index.js';
import type { SymbolContextResult } from '../server/formatters/index.js';
import type { CompileInfo } from '../server/local/compile-info.js';

// -----------------------------------------------------------------------
// formatCompileInfo
// -----------------------------------------------------------------------

describe('formatCompileInfo', () => {
  it('returns not-found message for null info', () => {
    const output = formatCompileInfo(null, '/path/to/file.cpp');
    expect(output).toContain('No compile information found');
    expect(output).toContain('file.cpp');
  });

  it('formats basic compile info', () => {
    const info: CompileInfo = {
      file: '/build/src/EventLoop.cpp',
      directory: '/build',
      compiler: 'g++',
      includes: [],
      defines: [],
      standard: 'c++17',
      extraFlags: [],
    };
    const output = formatCompileInfo(info, 'EventLoop.cpp');
    expect(output).toContain('EventLoop.cpp');
    expect(output).toContain('g++');
    expect(output).toContain('c++17');
  });

  it('formats includes list', () => {
    const info: CompileInfo = {
      file: '/build/src/file.cpp',
      directory: '/build',
      compiler: 'g++',
      includes: ['/usr/include', '/opt/include', '/build/include'],
      defines: [],
      standard: '',
      extraFlags: [],
    };
    const output = formatCompileInfo(info, 'file.cpp');
    expect(output).toContain('includes (3):');
    expect(output).toContain('/usr/include');
    expect(output).toContain('/opt/include');
    expect(output).toContain('/build/include');
  });

  it('formats defines list', () => {
    const info: CompileInfo = {
      file: '/build/src/file.cpp',
      directory: '/build',
      compiler: 'clang++',
      includes: [],
      defines: ['DEBUG=1', 'VERSION="1.0"', 'FEATURE_X'],
      standard: '',
      extraFlags: [],
    };
    const output = formatCompileInfo(info, 'file.cpp');
    expect(output).toContain('defines:');
    expect(output).toContain('DEBUG=1');
    expect(output).toContain('VERSION="1.0"');
    expect(output).toContain('FEATURE_X');
  });

  it('formats extra flags', () => {
    const info: CompileInfo = {
      file: '/build/src/file.cpp',
      directory: '/build',
      compiler: 'g++',
      includes: [],
      defines: [],
      standard: '',
      extraFlags: ['-Wall', '-Werror', '-fPIC'],
    };
    const output = formatCompileInfo(info, 'file.cpp');
    expect(output).toContain('flags:');
    expect(output).toContain('-Wall');
    expect(output).toContain('-Werror');
    expect(output).toContain('-fPIC');
  });

  it('omits standard when empty', () => {
    const info: CompileInfo = {
      file: '/build/src/file.cpp',
      directory: '/build',
      compiler: 'g++',
      includes: [],
      defines: [],
      standard: '',
      extraFlags: [],
    };
    const output = formatCompileInfo(info, 'file.cpp');
    expect(output).not.toContain('std:');
  });

  it('formats full compile info with all fields', () => {
    const info: CompileInfo = {
      file: '/build/src/Complex.cpp',
      directory: '/build',
      compiler: 'clang++',
      includes: ['/usr/include/boost', '/opt/opencv/include'],
      defines: ['NDEBUG', 'USE_CUDA=1'],
      standard: 'c++20',
      extraFlags: ['-O3', '-march=native'],
    };
    const output = formatCompileInfo(info, 'Complex.cpp');
    expect(output).toContain('Complex.cpp');
    expect(output).toContain('clang++');
    expect(output).toContain('c++20');
    expect(output).toContain('includes (2):');
    expect(output).toContain('defines:');
    expect(output).toContain('flags:');
  });
});

// -----------------------------------------------------------------------
// formatSymbolContext with fileSymbols
// -----------------------------------------------------------------------

describe('formatSymbolContext with fileSymbols', () => {
  it('shows fileSymbols grouped by type', () => {
    const result: SymbolContextResult = {
      found: true,
      symbol: 'MyClass',
      kind: 'class/struct',
      definition: {
        project: 'proj',
        path: '/src/my_class.h',
        line: 10,
        context: 'class MyClass {};',
        lang: 'hpp',
      },
      references: {
        totalFound: 1,
        samples: [{ path: '/src/main.cpp', project: 'proj', lineNumber: 5, content: 'MyClass obj;' }],
      },
      fileSymbols: [
        { symbol: 'MyClass', type: 'class', line: 10 },
        { symbol: 'doWork', type: 'function', line: 20 },
        { symbol: 'getValue', type: 'function', line: 30 },
        { symbol: 'MAX_SIZE', type: 'macro', line: 3 },
      ],
    };
    const output = formatSymbolContext(result);
    expect(output).toContain('File symbols (4)');
    expect(output).toContain('class:');
    expect(output).toContain('function:');
    expect(output).toContain('macro:');
    expect(output).toContain('MyClass:L10');
    expect(output).toContain('doWork:L20');
    expect(output).toContain('getValue:L30');
    expect(output).toContain('MAX_SIZE:L3');
  });

  it('shows "References: none found" when 0 refs', () => {
    const result: SymbolContextResult = {
      found: true,
      symbol: 'Lonely',
      kind: 'function/method',
      definition: {
        project: 'proj',
        path: '/src/lonely.cpp',
        line: 5,
        context: 'void Lonely() {}',
        lang: 'cpp',
      },
      references: { totalFound: 0, samples: [] },
    };
    const output = formatSymbolContext(result);
    expect(output).toContain('References: none found');
  });
});
