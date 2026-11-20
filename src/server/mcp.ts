import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AppContext } from '../core/director';
import { CAMERA_ANGLES } from '../core/constants';
import type { Project } from '../core/types';

/** Compact project view for LLM clients (no huge prompts, absolute file paths included). */
export function summarize(ctx: AppContext, p: Project) {
  const abs = (f?: { file: string }) => (f ? ctx.media.pathOf(f.file) : undefined);
  return {
    id: p.id,
    name: p.name,
    settings: p.settings,
    characters: p.characters.map(c => ({ id: c.id, name: c.name, description: c.description, image: abs(c.image) })),
    scenes: p.scenes.map(s => ({
      sceneNumber: s.sceneNumber,
      title: s.title,
      durationSeconds: s.durationSeconds,
      cameraAngle: s.cameraAngle,
      dialogue: s.dialogue,
      characters: p.characters.filter(c => s.selectedCharacterIds.includes(c.id)).map(c => c.name),
      status: s.status,
      error: s.errorMessage,
      video: abs(s.video),
      voice: abs(s.voice?.audio),
      references: s.lastRender?.references,
      notes: s.lastRender?.notes
    })),
    mergedVideo: abs(p.merged),
    subtitles: abs(p.mergedSubtitles),
    mergeWarnings: p.mergeWarnings,
    webUrl: `http://localhost:${ctx.config.port}/?project=${p.id}`
  };
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

const settingsShape = {
  scriptMode: z.enum(['strict', 'educational', 'cinematic']).optional(),
  skillIds: z.array(z.string()).optional().describe('Skill ids from list_skills, e.g. ["anime","vertical-short"]'),
  textModel: z.string().optional(),
  imageModel: z.string().optional(),
  videoModel: z.string().optional(),
  resolution: z.enum(['360p', '480p', '720p', '1080p']).optional(),
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).optional(),
  burnInSubtitles: z.boolean().optional(),
  autoGenerateCharacters: z.boolean().optional(),
  voiceMode: z.enum(['auto', 'always', 'off']).optional().describe('TTS voice-over: auto = only for video models without audio'),
  ttsModel: z.string().optional().describe('TTS model id from list_models (tts)'),
  narratorVoice: z.string().optional(),
  keyframeModel: z.string().optional().describe("Image model staging the first frame for image-to-video models ('' = auto, 'off')")
};

