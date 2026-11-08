import * as fc from 'fast-check';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const programs = ['cat', 'ls', 'rm', 'sort', 'grep', 'git'];
const variables = ['v1', 'v2', 'v3'];
const functions = ['f1', 'f2'];
const aliases = ['a1', 'a2'];
/**
 * The last three are data Bash may read as code: a subscript it expands where a value is a name (`${!v}`, `$((v))`),
 * and substitutions in a prompt string (`${v@P}`), one made by an octal escape.
 */
const values = ['a', '-rf', 'x y', 'cat', 'rm -rf', 'f1', 'a1', '', 'v1[$(cat n)]', '$(ls p)', '\\044(sort o)'];
/** Names a builtin reads with their subscript, which Bash expands: `read 'v1[$(cat n)]'` runs `cat`. */
const names = ['v2', 'v1[1]', 'v1[v2]', 'v1[$(cat n)]'];
const nameUses = [
  (name: string) => `read -r ${name} <<< x`,
  (name: string) => `printf -v ${name} %s x`,
  (name: string) => `unset ${name}`,
  (name: string) => `[[ -v ${name} ]]`,
  (name: string) => `test -v ${name}`,
  (name: string) => `declare ${name}=1`,
];
/**
 * Options that change what runs, some passed on to the shells it starts. Not `set -m`: job control would put pipelines
 * in process groups of their own, out of the harness's reach.
 */
const options = ['shopt -s lastpipe', 'shopt -s localvar_inherit', 'set -a', 'set -o posix', 'export BASHOPTS', 'export SHELLOPTS'];
/** Variables Bash sets itself: assigning one doesn't decide what it holds. None holds a path. */
const specials = ['RANDOM', 'LINENO', 'OPTIND', 'PIPESTATUS', 'BASH_REMATCH'];
const expansions = [
  '$v',
  '"$v"',
  '${v}x',
  '${v:-a}',
  '"${v:-cat}"',
  '${v:=rm}',
  '${v:+-rf}',
  '${v=ls}',
  '${!v:=a}',
  '${v/a/b}',
  '${v#-}',
  '${!v}',
  '${#v}',
  '"${v[@]}"',
  '${v[1]}',
  '"${v@P}"',
];
const depth = { depthIdentifier: 'script', maxDepth: 4, depthSize: 'small' } as const;

/** Every way to write the string as one word that Bash reads back as exactly that string. */
function spelled(value: string): fc.Arbitrary<string> {
  const quoted = [quote(value), `"${value}"`, `$'${value}'`];
  if (!/^[\w-]+$/.test(value)) return fc.constantFrom(...quoted);
  return fc.constantFrom(value, `\\${value}`, `${value[0]}""${value.slice(1)}`, ...quoted);
}

/**
 * Generated scripts: random mixes of the constructs the analysis follows, over a few shared names, so variables,
 * functions and aliases get set in one place and used in another. Every script is valid Bash and always finishes.
 */
