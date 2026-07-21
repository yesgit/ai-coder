import type { SessionProgressEvent } from "../../shared/types.js";

export function formatActivityLog(
  events: SessionProgressEvent[],
  formatTime: (value: string) => string
): string {
  return events
    .map((event) => [
      formatTime(event.created_at),
      event.type,
      event.visibility,
      event.message
    ].join("\t"))
    .join("\n");
}
