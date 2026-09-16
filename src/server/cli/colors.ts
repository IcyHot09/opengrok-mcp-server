/**
 * Minimal terminal colors with TTY/NO_COLOR gating.
 * Only color helpers — interactive prompts use @clack/prompts.
 */

export const isColorSupported = process.stdout.isTTY && process.env['NO_COLOR'] === undefined;
export const dim = (s: string): string => (isColorSupported ? `\x1b[2m${s}\x1b[22m` : s);
export const bold = (s: string): string => (isColorSupported ? `\x1b[1m${s}\x1b[22m` : s);
export const green = (s: string): string => (isColorSupported ? `\x1b[32m${s}\x1b[39m` : s);
export const red = (s: string): string => (isColorSupported ? `\x1b[31m${s}\x1b[39m` : s);
export const cyan = (s: string): string => (isColorSupported ? `\x1b[36m${s}\x1b[39m` : s);
export const yellow = (s: string): string => (isColorSupported ? `\x1b[33m${s}\x1b[39m` : s);
