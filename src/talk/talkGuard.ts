/**
 * The rules about a turn that hold whatever the agent decides (PROTOCOL.md "Talk by text", "What the agent may do").
 * Pure, tested; `TalkService` keeps the one turn that is running.
 *
 * A turn begins only with the owner's `talk.say` and ends when the agent's run does. Its tools reach the daemon with
 * the turn's id and a secret made for it, so a tool call from an earlier turn, or from anything but this run, is
 * refused. A prompt goes only to a session `route_session` matched for the action `prompt` in this same turn.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { TalkChoice } from "@grenade/protocol";
import type { RouteAction } from "./talkRouter.js";

/** How many sessions one turn may start. The owner's words start one; an agent that keeps starting them is stopped here. */
export const STARTS_PER_TURN = 3;

export interface TalkTurn {
  readonly id: string;
  readonly secret: string;
  /** The sessions routing matched in this turn, by session id, with the actions it matched them for. */
  readonly routes: Map<string, Set<RouteAction>>;
  /** The closest sessions of the last `confirmation_needed` in this turn, best first: what a `which` row offers. */
  choices: TalkChoice[] | null;
  /** How many sessions this turn started. */
  started: number;
}

/** A fresh turn: its id, and a secret only the agent's run is given. */
export function newTurn(id: string = randomUUID(), secret: string = randomBytes(24).toString("base64url")): TalkTurn {
  return { id, secret, routes: new Map(), choices: null, started: 0 };
}

/** Whether a tool call that names this turn id and secret belongs to the running turn. */
export function isTurnCall(turn: TalkTurn | null, id: unknown, secret: unknown): boolean {
  if (!turn || typeof id !== "string" || typeof secret !== "string" || id !== turn.id) return false;
  const want = Buffer.from(turn.secret);
  const got = Buffer.from(secret);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** `route_session` matched `sessionId` for `action`. */
export function noteRoute(turn: TalkTurn, sessionId: string, action: RouteAction): void {
  const actions = turn.routes.get(sessionId) ?? new Set<RouteAction>();
  actions.add(action);
  turn.routes.set(sessionId, actions);
}

/** `route_session` asked for confirmation: these are what a `which` row offers, until the next one. */
export function noteConfirmation(turn: TalkTurn, choices: TalkChoice[]): void {
  turn.choices = choices;
}

/** Whether a prompt may go to this session in this turn: routing matched it for a prompt. */
export function maySend(turn: TalkTurn, sessionId: string): boolean {
  return turn.routes.get(sessionId)?.has("prompt") === true;
}

/** Whether this turn may start another session. */
export function mayStart(turn: TalkTurn): boolean {
  return turn.started < STARTS_PER_TURN;
}
