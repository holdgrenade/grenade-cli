/**
 * Grenade's prompt, for the `shell` sessions grenaded starts: two lines, the folder, the git branch, its changes and
 * how far it is ahead or behind on the first, the last command's failure, how long it took and the time at its right
 * end; a `❯` to type after on the second, green, or red after a command that failed. Only the 16 terminal colors, so
 * it follows whichever theme the terminal draws.
 *
 * It is used only while the prompt is still the shell's or the system's own (`%n@%m %1~ %# ` on a Mac): a prompt of
 * the user's own (Starship, Powerlevel10k, oh-my-zsh, a PS1 of their own) is left alone, and `GRENADE_PROMPT=off`
 * in their rc file turns it off. The user's rc files run first, as they always do, so their PATH and aliases stay.
 *
 * zsh reads its startup files from `ZDOTDIR`, pointed at Grenade's (`<GRENADE_HOME>/shell/zsh`), which run the
 * user's own and then this prompt. bash starts with `--rcfile`, which runs `~/.bashrc` and then this prompt. Any
 * other shell starts as it is. The files are written under GRENADE_HOME as a session starts (`writeShellPrompt`).
 *
 * The same files keep Grenade's command history (`<GRENADE_HOME>/shell/history.tsv`), with any prompt, the user's
 * own included: each command entered at a prompt, with the folder it ran in, the folder after it, its status and the
 * shell it ran in, so the Mac app can predict the next command from it (grenade-mac's `CommandHistory`). A line
 * that begins with a space is never kept (as `HIST_IGNORE_SPACE` and `ignorespace`), and `GRENADE_HISTORY=off` in
 * the user's rc file turns it off. One line a command, tab-separated: the time (seconds), the shell's pid, the
 * command's number in that shell (1 for its first), its status, the folder it ran in, the folder after it, and the
 * command line, with `\` written `\\`, a newline `\n` and a tab as a space. Kept to the last megabyte or so
 * (`trimShellHistory`).
 */
import { mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { shellQuote } from "../hooks/shellQuote.js";

/** The files under `<dir>` the prompt needs, by path relative to it. Pure. */
export function shellPromptFiles(): Record<string, string> {
  return {
    "zsh/.zshenv": ZSHENV,
    "zsh/.zshrc": ZSHRC,
    "zsh/prompt.zsh": ZSH_PROMPT,
    "zsh/history.zsh": ZSH_HISTORY,
    "bash/rc": BASH_RC,
  };
}

/**
 * The command line that starts `shell` with Grenade's prompt from `dir`, for /bin/sh (tmux runs it). `userZdotdir`
 * is the ZDOTDIR the daemon itself runs with, if any: the user's zsh files are there. Pure.
 */
export function shellLaunch(shell: string, dir: string, userZdotdir?: string): string {
  switch (basename(shell)) {
    case "zsh": {
      const user = userZdotdir ? ` GRENADE_USER_ZDOTDIR=${shellQuote(userZdotdir)}` : "";
      return `ZDOTDIR=${shellQuote(join(dir, "zsh"))}${user} ${shellQuote(shell)}`;
    }
    case "bash":
      return `${shellQuote(shell)} --rcfile ${shellQuote(join(dir, "bash", "rc"))}`;
    default:
      return shell;
  }
}

/**
 * Writes the prompt's files into `dir` (`<GRENADE_HOME>/shell`), each only when it differs; makes the history's file,
 * readable by this user alone, or trims it.
 */
export function writeShellPrompt(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const history = join(dir, HISTORY_FILE);
  closeSync(openSync(history, "a", 0o600));
  trimShellHistory(history);
  for (const [path, content] of Object.entries(shellPromptFiles())) {
    const file = join(dir, path);
    let current: string | undefined;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(file, content, { mode: 0o600 });
  }
}

/** The command history's file, under the prompt's folder. */
export const HISTORY_FILE = "history.tsv";

/** The history is cut back to its last `keep` bytes, from the next whole line, once it is past `limit`. */
export function trimShellHistory(file: string, limit = 2_000_000, keep = 1_000_000): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size <= limit) return;
  const fd = openSync(file, "r");
  const tail = Buffer.alloc(keep);
  let read: number;
  try {
    read = readSync(fd, tail, 0, keep, size - keep);
  } finally {
    closeSync(fd);
  }
  const text = tail.subarray(0, read);
  const start = text.indexOf(10) + 1;
  writeFileSync(file, text.subarray(start), { mode: 0o600 });
}

