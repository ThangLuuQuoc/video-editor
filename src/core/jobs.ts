import type { JobInfo } from './types';
import { newId } from './constants';
import { log } from './log';

/** In-memory background jobs for long operations (video render, merge, casting). */
export class JobManager {
  private jobs = new Map<string, JobInfo>();

  start<T>(kind: string, fn: (progress: (msg: string) => void) => Promise<T>): JobInfo<T> {
    const job: JobInfo<T> = { id: newId('job'), kind, status: 'running', progress: 'Đang khởi động...', createdAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    fn(msg => (job.progress = msg))
      .then(result => {
        job.result = result;
        job.status = 'done';
        job.progress = 'Hoàn tất';
      })
      .catch(err => {
        log.error(`Job ${kind} lỗi:`, err);
        job.status = 'error';
        job.error = (err as Error).message || String(err);
      });
    this.gc();
    return job;
  }

  get(id: string): JobInfo | undefined {
    return this.jobs.get(id);
  }

  private gc() {
    const cutoff = Date.now() - 6 * 3600_000;
    for (const [id, j] of this.jobs) if (j.status !== 'running' && Date.parse(j.createdAt) < cutoff) this.jobs.delete(id);
  }
}
