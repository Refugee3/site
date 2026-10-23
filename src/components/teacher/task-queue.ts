/**
 * Runs pushed tasks at most `limit` at a time, in the order they were pushed. `run` must report its own
 * failures (it should not reject); the queue only guarantees that a finished task frees its slot.
 */
export function createTaskQueue<T>(limit: number, run: (task: T) => Promise<void>): { push: (...tasks: T[]) => void } {
  const waiting: T[] = [];
  let active = 0;

  const startNext = () => {
    while (active < limit && waiting.length > 0) {
      const task = waiting.shift() as T;
      active += 1;
      void run(task).finally(() => {
        active -= 1;
        startNext();
      });
    }
  };

  return {
    push(...tasks: T[]) {
      waiting.push(...tasks);
      startNext();
    },
  };
}
