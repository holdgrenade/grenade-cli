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
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { shellQuote } from "../hooks/shellQuote.js";

/** The files under `<dir>` the prompt needs, by path relative to it. Pure. */
export function shellPromptFiles(): Record<string, string> {
  return { "zsh/.zshenv": ZSHENV, "zsh/.zshrc": ZSHRC, "zsh/prompt.zsh": ZSH_PROMPT, "bash/rc": BASH_RC };
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

/** Writes the prompt's files into `dir` (`<GRENADE_HOME>/shell`), each only when it differs. */
export function writeShellPrompt(dir: string): void {
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
`;
