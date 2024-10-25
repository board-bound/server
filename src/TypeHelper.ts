import { BaseEventMap, BaseGameState, BaseGameStateTypes, EventBus } from "@board-bound/sdk";
import type pino from "pino";

export type Logger = pino.Logger;

export type SimpleEventBus = EventBus<BaseEventMap, BaseGameState<BaseGameStateTypes>>;

export function getNewEventBus() {
  return new EventBus<BaseEventMap, BaseGameState<BaseGameStateTypes>>();
}
