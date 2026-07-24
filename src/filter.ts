// `--type` filter logic. Coarse names (`submission`, `task`) and fine-grained
// ones (`submission.photo`, `task.input.choice`). Empty list = everything passes.

import { eventCategory, eventSubtypes, type Event, type EventCategory } from "./events.js";

export class TypeFilter {
  private readonly coarse: EventCategory[] = [];
  private readonly fine: string[] = [];
  readonly unknown: string[] = [];

  constructor(filters: readonly string[]) {
    for (const f of filters) {
      if (f === "submission") this.coarse.push("submission");
      else if (f === "task") this.coarse.push("task");
      else if (f === "task.input") this.fine.push("task.input");
      else if (f.startsWith("submission.") || f.startsWith("task.")) this.fine.push(f);
      else this.unknown.push(f);
    }
  }

  matches(event: Event): boolean {
    if (this.coarse.length === 0 && this.fine.length === 0) return true;
    const category = eventCategory(event);
    if (category && this.coarse.includes(category)) return true;
    for (const sub of eventSubtypes(event)) {
      for (const f of this.fine) {
        if (sub === f || sub.startsWith(`${f}.`)) return true;
      }
    }
    return false;
  }
}