export const { script: generatedScript } = fc.letrec<{ word: string; command: string; block: string; script: string }>((tie) => {
  const command = tie('command');
  const word = tie('word');
  const block = tie('block');
  const words = fc.array(word, { maxLength: 3 }).map((list) => list.join(' '));
  const variable = fc.constantFrom(...variables);
  const name = fc.oneof(
    { weight: 2, arbitrary: fc.constantFrom(...programs).chain(spelled) },
    { weight: 2, arbitrary: fc.constantFrom(...functions, ...aliases, 'h1', 'echo') },
    { weight: 1, arbitrary: fc.constantFrom(...programs).map((program) => `command ${program}`) },
  );
  const redirect = fc.constantFrom('', ' >out', ' 2>/dev/null', ' </dev/null');
  const simple = fc
    .tuple(fc.option(fc.tuple(variable, word), { nil: undefined }), name, words, redirect)
    .map(([prefix, program, args, to]) => `${prefix ? `${prefix[0]}=${prefix[1]} ` : ''}${program} ${args}${to}`);
  const literal = fc.constantFrom(...values).chain(spelled);
  const literalCommand = fc.tuple(name, fc.array(literal, { maxLength: 3 })).map(([program, args]) => [program, ...args].join(' '));
  return {
    word: fc.oneof(
      depth,
      literal,
      fc.tuple(variable, fc.constantFrom(...expansions)).map(([v, form]) => form.replaceAll('v', v)),
      fc.constantFrom('"$@"', '$@', '"$*"', '$1', '"$2"', '$#', '{a,-rf}', 'x{1,2}', '*.sh', '$((1 + 2))', '$((c + 1))'),
      // Variables Bash sets itself, whatever the script assigned them.
      fc.constantFrom(...specials).map((name) => `$${name}`),
      command.map((code) => `"$(${code})"`),
      command.map((code) => `$(${code})`),
      command.map((code) => `<(${code})`),
    ),
    command: fc.oneof(
      depth,
      simple,
      // A command name from a variable set just before, so it stays known unless the branches disagree: a name the
      // analysis can't resolve hides the rest of the script from the check.
      fc
        .tuple(variable, fc.constantFrom(...programs, ...functions, 'cat -rf'), words)
        .map(([v, program, args]) => `${v}=${quote(program)}\n$${v} ${args}`),
      fc.tuple(variable, word).map(([v, value]) => `${v}=${value}`),
      fc
        .tuple(fc.constantFrom('', 'local ', 'declare ', 'export '), variable, fc.constantFrom('=', '+='), word)
        .map((parts) => parts.join('')),
      fc.tuple(variable, words).map(([v, list]) => `${v}=(${list})`),
      fc.tuple(fc.constantFrom(...specials), word).map(([name, value]) => `${name}=${value}`),
      fc.tuple(fc.constantFrom('unset', 'export'), variable).map((parts) => parts.join(' ')),
      // Without -f, unset removes a function when no variable has the name.
      fc.tuple(fc.constantFrom('unset', 'unset -f', 'unset -v'), fc.constantFrom(...functions)).map((parts) => parts.join(' ')),
      // A nameref: what's assigned through it lands on the variable it names.
      fc.tuple(variable, variable).map(([ref, target]) => `declare -n ${ref}=${target}`),
      fc.tuple(variable, word).map(([v, value]) => `printf -v ${v} %s ${value}`),
      fc.tuple(fc.constantFrom(...names).chain(spelled), fc.constantFrom(...nameUses)).map(([name, use]) => use(name)),
      variable.map((v) => `exec {${v}}>/dev/null`),
      // The alias and hash tables, as arrays.
      fc.tuple(fc.constantFrom(...aliases), literalCommand).map(([a, code]) => `BASH_ALIASES[${a}]=${quote(code)}`),
      fc
        .tuple(fc.constantFrom(...programs, 'h1'), fc.constantFrom(...programs))
        .map(([name, program]) => `BASH_CMDS[${name}]=bin/${program}`),
      // Run in place of a command that isn't found (f1 before it's defined, h1). One command, which may not be found
      // either: FUNCNEST bounds the subshells it nests, and more would fork exponentially many.
      literalCommand.map((body) => `command_not_found_handle() {\n${body} "$@"\n}`),
      fc.constantFrom(...options, 'shopt -u lastpipe', 'set +a'),
      fc.tuple(variable, word).map(([v, value]) => `read -r ${v} <<< ${value}`),
      // The stubs print nothing: echo gives read something, which only lastpipe keeps. Each of these uses the variable
      // right after, with a value known before, so a wrong guess shows.
      fc.tuple(variable, literal, literal).map(([v, before, after]) => `${v}=${before}\necho ${after} | read -r ${v}\ncat "$${v}"`),
      // A local with no value: unset in the function, or what it was outside with localvar_inherit. And unset in a
      // function, which shows the value a caller's local hid.
      fc
        .tuple(variable, literal, fc.constantFrom(...functions), fc.constantFrom('local', 'declare'))
        .map(([v, value, f, how]) => `${v}=${value}\n${f}() {\n${how} ${v}\ncat "$${v}"\n}\n${f}`),
      fc
        .tuple(variable, literal, literal, fc.constantFrom(...functions))
        .map(([v, outer, inner, f]) => `${v}=${outer}\n${f}() {\nunset ${v}\nls "$${v}"\n}\nf0() {\nlocal ${v}=${inner}\n${f}\n}\nf0`),
      words.map((list) => `set -- ${list}`),
      fc.constant('shift'),
      fc.tuple(fc.constantFrom('env v1=a', 'sudo', 'exec'), simple).map((parts) => parts.join(' ')),
      simple.map((code) => `xargs ${code} </dev/null`),
      fc.constantFrom(...programs).map((program) => `hash -p bin/${program} h1`),
      fc.constant('enable -n echo'),
      // Literal words only: Bash expands an alias again in each substitution it contains, without end.
      fc.tuple(fc.constantFrom(...aliases), fc.oneof(literalCommand, fc.constant('sudo '))).map(([a, code]) => `alias ${a}=${quote(code)}`),
      fc.tuple(fc.constantFrom(...functions), block).map(([f, body]) => `${f}() {\n${body}\n}`),
      fc.tuple(fc.constantFrom('eval', '/bin/bash -c'), block).map(([how, code]) => `${how} ${quote(code)}`),
      fc.tuple(block, fc.constantFrom('EXIT', 'ERR', 'DEBUG')).map(([code, signal]) => `trap ${quote(code)} ${signal}`),
      fc.constantFrom('trap - EXIT', 'trap - ERR', "trap '' DEBUG"),
      fc.tuple(command, fc.constantFrom('&&', '||', '|'), command).map((parts) => parts.join(' ')),
      command.map((code) => `! ${code}`),
      block.map((body) => `(\n${body}\n)`),
      block.map((body) => `{\n${body}\n}`),
      fc.tuple(command, block, block).map(([test, yes, no]) => `if ${test}\nthen\n${yes}\nelse\n${no}\nfi`),
      fc.tuple(word, block, block).map(([subject, a, other]) => `case ${subject} in\na)\n${a}\n;;\n*)\n${other}\n;;\nesac`),
      fc.tuple(variable, words, block).map(([v, list, body]) => `for ${v} in ${list}; do\n${body}\ndone`),
      // One counter for every loop: a nested loop leaves it at 2, so the outer one ends too. Grouped, so a nested loop
      // in a subshell (a pipeline) resets only its own copy.
      block.map((body) => `{\nc=0\nwhile (( c < 2 )); do\n${body}\nc=$((c + 1))\ndone\n}`),
      word.map((value) => `[[ -n ${value} ]]`),
    ),
    block: fc.array(command, { minLength: 1, maxLength: 3 }).map((list) => list.join('\n')),
    // Options first, so that what they change is likely to come after.
    script: fc
      .tuple(fc.boolean(), fc.subarray(options), fc.array(command, { minLength: 1, maxLength: 5 }))
      .map(([aliasing, set, list]) => [...(aliasing ? ['shopt -s expand_aliases'] : []), ...set, ...list].join('\n')),
  };
});
