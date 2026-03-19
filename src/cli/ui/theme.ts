import chalk from 'chalk';

export interface Theme {
  chalk: typeof chalk;
  use_color: boolean;
  use_spinner: boolean;
  icons: {
    bee: string;
    loaded: string;
    node: string;
    success: string;
    fail: string;
    retry: string;
    honey: string;
    wilted: string;
    hibernating: string;
  };
  success(text: string): string;
  fail(text: string): string;
  warn(text: string): string;
  info(text: string): string;
  muted(text: string): string;
}

export function createTheme(output = process.stdout, env = process.env): Theme {
  const useColor = Boolean(output.isTTY) && !('NO_COLOR' in env);
  const useSpinner = Boolean(output.isTTY);
  // chalk v5 doesn't export Instance; just use the default (respects NO_COLOR)
  const chalkInstance = chalk;

  return {
    chalk: chalkInstance,
    use_color: useColor,
    use_spinner: useSpinner,
    icons: {
      bee: '🐝',
      loaded: '🌸',
      node: '🌻',
      success: '✅',
      fail: '❌',
      retry: '🔄',
      honey: '🍯',
      wilted: '🥀',
      hibernating: '💤'
    },
    success: (text) => chalkInstance.green(text),
    fail: (text) => chalkInstance.red(text),
    warn: (text) => chalkInstance.yellow(text),
    info: (text) => chalkInstance.cyan(text),
    muted: (text) => chalkInstance.dim(text)
  };
}