const HEADER = "# Grenade's prompt (grenade-cli, src/platform/shellPrompt.ts). grenaded writes this file: edits are replaced.\n";

// zsh reads .zshenv from ZDOTDIR first: run the user's, from their own ZDOTDIR (which it may change), then come back
// here for .zshrc.
const ZSHENV = `${HEADER}typeset -g _grenade_zdotdir=$ZDOTDIR
ZDOTDIR=\${GRENADE_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
GRENADE_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$_grenade_zdotdir
`;

// The system's zshrc ran in between and named the history file after Grenade's ZDOTDIR: it goes back to the user's.
const ZSHRC = `${HEADER}[[ $HISTFILE == $_grenade_zdotdir/.zsh_history ]] && HISTFILE=$GRENADE_USER_ZDOTDIR/.zsh_history
ZDOTDIR=$GRENADE_USER_ZDOTDIR
unset GRENADE_USER_ZDOTDIR
[[ -r $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
source $_grenade_zdotdir/prompt.zsh
source $_grenade_zdotdir/history.zsh
unset _grenade_zdotdir
`;

// The scripts are raw strings, so `\e` and `\%` stay as written; a shell's `${` is written `${D}{`.
const D = "$";

const ZSH_PROMPT = String.raw`# Grenade's prompt (grenade-cli, src/platform/shellPrompt.ts). grenaded writes this file: edits are replaced.
# Used only while PROMPT is still zsh's or the system's own; GRENADE_PROMPT=off in your .zshrc turns it off.
[[ ${D}{GRENADE_PROMPT:-on} == off ]] && return
case $PROMPT in
  ''|'%m%# '|'%n@%m %1~ %# ') ;;
  *) return ;;
esac
zmodload zsh/datetime 2>/dev/null
typeset -g _grenade_started= _grenade_ran=

_grenade_preexec() {
  _grenade_started=$EPOCHREALTIME
  _grenade_ran=$1
}

_grenade_precmd() {
  local code=$? folder=${D}{PWD:t} out line head= oid= ab= took= spaces=
  local -i changes=0 ahead=0 behind=0 pad
  [[ $PWD == $HOME ]] && folder='~'
  [[ $PWD == / ]] && folder=/
  local left="%B%F{4}${D}{folder//\%/%%}%f%b" plain=$folder
  out=$(GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 --branch 2>/dev/null)
  if [[ $? == 0 && -n $out ]]; then
    for line in ${D}{(f)out}; do
      case $line in
        '# branch.head '*) head=${D}{line#\# branch.head } ;;
        '# branch.oid '*) oid=${D}{line#\# branch.oid } ;;
        '# branch.ab '*) ab=${D}{line#\# branch.ab } ;;
        '#'*) ;;
        *) (( changes++ )) ;;
      esac
    done
    [[ $head == '(detached)' ]] && head=${D}{oid[1,7]}
    left+=" %F{8}on%f %F{5}${D}{head//\%/%%}%f"; plain+=" on $head"
    (( changes )) && { left+="%F{3} ●$changes%f"; plain+=" ●$changes"; }
    if [[ -n $ab ]]; then
      ahead=${D}{${D}{ab%% *}#+}; behind=${D}{${D}{ab##* }#-}
      (( ahead )) && { left+="%F{8} ↑$ahead%f"; plain+=" ↑$ahead"; }
      (( behind )) && { left+="%F{8} ↓$behind%f"; plain+=" ↓$behind"; }
    fi
  fi
  local failed=
  [[ -n $_grenade_ran && $code != 0 ]] && failed=1
  if [[ -n $_grenade_started ]]; then
    local -F secs=$(( EPOCHREALTIME - _grenade_started ))
    if (( secs >= 60 )); then took="$(( ${D}{secs%.*} / 60 ))m$(( ${D}{secs%.*} % 60 ))s"
    elif (( secs >= 1 )); then printf -v took '%.1fs' $secs
    fi
  fi
  local right= rplain=
  if [[ -n $failed ]]; then right="%F{1}✕ $code%f%F{8} · "; rplain="✕ $code · "; else right="%F{8}"; fi
  [[ -n $took ]] && { right+="$took · "; rplain+="$took · "; }
  right+="%D{%H:%M}%f"; rplain+="00:00"
  pad=$(( COLUMNS - ${D}{(m)#plain} - ${D}{(m)#rplain} - 1 ))
  local top=$left
  if (( pad >= 2 )); then printf -v spaces '%*s' $pad ''; top+="$spaces$right"; fi
  local gap=
  [[ -n $_grenade_ran && $_grenade_ran != (clear|reset)* ]] && gap=$'\n'
  local arrow="%F{2}"
  [[ -n $failed ]] && arrow="%F{1}"
  PROMPT="$gap$top"$'\n'"$arrow%B❯%b%f "
  _grenade_started= _grenade_ran=
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _grenade_preexec
# First, so it sees the last command's status before any other precmd changes it.
precmd_functions=(_grenade_precmd ${D}{precmd_functions:#_grenade_precmd})
`;

