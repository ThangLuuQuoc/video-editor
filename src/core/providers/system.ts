import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ModelConfig, ProviderConfig } from '../config';
import type { GeneratedMedia } from '../media';
import type { VoiceInfo } from '../types';
import { CanceledError, type Provider, type SpeechRequest } from './base';

function run(cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CanceledError());
    const p = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true });
    const onAbort = () => p.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let out = '';
    let err = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (err += d.toString()));
    p.on('error', e => resolve({ code: -1, out, err: String(e) }));
    p.on('close', code => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) reject(new CanceledError());
      else resolve({ code: code ?? -1, out, err });
    });
  });
}

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * Offline text-to-speech using the operating system's voices — free, no key:
 *  - Windows: System.Speech (SAPI) via PowerShell
 *  - macOS:   `say`
 *  - Linux:   `espeak-ng`
 * Voices are discovered at runtime.
 */
export class SystemTtsProvider implements Provider {
  private voices?: Promise<VoiceInfo[]>;
  private linuxOk?: boolean;

  constructor(readonly name: string, readonly config: ProviderConfig) {}

  unavailableReason() {
    if (process.platform === 'linux') {
      this.linuxOk ??= spawnSync('espeak-ng', ['--version'], { windowsHide: true }).status === 0;
      return this.linuxOk ? undefined : 'Cần cài espeak-ng';
    }
    return ['win32', 'darwin'].includes(process.platform) ? undefined : `Không hỗ trợ ${process.platform}`;
  }

  listVoices(_m?: ModelConfig): Promise<VoiceInfo[]> {
    this.voices ??= this.discover().catch(() => []);
    return this.voices;
  }

  private async discover(): Promise<VoiceInfo[]> {
    if (process.platform === 'win32') {
      const script =
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
        "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $v = $_.VoiceInfo; '{0}|{1}|{2}|{3}' -f $v.Name, $v.Gender, $v.Age, $v.Culture.Name }";
      const r = await run('powershell.exe', [...PS, script]);
      return r.out
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          const [name, gender, age, lang] = line.split('|');
          return {
            id: name,
            label: `${name.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, '')} (${lang})`,
            gender: gender === 'Female' ? 'female' : gender === 'Male' ? 'male' : undefined,
            age: age === 'Child' ? 'child' : age === 'Senior' ? 'elder' : age === 'Teen' ? 'young' : 'adult',
            lang
          } as VoiceInfo;
        });
    }
    if (process.platform === 'darwin') {
      const r = await run('say', ['-v', '?']);
      return r.out
        .split('\n')
        .map(l => l.match(/^(.+?)\s+([a-z]{2}[_-][A-Z]{2})\s+#/))
        .filter(Boolean)
        .map(m => ({ id: m![1].trim(), label: `${m![1].trim()} (${m![2]})`, lang: m![2].replace('_', '-') }));
    }
    return [
      { id: 'en-us', label: 'English (US)', lang: 'en-US', gender: 'male' },
      { id: 'en-us+f3', label: 'English (US) nữ', lang: 'en-US', gender: 'female' },
      { id: 'vi', label: 'Tiếng Việt', lang: 'vi-VN', gender: 'male' },
      { id: 'vi+f3', label: 'Tiếng Việt nữ', lang: 'vi-VN', gender: 'female' }
    ];
  }

  async speech(_m: ModelConfig, req: SpeechRequest): Promise<GeneratedMedia> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivideo-tts-'));
    try {
      // Text goes through a file: no shell quoting issues with quotes / unicode.
      fs.writeFileSync(path.join(dir, 'text.txt'), req.text, 'utf8');
      const speed = req.speed ?? 1;
      let r: { code: number; err: string };
      let out: string;
      if (process.platform === 'win32') {
        out = 'out.wav';
        const rate = Math.max(-10, Math.min(10, Math.round((speed - 1) * 10)));
        const voice = req.voice ? `try { $s.SelectVoice('${req.voice.replace(/'/g, "''")}') } catch {}; ` : '';
        const script =
          'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
          `${voice}$s.Rate = ${rate}; $s.SetOutputToWaveFile((Join-Path (Get-Location) '${out}')); ` +
          "$s.Speak([IO.File]::ReadAllText((Join-Path (Get-Location) 'text.txt'), [Text.Encoding]::UTF8)); $s.Dispose()";
        r = await run('powershell.exe', [...PS, script], { cwd: dir, signal: req.signal });
      } else if (process.platform === 'darwin') {
        out = 'out.aiff';
        const args = ['-o', out, '-f', 'text.txt', '-r', String(Math.round(180 * speed))];
        if (req.voice) args.unshift('-v', req.voice);
        r = await run('say', args, { cwd: dir, signal: req.signal });
      } else {
        out = 'out.wav';
        const args = ['-w', out, '-f', 'text.txt', '-s', String(Math.round(165 * speed))];
        if (req.voice) args.unshift('-v', req.voice);
        r = await run('espeak-ng', args, { cwd: dir, signal: req.signal });
      }
      const file = path.join(dir, out);
      if (r.code !== 0 || !fs.existsSync(file)) throw new Error(`TTS hệ điều hành lỗi: ${r.err.slice(0, 300) || `exit ${r.code}`}`);
      return { data: fs.readFileSync(file), mimeType: out.endsWith('.aiff') ? 'audio/aiff' : 'audio/wav' };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
