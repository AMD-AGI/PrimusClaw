/**
 * The View -> Teams message framework: core says WHAT a person sees as a semantic view (no card JSON), and each feature registers
 * here HOW Teams shows that kind of view (its renderer, in `teams/src/views/<feature>/`). Rendering an unregistered kind is a
 * programming error and throws: a view never silently falls back to some other look.
 */
import type { JsonObject } from "../cards/json.js";

/** What a renderer turns a view into: one Teams message activity (a card message, or a text/xml message). */
export type TeamsMessage = JsonObject & { type: string };

/** Anything core hands over as a view: a tagged object whose `kind` names its renderer. */
export interface TaggedView {
  readonly kind: string;
}

export type Renderer<V extends TaggedView> = (view: V) => TeamsMessage;

/** A renderer already narrowed to its own view kind, as the registry stores it. */
type StoredRenderer = (view: TaggedView) => TeamsMessage;

export class ViewNotRenderable extends Error {
  override name = "ViewNotRenderable";
}

export class ViewRenderers {
  private readonly renderers = new Map<string, StoredRenderer>();

  /** Register how one kind of view is shown. Registering a kind twice throws (two features would fight over one look). */
  register<V extends TaggedView>(kind: V["kind"], renderer: Renderer<V>): this {
    if (this.renderers.has(kind)) throw new ViewNotRenderable(`a renderer for '${kind}' is registered already`);
    this.renderers.set(kind, renderer as StoredRenderer);
    return this;
  }

  has(kind: string): boolean {
    return this.renderers.has(kind);
  }

  kinds(): string[] {
    return [...this.renderers.keys()].sort();
  }

  render(view: TaggedView): TeamsMessage {
    const renderer = this.renderers.get(view.kind);
    if (!renderer) throw new ViewNotRenderable(`no renderer for view '${view.kind}'`);
    return renderer(view);
  }
}