// After the prompt, and first among the precmd functions: it sees the command's status and hands it on (`return`)
// to the prompt, which shows it.
const ZSH_HISTORY = String.raw`# Grenade's command history (grenade-cli, src/platform/shellPrompt.ts). grenaded writes this file: edits are replaced.
# Each command, with its folder and status, for the Mac app's suggestions; GRENADE_HISTORY=off in your .zshrc turns it off.
[[ ${D}{GRENADE_HISTORY:-on} == off ]] && return
zmodload zsh/datetime 2>/dev/null
typeset -g _grenade_history=${D}{${D}{(%):-%x}:A:h:h}/history.tsv _grenade_line= _grenade_dir=$PWD
typeset -gi _grenade_seq=0

_grenade_history_preexec() {
  _grenade_line=${D}{1:-$3}
}

_grenade_history_precmd() {
  local code=$? line=$_grenade_line dir=$_grenade_dir tab=$'\t'
  _grenade_line= _grenade_dir=$PWD
  if [[ -n ${D}{line//[[:space:]]/} && $line != [[:space:]]* ]]; then
    (( _grenade_seq++ ))
    line=${D}{line%$'\n'}
    line=${D}{line//\\/\\\\}
    line=${D}{line//$'\n'/\\n}
    line=${D}{line//$tab/ }
    print -r -- "$EPOCHSECONDS$tab$$$tab$_grenade_seq$tab$code$tab${D}{dir//$tab/ }$tab${D}{PWD//$tab/ }$tab$line" >>| $_grenade_history 2>/dev/null
  fi
  return $code
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _grenade_history_preexec
precmd_functions=(_grenade_history_precmd ${D}{precmd_functions:#_grenade_history_precmd})
`;