export function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: 'ai-video-director', version: '0.1.0' });
  const d = ctx.director;

  /** Forward pipeline progress as MCP progress notifications (keeps long calls alive). */
  const progressOf = (extra: any) => {
    let n = 0;
    const token = extra?._meta?.progressToken;
    return (message: string) => {
      if (token === undefined) return;
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message } }).catch(() => {});
    };
  };

  server.registerTool(
    'list_models',
    { title: 'Liệt kê model', description: 'List text/image/video/tts models with availability (missing API keys etc.), capabilities and TTS voices.' },
    async () => {
      await ctx.registry.ready();
      return json({
        text: ctx.registry.list('text'),
        image: ctx.registry.list('image'),
        video: ctx.registry.list('video'),
        tts: ctx.registry.list('tts'),
        defaults: d.defaults()
      });
    }
  );

  server.registerTool(
    'list_skills',
    {
      title: 'Liệt kê Skill Library',
      description: 'List style/genre/format skills that shape prompts and scene breakdown.',
      inputSchema: { category: z.string().optional().describe('style | genre | format') }
    },
    async ({ category }) => json(ctx.skills.list(category).map(({ directives: _d, ...s }) => s))
  );

  server.registerTool(
    'get_skill',
    { title: 'Xem chi tiết skill', description: 'Get one skill including its director directives.', inputSchema: { id: z.string() } },
    async ({ id }) => json(ctx.skills.get(id) ?? { error: 'not found' })
  );

  server.registerTool(
    'create_skill',
    {
      title: 'Tạo skill mới',
      description: 'Create or update a user skill (saved as skills/user/<id>.md).',
      inputSchema: {
        id: z.string().describe('kebab-case id'),
        name: z.string(),
        category: z.string().default('style'),
        description: z.string().default(''),
        tags: z.array(z.string()).default([]),
        promptModifier: z.string().optional().describe('Appended to every video prompt'),
        negativePrompt: z.string().optional(),
        portraitStyle: z.string().optional(),
        aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).optional(),
        defaultCameraAngle: z.enum(CAMERA_ANGLES as [string, ...string[]]).optional(),
        directives: z.string().default('').describe('Markdown instructions for the script-breakdown LLM')
      }
    },
    async args => json(ctx.skills.save(args as any))
  );

  server.registerTool(
    'list_projects',
    { title: 'Liệt kê dự án', description: 'List saved video projects (shared with the web UI).' },
    async () => json(ctx.projects.list())
  );

  server.registerTool(
    'create_project',
    {
      title: 'Tạo dự án',
      description: 'Create a project from a script. Returns the project id used by other tools.',
      inputSchema: { name: z.string().optional(), script: z.string(), ...settingsShape }
    },
    async ({ name, script, ...settings }) => {
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
      return json(summarize(ctx, d.createProject({ name, script, settings: clean })));
    }
  );

  server.registerTool(
    'get_project',
    { title: 'Xem dự án', description: 'Get project status: scenes, characters, rendered file paths.', inputSchema: { projectId: z.string() } },
    async ({ projectId }) => json(summarize(ctx, d.get(projectId)))
  );

  server.registerTool(
    'update_project',
    {
      title: 'Cập nhật dự án',
      description: 'Change script and/or settings (models, skills, resolution, aspect ratio...).',
      inputSchema: { projectId: z.string(), script: z.string().optional(), ...settingsShape }
    },
    async ({ projectId, script, ...settings }) => {
      if (script !== undefined) d.setScript(projectId, script);
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
      return json(summarize(ctx, d.updateSettings(projectId, clean)));
    }
  );

  server.registerTool(
    'analyze_script',
    { title: 'Tách cảnh', description: 'Break the project script into scenes using the text model + active skills.', inputSchema: { projectId: z.string() } },
    async ({ projectId }, extra) => {
      const r = await d.analyze(projectId, progressOf(extra));
      return json({ engine: r.engine, warning: r.warning, ...summarize(ctx, r.project) });
    }
  );

  server.registerTool(
    'auto_cast',
    {
      title: 'Tạo dàn nhân vật',
      description: 'Extract characters from the script, generate reference portraits and bind them to scenes.',
      inputSchema: { projectId: z.string() }
    },
    async ({ projectId }, extra) => {
      const r = await d.cast(projectId, progressOf(extra));
      return json({ warnings: r.warnings, ...summarize(ctx, r.project) });
    }
  );

  server.registerTool(
    'add_character',
    {
      title: 'Thêm nhân vật',
      description: 'Add a character from a local image file, or generate a portrait from a description.',
      inputSchema: {
        projectId: z.string(),
        name: z.string(),
        description: z.string().optional(),
        imagePath: z.string().optional().describe('Absolute path of a PNG/JPG/WEBP portrait'),
        imagePrompt: z.string().optional().describe('English appearance description when generating')
      }
    },
    async ({ projectId, ...args }) => json(summarize(ctx, await d.addCharacter(projectId, args)))
  );

  server.registerTool(
    'update_scene',
    {
      title: 'Sửa cảnh',
      description: 'Edit one scene (prompt, dialogue, duration, camera...).',
      inputSchema: {
        projectId: z.string(),
        sceneNumber: z.number().int(),
        title: z.string().optional(),
        promptDescription: z.string().optional(),
        dialogue: z.string().optional(),
        audioDirection: z.string().optional(),
        durationSeconds: z.number().optional(),
        cameraAngle: z.enum(CAMERA_ANGLES as [string, ...string[]]).optional()
      }
    },
    async ({ projectId, sceneNumber, ...patch }) => {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      return json(summarize(ctx, d.updateScene(projectId, sceneNumber, clean as any)));
    }
  );

  server.registerTool(
    'render_scene',
    {
      title: 'Render một cảnh',
      description: 'Generate the video for one scene with the project video model. May take minutes and cost credits.',
      inputSchema: { projectId: z.string(), sceneNumber: z.number().int() }
    },
    async ({ projectId, sceneNumber }, extra) => {
      const sc = await d.renderScene(projectId, sceneNumber, progressOf(extra), extra.signal);
      return json({
        sceneNumber,
        status: sc.status,
        error: sc.errorMessage,
        video: sc.video ? ctx.media.pathOf(sc.video.file) : undefined,
        voice: sc.voice ? ctx.media.pathOf(sc.voice.audio.file) : undefined,
        render: sc.lastRender
      });
    }
  );

  server.registerTool(
    'voice_scene',
    {
      title: 'Lồng tiếng một cảnh',
      description:
        "Multi-voice TTS for a scene's dialogue (each character gets its own voice, auto-cast by age/gender unless set). Cue times follow the real speech, so merged subtitles match the voice.",
      inputSchema: { projectId: z.string(), sceneNumber: z.number().int() }
    },
    async ({ projectId, sceneNumber }, extra) => {
      const sc = await d.voiceScene(projectId, sceneNumber, progressOf(extra), extra.signal);
      return json({ sceneNumber, voice: sc.voice ? ctx.media.pathOf(sc.voice.audio.file) : undefined, durationSeconds: sc.voice?.durationSeconds, cues: sc.voice?.cues });
    }
  );

  server.registerTool(
    'set_character_voice',
    {
      title: 'Chọn giọng cho nhân vật',
      description: 'Pin a TTS voice (id from list_models → tts[].voices) to a character for the project TTS model.',
      inputSchema: { projectId: z.string(), characterName: z.string(), voiceId: z.string() }
    },
    async ({ projectId, characterName, voiceId }) => {
      const p = d.get(projectId);
      const c = p.characters.find(x => x.name.toLowerCase() === characterName.toLowerCase());
      if (!c) return json({ error: `Không có nhân vật "${characterName}"` });
      c.voice = { model: p.settings.ttsModel || ctx.registry.defaultId('tts'), id: voiceId };
      return json(summarize(ctx, ctx.projects.save(p)));
    }
  );

  server.registerTool(
    'cleanup_media',
    {
      title: 'Dọn file media thừa',
      description: 'Delete generated files (old renders, previews…) that no project references anymore. dryRun only reports.',
      inputSchema: { dryRun: z.boolean().default(true) }
    },
    async ({ dryRun }) => json({ dryRun, ...d.cleanupMedia(dryRun) })
  );

  server.registerTool(
    'render_all',
    {
      title: 'Render tất cả cảnh',
      description: 'Render every scene sequentially (onlyMissing skips completed ones).',
      inputSchema: { projectId: z.string(), onlyMissing: z.boolean().default(true) }
    },
    async ({ projectId, onlyMissing }, extra) => json(summarize(ctx, await d.renderAll(projectId, { onlyMissing }, progressOf(extra), extra.signal)))
  );

  server.registerTool(
    'merge_video',
    {
      title: 'Ghép video',
      description: 'Merge completed scenes into one MP4 (ffmpeg), optionally burning timed subtitles.',
      inputSchema: { projectId: z.string(), burnInSubtitles: z.boolean().optional() }
    },
    async ({ projectId, burnInSubtitles }, extra) => {
      if (burnInSubtitles !== undefined) d.updateSettings(projectId, { burnInSubtitles });
      return json(summarize(ctx, await d.merge(projectId, progressOf(extra), extra.signal)));
    }
  );

  server.registerTool(
    'make_video',
    {
      title: 'Kịch bản → Video (1 bước)',
      description:
        'One-shot pipeline: create project, break script into scenes, auto-cast characters, render all scenes and merge into a single MP4. Returns file paths.',
      inputSchema: { script: z.string(), name: z.string().optional(), ...settingsShape }
    },
    async ({ script, name, ...settings }, extra) => {
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
      const p = d.createProject({ name, script, settings: clean });
      const r = await d.makeVideo(p.id, progressOf(extra), extra.signal);
      return json({ notes: r.notes, ...summarize(ctx, r.project) });
    }
  );

  server.registerResource(
    'skills',
    new ResourceTemplate('skill://{id}', {
      list: async () => ({
        resources: ctx.skills.list().map(s => ({ uri: `skill://${s.id}`, name: s.name, description: s.description, mimeType: 'text/markdown' }))
      })
    }),
    { title: 'Skill Library', description: 'Video style / genre / format skills' },
    async (uri, { id }) => {
      const s = ctx.skills.get(String(id));
      if (!s) throw new Error('Skill not found');
      const { directives, ...meta } = s;
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${directives}` }] };
    }
  );

  return server;
}

export async function runMcpStdio(ctx: AppContext) {
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}
