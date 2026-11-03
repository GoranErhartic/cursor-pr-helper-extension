/**
 * Tracks the single in-flight PR review. Starting another review aborts the
 * previous one so stale chunks cannot write into the shared panel.
 */
export class ActiveReviewGate {
  private controller: AbortController | undefined;
  private currentGeneration = 0;

  begin(): { signal: AbortSignal; generation: number } {
    this.controller?.abort();
    this.currentGeneration += 1;
    this.controller = new AbortController();
    return { signal: this.controller.signal, generation: this.currentGeneration };
  }

  isCurrent(generation: number): boolean {
    return this.currentGeneration === generation;
  }

  end(generation: number): void {
    if (this.currentGeneration === generation) {
      this.controller = undefined;
    }
  }
}

export const prReviewGate = new ActiveReviewGate();