// bash: the PS1 holds only variables, so a folder named with a backslash or a dollar is shown as it is; the colors
// are in the variables, between \001 and \002, which tell readline they take no room.
const BASH_RC = String.raw`# Grenade's prompt (grenade-cli, src/platform/shellPrompt.ts). grenaded writes this file: edits are replaced.
# bash runs this instead of ~/.bashrc: it runs that first. Used only while PS1 is still bash's or the system's own;
# GRENADE_PROMPT=off in your .bashrc turns it off.
[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
if [ "${D}{GRENADE_PROMPT:-on}" != off ]; then
  case "$PS1" in
    '\s-\v\$ '|'\h:\W \u\$ '|'[\u@\h \W]\$ '|'\u@\h:\w\$ '|'${D}{debian_chroot:+($debian_chroot)}\u@\h:\w\$ '|'${D}{debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ ')
      _grenade_first=1
      _grenade_prompt_command() {
        local code=$? folder="${D}{PWD##*/}" out line head= oid= ab= spaces= now
        local -i changes=0 ahead=0 behind=0 pad
        local o=$'\001' c=$'\002' e=$'\e'
        [ "$PWD" = "$HOME" ] && folder='~'
        [ "$PWD" = / ] && folder=/
        local left="$o$e[1;34m$c$folder$o$e[0m$c" plain="$folder"
        if out=$(GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 --branch 2>/dev/null) && [ -n "$out" ]; then
          while IFS= read -r line; do
            case "$line" in
              '# branch.head '*) head="${D}{line#\# branch.head }" ;;
              '# branch.oid '*) oid="${D}{line#\# branch.oid }" ;;
              '# branch.ab '*) ab="${D}{line#\# branch.ab }" ;;
              '#'*) ;;
              *) changes=changes+1 ;;
            esac
          done <<< "$out"
          [ "$head" = '(detached)' ] && head="${D}{oid:0:7}"
          left+=" $o$e[90m${D}{c}on $o$e[35m$c$head$o$e[0m$c"; plain+=" on $head"
          [ $changes -gt 0 ] && { left+="$o$e[33m$c ●$changes$o$e[0m$c"; plain+=" ●$changes"; }
          if [ -n "$ab" ]; then
            ahead="${D}{ab%% *}"; behind="${D}{ab##* -}"
            [ $ahead -gt 0 ] && { left+="$o$e[90m$c ↑$ahead$o$e[0m$c"; plain+=" ↑$ahead"; }
            [ $behind -gt 0 ] && { left+="$o$e[90m$c ↓$behind$o$e[0m$c"; plain+=" ↓$behind"; }
          fi
        fi
        now=$(date +%H:%M)
        local right rplain
        if [ $code -ne 0 ] && [ -z "$_grenade_first" ]; then
          right="$o$e[31m$c✕ $code$o$e[90m$c · $now$o$e[0m$c"; rplain="✕ $code · $now"
        else
          right="$o$e[90m$c$now$o$e[0m$c"; rplain="$now"
        fi
        pad=$(( ${D}{COLUMNS:-80} - ${D}{#plain} - ${D}{#rplain} - 1 ))
        _grenade_top="$left"
        if [ $pad -ge 2 ]; then printf -v spaces '%*s' $pad ''; _grenade_top+="$spaces$right"; fi
        [ -z "$_grenade_first" ] && _grenade_top=$'\n'"$_grenade_top"
        if [ $code -ne 0 ] && [ -z "$_grenade_first" ]; then _grenade_arrow="$o$e[1;31m$c❯$o$e[0m$c"; else _grenade_arrow="$o$e[1;32m$c❯$o$e[0m$c"; fi
        _grenade_first=
      }
      PROMPT_COMMAND="_grenade_prompt_command${D}{PROMPT_COMMAND:+; $PROMPT_COMMAND}"
      PS1='${D}{_grenade_top}\n${D}{_grenade_arrow} '
      ;;
  esac
fi
# Grenade's command history: each command, with its folder and status, for the Mac app's suggestions;
# GRENADE_HISTORY=off in your .bashrc turns it off. A command is new when the history's number moved, so one that
# bash does not keep (ignorespace, ignoredups) is not kept here either. First in PROMPT_COMMAND: it hands the status on.
if [ "${D}{GRENADE_HISTORY:-on}" != off ]; then
  _grenade_history="$(cd "$(dirname "${D}{BASH_SOURCE[0]}")/.." && pwd)/history.tsv"
  _grenade_hist_dir=$PWD _grenade_hist_n= _grenade_hist_seq=0
  _grenade_history_command() {
    local code=$? n line tab=$'\t'
    # "   12  the line": the number, a space (a star for a line edited since), a space, the line as typed.
    line=$(HISTTIMEFORMAT= builtin history 1)
    line=${D}{line#"${D}{line%%[![:space:]]*}"}
    n=${D}{line%%[!0-9]*}
    line=${D}{line#"$n"}; line=${D}{line#?}; line=${D}{line# }
    if [ -n "$_grenade_hist_n" ] && [ -n "$n" ] && [ "$n" != "$_grenade_hist_n" ]; then
      if [ -n "${D}{line//[[:space:]]/}" ] && [ "${D}{line#[[:space:]]}" = "$line" ]; then
        _grenade_hist_seq=$((_grenade_hist_seq + 1))
        line=${D}{line//\\/\\\\}
        line=${D}{line//$'\n'/\\n}
        line=${D}{line//$tab/ }
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${D}{EPOCHSECONDS:-$(date +%s)}" "$$" "$_grenade_hist_seq" "$code" \
          "${D}{_grenade_hist_dir//$tab/ }" "${D}{PWD//$tab/ }" "$line" >> "$_grenade_history" 2>/dev/null
      fi
    fi
    _grenade_hist_n=${D}{n:-0} _grenade_hist_dir=$PWD
    return $code
  }
  PROMPT_COMMAND="_grenade_history_command${D}{PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
`;
