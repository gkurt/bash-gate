import * as fc from 'fast-check';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const programs = ['cat', 'ls', 'rm', 'sort', 'grep', 'git'];
const variables = ['v1', 'v2', 'v3'];
const functions = ['f1', 'f2'];
const aliases = ['a1', 'a2'];
const values = ['a', '-rf', 'x y', 'cat', 'rm -rf', 'f1', 'a1', ''];
const expansions = [
  '$v',
  '"$v"',
  '${v}x',
  '${v:-a}',
  '"${v:-cat}"',
  '${v:=rm}',
  '${v:+-rf}',
  '${v/a/b}',
  '${v#-}',
  '${!v}',
  '${#v}',
  '"${v[@]}"',
  '${v[1]}',
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
      fc.tuple(fc.constantFrom('unset', 'export'), variable).map((parts) => parts.join(' ')),
      fc.tuple(variable, word).map(([v, value]) => `read -r ${v} <<< ${value}`),
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
    script: fc
      .tuple(fc.boolean(), fc.array(command, { minLength: 1, maxLength: 5 }))
      .map(([aliasing, list]) => [...(aliasing ? ['shopt -s expand_aliases'] : []), ...list].join('\n')),
  };
});
