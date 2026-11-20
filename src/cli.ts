import fs from 'node:fs';
import { createContext } from './core/director';
import { createHttpServer } from './server/http';
import { runMcpStdio } from './server/mcp';
import { runAcpStdio } from './server/acp';
import { log } from './core/log';

const [cmd = 'serve', ...rest] = process.argv.slice(2);

async function main() {
  const ctx = createContext();
  switch (cmd) {
    case 'serve': {
      const server = createHttpServer(ctx);
      server.requestTimeout = 0;
      server.listen(ctx.config.port, () => {
        log.info(`API + web: http://localhost:${ctx.config.port}`);
        const avail = (k: 'text' | 'image' | 'video') => ctx.registry.list(k).filter(m => m.available).map(m => m.id).join(', ');
        log.info(`Model sẵn sàng — text: ${avail('text')} | image: ${avail('image')} | video: ${avail('video')}`);
      });
      break;
    }
    case 'mcp':
      await runMcpStdio(ctx);
      break;
    case 'acp':
      await runAcpStdio(ctx);
      break;
    case 'make': {
      // npm run make -- <script.txt> [videoModel] [skill1,skill2]
      const [file, videoModel, skills] = rest;
      if (!file) throw new Error('Cách dùng: npm run make -- kichban.txt [videoModel] [skill1,skill2]');
      const p = ctx.director.createProject({
        name: file,
        script: fs.readFileSync(file, 'utf8'),
        settings: { ...(videoModel ? { videoModel } : {}), ...(skills ? { skillIds: skills.split(',') } : {}) }
      });
      const r = await ctx.director.makeVideo(p.id, m => log.info(m));
      r.notes.forEach(n => log.info('•', n));
      console.log(r.project.merged ? ctx.media.pathOf(r.project.merged.file) : 'Không tạo được video');
      break;
    }
    default:
      throw new Error(`Lệnh không hợp lệ: ${cmd} (serve | mcp | acp | make)`);
  }
}

main().catch(err => {
  log.error(err);
  process.exit(1);
});
