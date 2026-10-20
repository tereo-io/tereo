import { ServiceUnavailableError } from "./errors.js";

interface Waiter {
  bytes: number;
  grant: (release: () => void) => void;
  timer: NodeJS.Timeout;
}

/**
 * A pool of bytes shared by everything that holds one: `acquire` resolves
 * once `bytes` fit, with the function that returns them. Waiters are served
 * in arrival order, so a large request is not starved by small ones; one
 * larger than the whole pool waits for it to empty and then runs alone. A
 * wait longer than `waitMs` rejects with a 503.
 */
export class ByteBudget {
  private inUse = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly capacity: number,
    private readonly waitMs: number
  ) {}

  get used(): number {
    return this.inUse;
  }

  get waiting(): number {
    return this.queue.length;
  }

  acquire(requested: number): Promise<() => void> {
    const bytes = Math.min(Math.max(0, requested), this.capacity);
    if (this.queue.length === 0 && this.inUse + bytes <= this.capacity) {
      return Promise.resolve(this.take(bytes));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        bytes,
        grant: resolve,
        timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(waiter), 1);
          reject(
            new ServiceUnavailableError(
              "Too many downloads in progress; retry shortly",
              1
            )
          );
          // The head may have been the only thing blocking those behind it.
          this.drain();
        }, this.waitMs),
      };
      waiter.timer.unref();
      this.queue.push(waiter);
    });
  }

  private take(bytes: number): () => void {
    this.inUse += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= bytes;
      this.drain();
    };
  }

  private drain() {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (this.inUse + head.bytes > this.capacity) return;
      this.queue.shift();
      clearTimeout(head.timer);
      head.grant(this.take(head.bytes));
    }
  }
}
