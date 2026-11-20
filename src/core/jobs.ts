import type { JobInfo } from './types';
import { newId } from './constants';
import { log } from './log';
import { isCanceled } from './providers/base';

type JobFn<T> = (progress: (msg: string) => void, signal: AbortSignal) => Promise<T>;

/**
 * In-memory background jobs for long operations (video render, merge, casting). Every job owns an
 * AbortController so it can be canceled; providers stop polling and cancel remote requests.
 */
export class JobManager {
  private jobs = new Map<string, JobInfo>();
  private controllers = new Map<string, AbortController>();

  start<T>(kind: string, fn: JobFn<T>, meta: { projectId?: string; sceneId?: string } = {}): JobInfo<T> {
    const job: JobInfo<T> = { id: newId('job'), kind, status: 'running', progress: 'Đang khởi động...', createdAt: new Date().toISOString(), ...meta };
    const ctrl = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, ctrl);
    fn(msg => {
      if (job.status === 'running') job.progress = msg;
    }, ctrl.signal)
      .then(result => {
        job.result = result;
        job.status = ctrl.signal.aborted ? 'canceled' : 'done';
        job.progress = ctrl.signal.aborted ? 'Đã hủy' : 'Hoàn tất';
      })
      .catch(err => {
        if (isCanceled(err, ctrl.signal)) {
          job.status = 'canceled';
          job.progress = 'Đã hủy';
          job.error = 'Đã hủy';
          return;
        }
        log.error(`Job ${kind} lỗi:`, err);
        job.status = 'error';
        job.error = (err as Error).message || String(err);
      })
      .finally(() => this.controllers.delete(job.id));
    this.gc();
    return job;
  }

  get(id: string): JobInfo | undefined {
    return this.jobs.get(id);
  }

  list(filter: { projectId?: string; running?: boolean } = {}): JobInfo[] {
    return [...this.jobs.values()].filter(
      j => (!filter.projectId || j.projectId === filter.projectId) && (!filter.running || j.status === 'running')
    );
  }

  cancel(id: string): JobInfo | undefined {
    const job = this.jobs.get(id);
    const ctrl = this.controllers.get(id);
    if (job && ctrl && job.status === 'running') {
      job.progress = 'Đang hủy...';
      ctrl.abort();
    }
    return job;
  }

  /** Is a job of this kind already running for the project (or scene)? */
  busy(projectId: string, sceneId?: string): JobInfo | undefined {
    return this.list({ projectId, running: true }).find(j => !sceneId || !j.sceneId || j.sceneId === sceneId);
  }

  private gc() {
    const cutoff = Date.now() - 6 * 3600_000;
    for (const [id, j] of this.jobs) if (j.status !== 'running' && Date.parse(j.createdAt) < cutoff) this.jobs.delete(id);
  }
}
