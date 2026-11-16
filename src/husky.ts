/**
 * husky's hooks, which run the project's own: git runs a stub in `.husky/_`, which sources husky's dispatcher `h`,
 * which runs `.husky/<hook>` with `sh -e` when it's there. Older versions put that hook in `.husky` itself, after a
 * line sourcing a helper that runs the rest of the file again. Each is recognised by the exact text husky writes, so a
 * file changed by hand is walked as it is.
 *
 * What husky also sources from the user's home (`~/.config/husky/init.sh`, `~/.huskyrc`) isn't read, like the user's
 * git config. husky 9.1 puts `node_modules/.bin` first on PATH, so a name its hook runs may be a package's binary:
 * project code, as the hook is.
 */

const dispatcher91 = [
  '#!/usr/bin/env sh',
  '[ "$HUSKY" = "2" ] && set -x',
  'n=$(basename "$0")',
  's=$(dirname "$(dirname "$0")")/$n',
  '',
  '[ ! -f "$s" ] && exit 0',
  '',
  'if [ -f "$HOME/.huskyrc" ]; then',
  '\techo "husky - \'~/.huskyrc\' is DEPRECATED, please move your code to ~/.config/husky/init.sh"',
  'fi',
  'i="${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"',
  '[ -f "$i" ] && . "$i"',
  '',
  '[ "${HUSKY-}" = "0" ] && exit 0',
  '',
  'export PATH="node_modules/.bin:$PATH"',
  'sh -e "$s" "$@"',
  'c=$?',
  '',
  '[ $c != 0 ] && echo "husky - $n script failed (code $c)"',
  '[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"',
  'exit $c',
  '',
].join('\n');

const dispatcher90 = [
  '#!/usr/bin/env sh',
  'H="$HUSKY"',
  '[ "$H" = "2" ] && set -x',
  'h="${0##*/}"',
  's="${0%/*/*}/$h"',
  '',
  '[ ! -f "$s" ] && exit 0',
  '',
  'for f in "${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh" "$HOME/.huskyrc"; do',
  '\t# shellcheck disable=SC1090',
  '\t[ -f "$f" ] && . "$f"',
  'done',
  '',
  '[ "$H" = "0" ] && exit 0',
  '',
  'sh -e "$s" "$@"',
  'c=$?',
  '',
  '[ $c != 0 ] && echo "husky - $h script failed (code $c)"',
  '[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"',
  'exit $c',
].join('\n');

const helper8 = [
  '#!/usr/bin/env sh',
  'if [ -z "$husky_skip_init" ]; then',
  '  debug () {',
  '    if [ "$HUSKY_DEBUG" = "1" ]; then',
  '      echo "husky (debug) - $1"',
  '    fi',
  '  }',
  '',
  '  readonly hook_name="$(basename -- "$0")"',
  '  debug "starting $hook_name..."',
  '',
  '  if [ "$HUSKY" = "0" ]; then',
  '    debug "HUSKY env variable is set to 0, skipping hook"',
  '    exit 0',
  '  fi',
  '',
  '  if [ -f ~/.huskyrc ]; then',
  '    debug "sourcing ~/.huskyrc"',
  '    . ~/.huskyrc',
  '  fi',
  '',
  '  readonly husky_skip_init=1',
  '  export husky_skip_init',
  '  sh -e "$0" "$@"',
  '  exitCode="$?"',
  '',
  '  if [ $exitCode != 0 ]; then',
  '    echo "husky - $hook_name hook exited with code $exitCode (error)"',
  '  fi',
  '',
  '  if [ $exitCode = 127 ]; then',
  '    echo "husky - command not found in PATH=$PATH"',
  '  fi',
  '',
  '  exit $exitCode',
  'fi',
  '',
].join('\n');

const helper7 = [
  '#!/bin/sh',
  'if [ -z "$husky_skip_init" ]; then',
  '  debug () {',
  '    if [ "$HUSKY_DEBUG" = "1" ]; then',
  '      echo "husky (debug) - $1"',
  '    fi',
  '  }',
  '',
  '  readonly hook_name="$(basename "$0")"',
  '  debug "starting $hook_name..."',
  '',
  '  if [ "$HUSKY" = "0" ]; then',
  '    debug "HUSKY env variable is set to 0, skipping hook"',
  '    exit 0',
  '  fi',
  '',
  '  if [ -f ~/.huskyrc ]; then',
  '    debug "sourcing ~/.huskyrc"',
  '    . ~/.huskyrc',
  '  fi',
  '',
  '  export readonly husky_skip_init=1',
  '  sh -e "$0" "$@"',
  '  exitCode="$?"',
  '',
  '  if [ $exitCode != 0 ]; then',
  '    echo "husky - $hook_name hook exited with code $exitCode (error)"',
  '  fi',
  '',
  '  exit $exitCode',
  'fi',
  '',
].join('\n');

const deprecated91 = [
  'echo "husky - DEPRECATED',
  '',
  'Please remove the following two lines from $0:',
  '',
  '#!/usr/bin/env sh',
  '. \\"\\$(dirname -- \\"\\$0\\")/_/husky.sh\\"',
  '',
  'They WILL FAIL in v10.0.0',
  '"',
].join('\n');

/** The stub husky 9.1 writes for each hook, and 9.0's, which source the dispatcher beside them. */
const stub91 = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';
const stub90 = '#!/usr/bin/env sh\n. "${0%/*}/h"';
const stubs = new Set([stub91, stub90]);

/** The files husky writes, by version. */
export const huskyFiles = { stub91, stub90, dispatcher91, dispatcher90, helper8, helper7, deprecated91 } as const;
const dispatchers = new Set([dispatcher91, dispatcher90]);
/** husky 7 and 8's helper, which runs the hook again without the line that sourced it; 9's, which does nothing. */
const helpers = new Set([helper8, helper7, deprecated91, '']);
/** The line husky 7 and 8 put at the top of a hook, after its shebang, to source the helper. */
const sourcesHelper = /^((?:#![^\n]*\n)?)\. "\$\(dirname (?:-- )?"\$0"\)\/_\/husky\.sh"\n/;

const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/**
 * The code git runs as the hook at `path`, whose text is `text`: the project's hook husky dispatches to, without the
 * line sourcing husky's helper, or the hook itself when husky didn't make it. `undefined` when nothing runs (husky's
 * hook isn't there) or what runs isn't known (`read` didn't know: it makes that a finding).
 */
export function huskyHook(
  path: string,
  text: string,
  read: (path: string) => string | undefined,
): { path: string; text: string; husky?: boolean } | undefined {
  // husky 9's dispatcher runs the project's hook with `sh -e` (`husky`), whatever its first line says.
  let hook: { path: string; text: string; husky?: boolean } = { path, text };
  if (stubs.has(text.replace(/\n$/, ''))) {
    const dispatcher = read(`${parent(path)}/h`);
    if (dispatcher !== undefined && dispatchers.has(dispatcher)) {
      const own = `${parent(parent(path))}/${path.slice(path.lastIndexOf('/') + 1)}`;
      const ownText = read(own);
      if (ownText === undefined) return undefined;
      hook = { path: own, text: ownText, husky: true };
    }
  }
  const header = sourcesHelper.exec(hook.text);
  if (!header) return hook;
  const helper = read(`${parent(hook.path)}/_/husky.sh`);
  if (helper === undefined || !helpers.has(helper)) return hook;
  // 7's and 8's helper run the hook again with `sh -e`, whatever its first line says.
  const again = helper === helper7 || helper === helper8;
  return { ...hook, text: `${header[1]}${hook.text.slice(header[0].length)}`, ...(again ? { husky: true } : {}) };
}
